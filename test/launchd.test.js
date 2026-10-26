// @ts-check
// The bridge's LaunchAgent: every launchctl call names this one service in full, a bridge started by hand
// or another program on the port is never stopped, and repeating install changes nothing. launchctl and the port are
// faked here; test/integration/launchd.test.js runs the real launchd.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import * as auth from '../src/auth.js';
import { CLI_PATH, nodeBinary } from '../src/install.js';
import { LABEL, plistFor, rotateLogs, serviceInstall, ServiceError, serviceRestart, serviceUninstall } from '../src/launchd.js';

const UID = 501;
const PAIR = 'p'.repeat(43);
/** @type {string} */ let home;
/** @type {string} */ let agentsDir;
const saved = { home: process.env.HOME, kb: process.env.KBROWSER_HOME };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-launchd-'));
  agentsDir = path.join(home, 'Library', 'LaunchAgents');
  process.env.HOME = home;
  process.env.KBROWSER_HOME = path.join(home, '.k-browser');
  fs.mkdirSync(process.env.KBROWSER_HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(process.env.KBROWSER_HOME, 'pair.key'), PAIR, { mode: 0o600 });
});
afterEach(() => {
  process.env.HOME = saved.home;
  process.env.KBROWSER_HOME = saved.kb;
  fs.rmSync(home, { recursive: true, force: true });
});

/** The ProgramArguments strings of a plist. @param {string} file */
const argvOf = (file) => [...(/<array>([\s\S]*?)<\/array>/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);

/**
 * A launchd with one job, and what is on the port. job: a job already loaded under our label, running that argv.
 * @param {{ manual?: number, other?: string, job?: string[] }} [o]
 */
function fakeLaunchd({ manual, other, job } = {}) {
  const st = { loaded: Boolean(job), pid: job ? 100 : 0, nextPid: 4242, argv: job ?? /** @type {string[]} */ ([]), path: job ? plist() : '' };
  /** @type {string[][]} */ const calls = [];
  /** @type {import('../src/launchd.js').Run} */
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== 'launchctl') return { status: 1, stdout: '', stderr: '' };
    switch (args[0]) {
      // the shape of the real `launchctl print` (macOS 27): tab-indented, one argument per line
      case 'print': return st.loaded ? { status: 0, stdout: `${args[1]} = {\n\tpath = ${st.path}\n\tstate = running\n\n\tprogram = ${st.argv[0]}\n\targuments = {\n${
        st.argv.map((a) => `\t\t${a}\n`).join('')}\t}\n\n\tpid = ${st.pid}\n}\n`, stderr: '' }
        : { status: 113, stdout: '', stderr: `Could not find service "${LABEL}"` };
      case 'bootstrap': Object.assign(st, { loaded: true, pid: st.nextPid++, argv: argvOf(args[2]), path: args[2] }); return { status: 0, stdout: '', stderr: '' };
      case 'bootout': Object.assign(st, { loaded: false, pid: 0 }); return { status: 0, stdout: '', stderr: '' };
      case 'kill': st.pid = st.nextPid++; return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 2, stdout: '', stderr: 'unexpected' };
  };
  /** @returns {Promise<import('../src/launchd.js').Probe>} */
  const probe = async () => {
    if (other) return { kind: 'other', who: other };
    if (manual) return { kind: 'bridge', health: { ok: true, version: '0.1.0', extension: false, pid: manual } };
    return st.loaded && st.argv.includes(CLI_PATH) ? { kind: 'bridge', health: { ok: true, version: '0.1.0', extension: false, pid: st.pid } } : { kind: 'free' };
  };
  /** @type {string[]} */ const said = [];
  const o = { uid: UID, agentsDir, run, probe, waitMs: 2000, say: (/** @type {string} */ s) => said.push(s) };
  return { st, calls, o, said, launchctl: () => calls.filter((c) => c[0] === 'launchctl').map((c) => c.slice(1)) };
}

const SERVICE = `gui/${UID}/${LABEL}`;
const plist = () => path.join(agentsDir, `${LABEL}.plist`);

/** Every call names this one service: `<verb> gui/<uid>/<label>`, or `bootstrap gui/<uid> <our plist>`. @param {string[][]} calls */
function onlyOurs(calls) {
  for (const c of calls) {
    if (c[0] === 'bootstrap') assert.deepEqual(c, ['bootstrap', `gui/${UID}`, plist()]);
    else if (c[0] === 'kill') assert.deepEqual(c, ['kill', 'SIGTERM', SERVICE]);
    else assert.deepEqual(c, [c[0], SERVICE], `full service target: ${c.join(' ')}`);
  }
}

