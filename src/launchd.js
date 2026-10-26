// @ts-check
// The bridge as a macOS LaunchAgent: ~/Library/LaunchAgents/<label>.plist, started by launchd at
// login and again whenever it exits (KeepAlive).
//
// Every launchctl call names this one service in full (plan R2⑥):
//   bootstrap gui/<uid> <plist>      install
//   bootout gui/<uid>/<label>        remove (then the plist is deleted)
//   print gui/<uid>/<label>          status
//   kill SIGTERM gui/<uid>/<label>   restart (tests)
// A bootout without a service target can take down the user's whole domain: never used.
//
// A bridge the user started by hand is never stopped: install says so and stops; so does a port held by anything else
// (named, when lsof can tell). The plist holds absolute paths only (launchd's PATH is bare) and nothing secret.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as auth from './auth.js';
import { CLI_PATH, nodeBinary } from './install.js';
import { DEFAULT_PORT } from './server.js';

export const LABEL = 'com.k-browser.bridge';

export class ServiceError extends Error {}

/** @typedef {(cmd: string, args: string[]) => { status: number | null, stdout: string, stderr: string }} Run */
/** @type {Run} */
const realRun = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** @typedef {{ kind: 'free' } | { kind: 'bridge', health: Record<string, any> } | { kind: 'other', who: string }} Probe */

/** Who listens on that port, as "<command> (pid N)", or null. @param {number} port @param {Run} run */
export function whoListens(port, run = realRun) {
  const r = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
  const pid = /^p(\d+)$/m.exec(r.stdout)?.[1];
  const cmd = /^c(.+)$/m.exec(r.stdout)?.[1];
  return pid ? `${cmd ?? '?'} (pid ${pid})` : null;
}

/** What is on 127.0.0.1:<port>: nothing, a K-Browser bridge (its /health), or something else. @param {number} port @returns {Promise<Probe>} */
export async function probePort(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    const h = await r.json().catch(() => null);
    if (h && h.ok === true && typeof h.version === 'string' && 'extension' in h) return { kind: /** @type {const} */ ('bridge'), health: h };
  } catch {
    // nothing answered HTTP; something may still hold the port
  }
  const busy = await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
  return busy ? { kind: /** @type {const} */ ('other'), who: whoListens(port) ?? 'another program' } : { kind: /** @type {const} */ ('free') };
}

/** @param {string} s */
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** node: the node binary to write into the plist (default: this one; tests pass another). @typedef {{ label?: string, port?: number, agentsDir?: string, uid?: number, run?: Run, node?: string }} Where */

/** @param {Where} [w] */
function where({ label = LABEL, port = DEFAULT_PORT, agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents'), uid = process.getuid?.() ?? 0, run = realRun } = {}) {
  return { label, port, uid, run, plist: path.join(agentsDir, `${label}.plist`), logDir: path.join(auth.home(), 'logs'), service: `gui/${uid}/${label}` };
}

/** The plist: this node (nodeBinary(), or w.node) and this checkout's cli.js by absolute path, KBROWSER_HOME when it is not the default. @param {Where} [w] */
export function plistFor(w = {}) {
  const { label, port, logDir } = where(w);
  const argv = [w.node ?? nodeBinary(), CLI_PATH, '--port', String(port), 'bridge'];
  const env = process.env.KBROWSER_HOME ? { KBROWSER_HOME: path.resolve(process.env.KBROWSER_HOME) } : {};
  const envXml = Object.keys(env).length === 0 ? '' : `  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>\n`).join('')}  </dict>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>\n`).join('')}  </array>
${envXml}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(path.join(logDir, 'bridge.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(logDir, 'bridge.err.log'))}</string>
</dict>
</plist>
`;
}

/**
 * Is this the command line of K-Browser's bridge from this checkout: <any node> <this cli.js> --port <n> bridge?
 * @param {string[] | null} argv
 */
export const isOurBridge = (argv) => argv !== null && argv.length === 5 && argv[1] === CLI_PATH && argv[2] === '--port'
  && /^\d+$/.test(argv[3]) && argv[4] === 'bridge';