test('install: plist with absolute paths and nothing secret, bootstrap gui/<uid> <plist>, waits until it answers', async () => {
  const token = auth.addClient('codex');
  const f = fakeLaunchd();
  const r = await serviceInstall(f.o);
  assert.equal(r.ok, true);
  assert.deepEqual(f.launchctl().filter((c) => c[0] !== 'print'), [['bootstrap', `gui/${UID}`, plist()]]);
  onlyOurs(f.launchctl());
  const xml = fs.readFileSync(plist(), 'utf8');
  for (const s of [nodeBinary(), CLI_PATH, '<string>bridge</string>', '<key>KeepAlive</key>\n  <true/>', '<key>RunAtLoad</key>\n  <true/>',
    `<string>${process.env.KBROWSER_HOME}</string>`, path.join(/** @type {string} */ (process.env.KBROWSER_HOME), 'logs', 'bridge.err.log')]) {
    assert.ok(xml.includes(s), s);
  }
  assert.ok(path.isAbsolute(nodeBinary()) && path.isAbsolute(CLI_PATH));
  assert.ok(!xml.includes(PAIR) && !xml.includes(token), 'no pairing key or client token in the plist');
  assert.equal(fs.statSync(path.join(/** @type {string} */ (process.env.KBROWSER_HOME), 'logs')).mode & 0o777, 0o700);
  assert.match(f.said.join('\n'), /running under launchd \(pid 4242\)/);
});

test('install again with nothing changed: no launchctl change; with a changed plist: bootout gui/<uid>/<label>, then bootstrap', async () => {
  const f = fakeLaunchd();
  await serviceInstall(f.o);
  f.calls.length = 0;
  const again = await serviceInstall(f.o);
  assert.equal(again.changed, false);
  assert.deepEqual(f.launchctl().map((c) => c[0]).filter((v) => v !== 'print'), []);
  await serviceInstall({ ...f.o, node: '/old/node/bin/node' }); // an install made with a node since upgraded
  f.calls.length = 0;
  const changed = await serviceInstall(f.o);
  assert.equal(changed.changed, true);
  assert.deepEqual(f.launchctl().filter((c) => c[0] !== 'print'), [['bootout', SERVICE], ['bootstrap', `gui/${UID}`, plist()]]);
  onlyOurs(f.launchctl());
  assert.equal(fs.readFileSync(plist(), 'utf8'), plistFor(f.o));
});

test('a bridge started by hand, or another program on the port: install stops, kills nothing, writes nothing', async () => {
  for (const [f, re] of /** @type {const} */ ([[fakeLaunchd({ manual: 999 }), /started yourself \(pid 999\).*stop it/], [fakeLaunchd({ other: 'nginx (pid 77)' }), /in use by nginx \(pid 77\)/]])) {
    await assert.rejects(serviceInstall(f.o), (e) => e instanceof ServiceError && re.test(e.message));
    assert.deepEqual(f.launchctl().filter((c) => c[0] !== 'print'), [], 'no bootstrap, no bootout, no kill');
    assert.ok(!fs.existsSync(plist()));
  }
});

test('--dry-run says the steps and changes nothing', async () => {
  const f = fakeLaunchd();
  await serviceInstall({ ...f.o, dryRun: true });
  assert.ok(!fs.existsSync(plist()));
  assert.deepEqual(f.launchctl().filter((c) => c[0] !== 'print'), []);
  assert.match(f.said.join('\n'), new RegExp(`launchctl bootstrap gui/${UID} `));
});

test('uninstall: bootout gui/<uid>/<label> and delete the plist; restart is kill SIGTERM gui/<uid>/<label>', async () => {
  const f = fakeLaunchd();
  await serviceInstall(f.o);
  serviceRestart(f.o);
  assert.equal(f.st.pid, 4243);
  f.calls.length = 0;
  await serviceUninstall(f.o);
  assert.deepEqual(f.launchctl().filter((c) => c[0] !== 'print'), [['bootout', SERVICE]]);
  assert.ok(!fs.existsSync(plist()) && !f.st.loaded);
  f.calls.length = 0;
  await serviceUninstall(f.o);
  assert.deepEqual(f.launchctl().filter((c) => c[0] !== 'print'), [], 'nothing installed: nothing to do');
  assert.match(f.said.join('\n'), /nothing to do/);
});