/** A `key = value` line of `launchctl print` (one tab deep: the job's own fields). @param {string} out @param {string} key */
const printed = (out, key) => new RegExp(`^\\t${key} = (.*)$`, 'm').exec(out)?.[1] ?? null;

/** The `arguments = { … }` block of `launchctl print`, one argument per line. @param {string} out */
function printedArgs(out) {
  const m = /^\targuments = \{\n((?:\t\t.*\n)*?)\t\}$/m.exec(out);
  return m ? m[1].split('\n').filter(Boolean).map((l) => l.replace(/^\t\t/, '')) : null;
}

/** ~/.k-browser/service.json: for each label, the plist K-Browser wrote and the SHA-256 of what it wrote. */
const recordFile = () => path.join(auth.home(), 'service.json');

/** @returns {Record<string, { plist: string, sha256: string }>} */
function records() {
  try {
    const r = JSON.parse(fs.readFileSync(recordFile(), 'utf8'));
    return r && typeof r === 'object' ? r : {};
  } catch {
    return {};
  }
}

/** Note (or with null, forget) what K-Browser wrote under a label. @param {string} label @param {{ plist: string, sha256: string } | null} entry */
function noteWritten(label, entry) {
  const r = records();
  if (entry) r[label] = entry;
  else delete r[label];
  auth.writePrivate(recordFile(), JSON.stringify(r, null, 2));
}

/** @param {string} text */
const sha = (text) => createHash('sha256').update(text).digest('hex');

/**
 * The arguments of the plist file, if K-Browser wrote exactly these bytes there (recorded in service.json when it did),
 * or null. Ownership is not read from the file itself: a plist anyone can write, even one shaped exactly like ours with
 * an unrelated program as "node", is not ours. @param {string} text @param {ReturnType<typeof where>} w
 */
function ourPlist(text, w) {
  const rec = records()[w.label];
  if (!rec || !samePath(rec.plist, w.plist) || rec.sha256 !== sha(text)) return null;
  const m = /<key>ProgramArguments<\/key>\s*<array>((?:\s*<string>[^<]*<\/string>)*)\s*<\/array>/.exec(text);
  const un = (/** @type {string} */ v) => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const argv = m ? [...m[1].matchAll(/<string>([^<]*)<\/string>/g)].map((x) => un(x[1])) : null;
  return isOurBridge(argv) ? argv : null;
}

/** The same file (launchd prints the real path: /var is /private/var on macOS)? @param {string | null} a @param {string} b */
function samePath(a, b) {
  try {
    return a !== null && fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

const LOG_MAX = 5 * 1024 * 1024;
const LOG_KEEP = 1024 * 1024;

/**
 * Keep the bridge's logs bounded: a file over 5 MB keeps its last 1 MB as <name>.1 and is emptied in place (launchd
 * holds it open in append mode, so writing goes on from the start). Only a regular file of ours with one link is
 * touched, through a descriptor opened without following links; the backup is a new private file renamed into place,
 * so a link at either name never leads elsewhere (a symlink or hard link at the log or
 * at .1 could make it overwrite or empty another file). @param {string} [dir]
 */
export function rotateLogs(dir = path.join(auth.home(), 'logs')) {
  for (const name of ['bridge.out.log', 'bridge.err.log']) {
    const f = path.join(dir, name);
    const st = fs.lstatSync(f, { throwIfNoEntry: false });
    if (!st || !st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || st.size <= LOG_MAX) continue;
    /** @type {number | null} */ let fd = null;
    const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
    let made = false;
    try {
      fd = fs.openSync(f, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
      const fst = fs.fstatSync(fd);
      if (fst.ino !== st.ino || fst.dev !== st.dev || !fst.isFile() || fst.nlink !== 1) continue;
      const tail = Buffer.alloc(LOG_KEEP);
      const n = fs.readSync(fd, tail, 0, LOG_KEEP, Math.max(0, fst.size - LOG_KEEP));
      fs.writeFileSync(tmp, tail.subarray(0, n), { mode: 0o600, flag: 'wx' });
      made = true;
      fs.renameSync(tmp, `${f}.1`);
      made = false;
      fs.ftruncateSync(fd, 0);
    } catch {
      // a log that cannot be rotated safely is left as it is; the backup we made (and only that) is removed, so the
      // next rotation can try again
      if (made) fs.rmSync(tmp, { force: true });
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
}

/**
 * Is the service loaded in launchd, its pid if running, and are the plist file and the loaded job ours? The plist is ours
 * when it is exactly what K-Browser writes; the loaded job, when launchd loaded it from that file and runs exactly its
 * program and arguments. Anything K-Browser cannot prove is left alone.
 * @param {Where} [w]
 */
export function serviceStatus(w = {}) {
  const { run, service, plist } = where(w);
  const r = run('launchctl', ['print', service]);
  const loaded = r.status === 0;
  const pid = loaded ? Number(/^\s*pid = (\d+)$/m.exec(r.stdout)?.[1] ?? NaN) : NaN;
  const file = fs.existsSync(plist) ? plist : null;
  const argv = file ? ourPlist(fs.readFileSync(file, 'utf8'), where(w)) : null;
  const jobOurs = loaded && argv !== null && samePath(printed(r.stdout, 'path'), plist) && printed(r.stdout, 'program') === argv[0]
    && JSON.stringify(printedArgs(r.stdout)) === JSON.stringify(argv);
  return { loaded, pid: Number.isFinite(pid) ? pid : null, plist: file, jobOurs, plistOurs: argv !== null };
}

/** Stop unless every piece under our label that exists is ours. @param {ReturnType<typeof where>} w @param {ReturnType<typeof serviceStatus>} st */
function mustBeOurs(w, st) {
  if (st.loaded && !st.jobOurs) {
    throw new ServiceError(`bridge: launchd already has a job ${w.label} that does not run this K-Browser's bridge; left alone. `
      + `Look at \`launchctl print ${w.service}\` (it may be an install from another checkout)`);
  }
  if (st.plist && !st.plistOurs) {
    // an install whose record (~/.k-browser/service.json) is gone is refused too: K-Browser cannot tell it from someone
    // else's file, so taking it over is the user's call, by hand
    throw new ServiceError(`bridge: ${st.plist} is not this K-Browser's bridge plist (or its record in ${recordFile()} is gone); left alone. `
      + `If it is an older K-Browser install, remove it yourself: \`launchctl bootout ${w.service}\` and delete ${st.plist}, then \`k-browser service install\``);
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Install (or refresh) the LaunchAgent and wait until its bridge answers. Repeating it with nothing changed does nothing.
 * @param {Where & { dryRun?: boolean, say?: (s: string) => void, probe?: (port: number) => Promise<Probe>, waitMs?: number }} [o]
 */
export async function serviceInstall(o = {}) {
  const { dryRun = false, say = (s) => console.log(s), probe = probePort, waitMs = 20000 } = o;
  const w = where(o);
  const want = plistFor(o);
  const st = serviceStatus(o);
  mustBeOurs(w, st);
  const have = st.plist ? fs.readFileSync(st.plist, 'utf8') : null;
  const p = await probe(w.port);
  const ours = p.kind === 'bridge' && st.loaded && st.pid !== null && p.health.pid === st.pid;
  if (ours && have === want) {
    say(`bridge: LaunchAgent ${w.label} already installed and running (pid ${st.pid}); nothing to do`);
    return { ok: true, changed: false };
  }
  if (p.kind === 'bridge' && !ours) {
    throw new ServiceError(`bridge: a K-Browser bridge you started yourself (pid ${p.health.pid ?? '?'}) is running on port ${w.port}; `
      + 'stop it (Ctrl-C in its terminal), then run this again. K-Browser does not stop it for you.');
  }
  if (p.kind === 'other') {
    throw new ServiceError(`bridge: port ${w.port} is in use by ${p.who}; free it (or use --port), then run this again`);
  }
  /** @type {string[][]} */ const steps = [];
  if (st.loaded) steps.push(['bootout', w.service]);
  steps.push(['bootstrap', `gui/${w.uid}`, w.plist]);
  say(`bridge: write ${w.plist}${have === null ? '' : ' (replacing the old one)'}`);
  for (const s of steps) say(`bridge: launchctl ${s.join(' ')}`);
  if (dryRun) return { ok: true, changed: false };

  if (st.loaded) {
    launchctl(w, steps[0]);
    await waitFree(w.port, probe, 10000);
  }
  fs.mkdirSync(path.dirname(w.plist), { recursive: true });
  fs.mkdirSync(w.logDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(w.plist, want, { mode: 0o644 });
  noteWritten(w.label, { plist: w.plist, sha256: sha(want) });
  launchctl(w, steps[steps.length - 1]);
  const up = await waitUp(o, probe, waitMs);
  if (!up) throw new ServiceError(`bridge: LaunchAgent loaded but the bridge did not answer on port ${w.port}; see ${path.join(w.logDir, 'bridge.err.log')}`);
  say(`bridge: running under launchd (pid ${up}); logs in ${w.logDir}`);
  return { ok: true, changed: true };
}

/**
 * Remove the LaunchAgent: bootout this one service, wait until launchd no longer lists it (bootout returns while the job
 * is still stopping), then delete its plist.
 * @param {Where & { dryRun?: boolean, say?: (s: string) => void, waitMs?: number }} [o]
 */
export async function serviceUninstall(o = {}) {
  const { dryRun = false, say = (s) => console.log(s) } = o;
  const w = where(o);
  const st = serviceStatus(o);
  if (!st.loaded && !st.plist) {
    say(`bridge: no LaunchAgent ${w.label}; nothing to do`);
    return { ok: true };
  }
  mustBeOurs(w, st);
  if (st.loaded) say(`bridge: launchctl bootout ${w.service}`);
  if (st.plist) say(`bridge: delete ${st.plist}`);
  if (dryRun) return { ok: true };
  if (st.loaded) {
    launchctl(w, ['bootout', w.service]);
    for (const end = Date.now() + (o.waitMs ?? 10000); serviceStatus(o).loaded; await sleep(200)) {
      if (Date.now() > end) throw new ServiceError(`bridge: launchd still lists ${w.label} after bootout; check \`launchctl print ${w.service}\``);
    }
  }
  if (st.plist) fs.rmSync(st.plist, { force: true });
  noteWritten(w.label, null);
  return { ok: true };
}

/** Make launchd stop the bridge (it starts it again: KeepAlive). @param {Where & { dryRun?: boolean, say?: (s: string) => void }} [o] */
export function serviceRestart(o = {}) {
  const { dryRun = false, say = (s) => console.log(s) } = o;
  const w = where(o);
  const st = serviceStatus(o);
  if (!st.loaded) throw new ServiceError(`bridge: no LaunchAgent ${w.label} is loaded; \`k-browser service install\` first`);
  mustBeOurs(w, st);
  say(`bridge: launchctl kill SIGTERM ${w.service} (launchd starts it again)`);
  if (!dryRun) launchctl(w, ['kill', 'SIGTERM', w.service]);
}

/** @param {ReturnType<typeof where>} w @param {string[]} args */
function launchctl(w, args) {
  const r = w.run('launchctl', args);
  if (r.status !== 0) throw new ServiceError(`bridge: \`launchctl ${args.join(' ')}\` failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
}

/** @param {number} port @param {(port: number) => Promise<Probe>} probe @param {number} ms */
async function waitFree(port, probe, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if ((await probe(port)).kind === 'free') return;
}

/** The pid of the launchd-run bridge once it answers, or null. @param {Where} o @param {(port: number) => Promise<Probe>} probe @param {number} ms */
async function waitUp(o, probe, ms) {
  const { port } = where(o);
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const st = serviceStatus(o);
    const p = await probe(port);
    if (st.pid !== null && p.kind === 'bridge' && p.health.pid === st.pid) return st.pid;
  }
  return null;
}