test('every launchctl call across install, reinstall, restart and uninstall names only our service', async () => {
  const f = fakeLaunchd();
  await serviceInstall(f.o);
  await serviceInstall({ ...f.o, node: '/old/node/bin/node' });
  await serviceInstall(f.o);
  serviceRestart(f.o);
  await serviceUninstall(f.o);
  onlyOurs(f.launchctl());
  assert.ok(f.launchctl().every((c) => !(c[0] === 'bootout' && c[1] === `gui/${UID}`)), 'never a domain-wide bootout');
});

test('a job or plist under our label that does not run this bridge: install, uninstall and restart leave it alone', async () => {
  for (const job of [['/bin/sleep', '600'], ['/usr/bin/node', '/elsewhere/k-browser/src/cli.js', '--port', '9444', 'bridge'],
    ['/usr/bin/node', CLI_PATH, '--port', '9444', 'bridge', '--extra']]) {
    const f = fakeLaunchd({ job });
    await assert.rejects(serviceInstall(f.o), (e) => e instanceof ServiceError && /does not run this K-Browser's bridge; left alone/.test(e.message));
    await assert.rejects(serviceUninstall(f.o), ServiceError);
    assert.throws(() => serviceRestart(f.o), ServiceError);
    assert.deepEqual(f.launchctl().filter((c) => c[0] !== 'print'), [], `no bootout, no kill: ${job.join(' ')}`);
    assert.ok(f.st.loaded && f.st.pid === 100 && !fs.existsSync(plist()));
  }
  // a plist with our arguments but a Program that runs something else, or any other extra key, loaded from that file
  for (const extra of ['  <key>Program</key>\n  <string>/bin/sleep</string>\n', '  <key>UserName</key>\n  <string>root</string>\n']) {
    fs.mkdirSync(agentsDir, { recursive: true });
    const text = plistFor({ uid: UID, agentsDir }).replace('  <key>ProgramArguments</key>', `${extra}  <key>ProgramArguments</key>`);
    fs.writeFileSync(plist(), text);
    const f = fakeLaunchd({ job: argvOf(plist()) });
    await assert.rejects(serviceInstall(f.o), /left alone/);
    await assert.rejects(serviceUninstall(f.o), /left alone/);
    assert.throws(() => serviceRestart(f.o), /left alone/);
    assert.equal(fs.readFileSync(plist(), 'utf8'), text, 'untouched');
    assert.deepEqual(f.launchctl().filter((c) => c[0] !== 'print'), []);
    fs.rmSync(plist());
  }
  // exactly what K-Browser would write, with an unrelated program as "node" — but not written by K-Browser
  fs.mkdirSync(agentsDir, { recursive: true });
  const lookalike = plistFor({ uid: UID, agentsDir, node: '/tmp/not-node.sh' });
  fs.writeFileSync(plist(), lookalike);
  const g = fakeLaunchd({ job: argvOf(plist()) });
  await assert.rejects(serviceInstall(g.o), /left alone/);
  await assert.rejects(serviceUninstall(g.o), /left alone/);
  assert.throws(() => serviceRestart(g.o), /left alone/);
  assert.equal(fs.readFileSync(plist(), 'utf8'), lookalike);
  assert.deepEqual(g.launchctl().filter((c) => c[0] !== 'print'), []);
  fs.rmSync(plist());
  // a plist file there that is not ours, not loaded
  fs.mkdirSync(agentsDir, { recursive: true });
  const theirs = plistFor({ uid: UID, agentsDir }).replace(CLI_PATH, '/elsewhere/cli.js');
  fs.writeFileSync(plist(), theirs);
  const f = fakeLaunchd();
  await assert.rejects(serviceInstall(f.o), /is not this K-Browser's bridge plist .*left alone\. If it is an older K-Browser install, remove it yourself/);
  await assert.rejects(serviceUninstall(f.o), /left alone/);
  assert.equal(fs.readFileSync(plist(), 'utf8'), theirs);
  assert.deepEqual(f.launchctl().filter((c) => c[0] !== 'print'), []);
});

test('restart --dry-run sends nothing', async () => {
  const f = fakeLaunchd();
  await serviceInstall(f.o);
  f.calls.length = 0;
  serviceRestart({ ...f.o, dryRun: true });
  assert.deepEqual(f.launchctl().filter((c) => c[0] !== 'print'), []);
  assert.match(f.said.join('\n'), /kill SIGTERM/);
});

test('what K-Browser wrote is recorded (0600) and forgotten on uninstall; a plist changed afterwards is not ours any more', async () => {
  const f = fakeLaunchd();
  await serviceInstall(f.o);
  const rec = path.join(/** @type {string} */ (process.env.KBROWSER_HOME), 'service.json');
  assert.equal(fs.statSync(rec).mode & 0o777, 0o600);
  assert.ok(JSON.parse(fs.readFileSync(rec, 'utf8'))[LABEL].sha256);
  fs.appendFileSync(plist(), '<!-- edited -->\n');
  await assert.rejects(serviceUninstall(f.o), /left alone/);
  fs.writeFileSync(plist(), plistFor(f.o));
  await serviceUninstall(f.o);
  assert.equal(JSON.parse(fs.readFileSync(rec, 'utf8'))[LABEL], undefined);
});

test('logs over 5 MB keep their last 1 MB as .1 and are emptied in place (launchd keeps appending)', () => {
  const dir = path.join(/** @type {string} */ (process.env.KBROWSER_HOME), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'bridge.err.log');
  const fd = fs.openSync(f, 'a');
  fs.writeSync(fd, Buffer.alloc(6 * 1024 * 1024, 'a'));
  fs.writeSync(fd, 'LAST LINE\n');
  rotateLogs(dir);
  assert.equal(fs.statSync(f).size, 0);
  assert.equal(fs.statSync(`${f}.1`).size, 1024 * 1024);
  assert.ok(fs.readFileSync(`${f}.1`, 'utf8').endsWith('LAST LINE\n'));
  fs.writeSync(fd, 'after\n'); // the writer that held it open goes on
  fs.closeSync(fd);
  assert.equal(fs.readFileSync(f, 'utf8'), 'after\n');
  fs.writeFileSync(path.join(dir, 'bridge.out.log'), 'small');
  rotateLogs(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'bridge.out.log'), 'utf8'), 'small', 'small files are left alone');
});

test('log rotation never follows a link: a symlink or hard link at the log or at .1 leaves the other file alone', () => {
  const dir = path.join(/** @type {string} */ (process.env.KBROWSER_HOME), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'bridge.err.log');
  const other = path.join(/** @type {string} */ (process.env.KBROWSER_HOME), 'other.txt');
  const big = () => fs.writeFileSync(f, Buffer.concat([Buffer.alloc(6 * 1024 * 1024, 'a'), Buffer.from('SECRET_TAIL\n')]), { mode: 0o600 });
  for (const kind of ['symlink', 'hardlink']) {
    // at .1: the backup replaces the link itself, the file it pointed to is untouched
    fs.writeFileSync(other, 'keep me', { mode: 0o644 });
    big();
    fs.rmSync(`${f}.1`, { force: true });
    if (kind === 'symlink') fs.symlinkSync(other, `${f}.1`); else fs.linkSync(other, `${f}.1`);
    rotateLogs(dir);
    assert.equal(fs.readFileSync(other, 'utf8'), 'keep me', `${kind} at .1`);
    assert.ok(fs.lstatSync(`${f}.1`).isFile() && fs.statSync(`${f}.1`).mode % 0o1000 === 0o600 && fs.readFileSync(`${f}.1`, 'utf8').endsWith('SECRET_TAIL\n'));
    // at the log itself: not rotated at all
    fs.rmSync(f);
    fs.writeFileSync(other, Buffer.alloc(6 * 1024 * 1024, 'b'), { mode: 0o644 });
    if (kind === 'symlink') fs.symlinkSync(other, f); else fs.linkSync(other, f);
    rotateLogs(dir);
    assert.equal(fs.statSync(other).size, 6 * 1024 * 1024, `${kind} at the log: the other file is not emptied`);
    fs.rmSync(f);
  }
});

test('a rotation that fails leaves no temporary file behind, so the next one works', () => {
  const dir = path.join(/** @type {string} */ (process.env.KBROWSER_HOME), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'bridge.out.log');
  fs.writeFileSync(f, Buffer.alloc(6 * 1024 * 1024, 'a'), { mode: 0o600 });
  fs.mkdirSync(`${f}.1`); // rename onto a directory fails
  rotateLogs(dir);
  assert.equal(fs.statSync(f).size, 6 * 1024 * 1024, 'not emptied when the backup failed');
  assert.deepEqual(fs.readdirSync(dir).filter((x) => x.endsWith('.tmp')), []);
  fs.rmdirSync(`${f}.1`);
  rotateLogs(dir);
  assert.equal(fs.statSync(f).size, 0);
});
