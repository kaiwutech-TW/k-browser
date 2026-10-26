// @ts-check
// `k-browser install` / `uninstall` / `restore`: register `k-browser mcp --client <name>` with each agent.
//
//   claude-code, codex   through their own CLIs (`claude mcp add --scope user`, `codex mcp add`)
//   antigravity          ~/.gemini/config/mcp_config.json  (mcpServers)
//   gemini-cli           ~/.gemini/settings.json           (mcpServers)
//
// Each agent gets its own client token (`client add <name>`); its configuration holds only the absolute command line,
// never a token. Only the entry named "k-browser" that is provably ours — exactly this checkout's cli.js with
// `mcp --client <name>` — is ever replaced or removed; anything else of that name, or anything K-Browser cannot read
// for sure, is left alone and reported.
//
// Writing someone else's JSON file:
//   - one install / uninstall at a time (~/.k-browser/install.lock);
//   - read, change, then read again right before writing: if the file changed meanwhile, stop and say so (nothing is
//     written). An outside change between that last read and the rename can still be lost: detection is best effort;
//   - invalid JSON, a file that is not UTF-8, or a symbolic link: stop, untouched; the write is atomic (temporary file
//     + rename) and keeps the file's mode;
//   - the original is backed up first, byte for byte (other servers' credentials included), in ~/.k-browser/backups
//     (directory 0700, files 0600), and never printed: `k-browser restore <backup>` puts it back — only if the file is
//     still what K-Browser wrote; a later change by anyone is not thrown away without --force.
// What is printed (steps, the diff in --dry-run, errors) shows only K-Browser's own entry, and goes through the
// redactor: other servers' entries, which may hold API keys, are never shown.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.js';
import { redactor } from './redact.js';
import { patternsFor } from './sites.js';

export const ENTRY = 'k-browser';
export const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url));

/**
 * `parse` reads what `<cmd> mcp get` printed into { command, args }, or null when it cannot tell.
 * @typedef {{ kind: 'cli', cmd: string, get: string[], parse: (stdout: string) => { command: string, args: string[] } | null,
 *   add: (argv: string[]) => string[], remove: string[] } | { kind: 'json', file: () => string }} ClientSpec
 */
/** @type {Record<string, ClientSpec>} */
export const CLIENTS = {
  'claude-code': { kind: 'cli', cmd: 'claude', get: ['mcp', 'get', ENTRY], parse: parseClaude,
    add: (argv) => ['mcp', 'add', '--scope', 'user', ENTRY, '--', ...argv], remove: ['mcp', 'remove', '--scope', 'user', ENTRY] },
  codex: { kind: 'cli', cmd: 'codex', get: ['mcp', 'get', ENTRY, '--json'], parse: parseCodex,
    add: (argv) => ['mcp', 'add', ENTRY, '--', ...argv], remove: ['mcp', 'remove', ENTRY] },
  antigravity: { kind: 'json', file: () => path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json') },
  'gemini-cli': { kind: 'json', file: () => path.join(os.homedir(), '.gemini', 'settings.json') },
};

export class InstallError extends Error {}

/**
 * The node to write into a configuration: a stable link (/opt/homebrew/bin/node, /usr/local/bin/node) when it is this
 * very binary — Homebrew's own path has the version in it and is gone after `brew upgrade node` — else this one.
 */
export function nodeBinary() {
  for (const link of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    try {
      if (fs.realpathSync(link) === fs.realpathSync(process.execPath)) return link;
    } catch {
      // no such link
    }
  }
  return process.execPath;
}

/** The command line an agent runs: absolute paths only. @param {string} name */
export const commandFor = (name) => ({ command: nodeBinary(), args: [CLI_PATH, 'mcp', '--client', name] });

/**
 * The fields, besides command and args, that an entry exactly as K-Browser adds it may show, with the one value each may
 * have: what `codex mcp get --json` prints for a fresh `codex mcp add` (codex-cli 0.163.0). Anything else must be null
 * or absent. An empty list is not "nothing": `enabled_tools: []` allows no tool at all.
 */
const NEUTRAL = { type: 'stdio', enabled: true, env_vars: '[]' };

/**
 * Is this entry K-Browser's for that client? Only exactly this checkout's cli.js with `mcp --client <name>` and nothing
 * else: every other field must be null / absent or the NEUTRAL value, or the entry carries someone's settings that a
 * remove + add would throw away. The node binary may differ (node was
 * upgraded), nothing more. An install from another path is not recognised: K-Browser stops rather than guess.
 * @param {any} e @param {string} name
 */
export function isOurs(e, name) {
  if (!e || typeof e !== 'object' || typeof e.command !== 'string' || !Array.isArray(e.args)) return false;
  if (JSON.stringify(e.args) !== JSON.stringify([CLI_PATH, 'mcp', '--client', name])) return false;
  return Object.entries(e).every(([k, v]) => k === 'command' || k === 'args' || v === null || v === undefined
    || (Object.hasOwn(NEUTRAL, k) && (k === 'env_vars' ? JSON.stringify(v) === NEUTRAL.env_vars : v === NEUTRAL[/** @type {keyof NEUTRAL} */ (k)])));
}

/** `claude mcp get` prints "Command: …" and "Args: …" lines (args joined by spaces). @param {string} out */
function parseClaude(out) {
  const command = /^[ \t]*Command:[ \t]*(.+?)[ \t]*$/m.exec(out)?.[1];
  const args = /^[ \t]*Args:[ \t]*(.*?)[ \t]*$/m.exec(out)?.[1];
  if (command === undefined || args === undefined) return null;
  // environment variables, if any, are listed on the lines under "Environment:" (ours has none)
  const lines = out.split('\n');
  const at = lines.findIndex((l) => /^\s*Environment:/.test(l));
  if (at >= 0 && (/^\s*Environment:[ \t]*\S/.test(lines[at]) || /^\s+\S+=/.test(lines[at + 1] ?? ''))) return null;
  return { command, args: args ? args.split(' ') : [] };
}

/**
 * `codex mcp get --json`: { name, enabled, transport: { type, command, args, env, env_vars, cwd }, enabled_tools, … }.
 * Everything but the name is handed to isOurs, transport fields flattened, so any setting it carries is seen.
 * @param {string} out
 */
function parseCodex(out) {
  try {
    const { name, transport: t, ...rest } = JSON.parse(out) ?? {};
    if (!t || typeof t !== 'object' || t.type !== 'stdio' || typeof t.command !== 'string' || !Array.isArray(t.args)) return null;
    if (Object.keys(rest).some((k) => k in t)) return null;
    return { ...rest, ...t };
  } catch {
    return null;
  }
}

/** @typedef {(cmd: string, args: string[]) => { status: number | null, stdout: string, stderr: string, missing?: boolean }} Run */
/** @type {Run} */
const realRun = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000 });
  const missing = /** @type {any} */ (r.error)?.code === 'ENOENT';
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', missing };
};

// ---------- the lock ----------

/** Run fn while holding ~/.k-browser/install.lock. A lock left by a process that is gone is taken over.
 * @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
export async function withLock(fn) {
  const file = path.join(auth.home(), 'install.lock');
  fs.mkdirSync(auth.home(), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'EEXIST' || attempt > 0) throw e;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      let alive = false;
      try { alive = Number.isInteger(pid) && pid > 0 && (process.kill(pid, 0), true); } catch { alive = false; }
      if (alive) throw new InstallError(`another k-browser install or uninstall is running (pid ${pid}); try again when it is done`);
      fs.rmSync(file, { force: true }); // left by a process that is gone
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// ---------- backups ----------

/** Keep the file's original bytes (or that it did not exist), to put back with restore(). Never printed.
 * @param {string} client @param {string} target @param {Buffer | null} original */
function backup(client, target, original) {
  const dir = path.join(auth.home(), 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const stamp = `${client}-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const meta = { target, existed: original !== null, ...(original ? { mode: fs.statSync(target).mode & 0o777 } : {}) };
  if (original) fs.writeFileSync(path.join(dir, `${stamp}.bak`), original, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify(meta), { mode: 0o600 });
  return path.join(dir, `${stamp}.json`);
}

/** Note in a backup what K-Browser wrote, so restore can tell whether anyone changed the file since. @param {string} metaFile @param {Buffer | string} written */
function noteWritten(metaFile, written) {
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, written: sha(written) }), { mode: 0o600 });
}

/** @param {Buffer | string} b */
const sha = (b) => createHash('sha256').update(b).digest('hex');

/**
 * Put a backed-up file back as it was, byte for byte (or remove it, if it did not exist) — only if it is still exactly
 * what K-Browser wrote: anything changed since (a server the user added) would be lost, so that needs `force`.
 * @param {string} metaFile @param {{ force?: boolean }} [o]
 */
export function restore(metaFile, { force = false } = {}) {
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  if (!meta || typeof meta.target !== 'string') throw new InstallError('not a K-Browser backup');
  if (typeof meta.written !== 'string') throw new InstallError(`K-Browser did not finish writing ${meta.target} with this backup: nothing to restore`);
  const now = fs.existsSync(meta.target) ? sha(fs.readFileSync(meta.target)) : null;
  if (now !== meta.written && !force) {
    throw new InstallError(`${meta.target} changed after K-Browser wrote it; restoring would throw those changes away. `
      + 'Look at it first; to restore anyway: k-browser restore --force <backup>');
  }
  if (!meta.existed) {
    fs.rmSync(meta.target, { force: true });
    return meta.target;
  }
  const bytes = fs.readFileSync(metaFile.replace(/\.json$/, '.bak'));
  atomicWrite(meta.target, bytes, meta.mode ?? 0o600);
  return meta.target;
}

/** @param {string} file @param {Buffer | string} data @param {number} mode */
function atomicWrite(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.k-browser-${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

// ---------- one client ----------

/**
 * Add (or with remove, take away) our entry in a JSON file's mcpServers.
 * @param {{ client: string, file: string, remove: boolean, dryRun: boolean, say: (s: string) => void, beforeWrite?: () => void | Promise<void> }} o
 */
async function editJson({ client, file, remove, dryRun, say, beforeWrite }) {
  // lstat, not existsSync: a link to a file that does not exist yet is still a link
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new InstallError(`${file} is a symbolic link: left untouched (K-Browser would replace the link with a file); add the entry to its target yourself`);
  }
  const original = fs.existsSync(file) ? fs.readFileSync(file) : null;
  /** @type {any} */ let data = {};
  const text = original?.toString('utf8') ?? '';
  if (original && !Buffer.from(text, 'utf8').equals(original)) throw new InstallError(`${file} is not UTF-8: left untouched`);
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new InstallError(`${file} is not valid JSON: left untouched`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new InstallError(`${file} is not a JSON object: left untouched`);
  }
  const servers = data.mcpServers ?? {};
  if (typeof servers !== 'object' || Array.isArray(servers)) throw new InstallError(`${file}: mcpServers is not an object: left untouched`);
  const current = servers[ENTRY];
  if (current !== undefined && !isOurs(current, client)) {
    throw new InstallError(`${file} already has an entry named "${ENTRY}" that is not K-Browser's: left untouched`);
  }
  const wanted = remove ? undefined : commandFor(client);
  if (JSON.stringify(current) === JSON.stringify(wanted)) {
    say(`${client}: ${file} already ${remove ? 'has no K-Browser entry' : 'has this entry'}; nothing to do`);
    return;
  }
  // only our own entry is ever shown
  say(`${client}: ${file}`);
  if (current !== undefined) say(`  - "${ENTRY}": ${JSON.stringify(current)}`);
  if (wanted !== undefined) say(`  + "${ENTRY}": ${JSON.stringify(wanted)}`);
  if (dryRun) return;
  const next = { ...data, mcpServers: { ...servers } };
  if (wanted === undefined) delete next.mcpServers[ENTRY];
  else next.mcpServers[ENTRY] = wanted;
  const saved = backup(client, file, original);
  await beforeWrite?.();
  const now = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if ((now === null) !== (original === null) || (now && original && !now.equals(original))) {
    throw new InstallError(`${file} changed while K-Browser was editing it: stopped, nothing written (run it again)`);
  }
  const written = `${JSON.stringify(next, null, 2)}\n`;
  atomicWrite(file, written, original ? fs.statSync(file).mode & 0o777 : 0o600);
  noteWritten(saved, written);
  say(`  written (backup: ${path.basename(saved)}; \`k-browser restore ${saved}\` puts the old file back)`);
}

/**
 * @param {{ client: string, remove: boolean, dryRun: boolean, say: (s: string) => void, run: Run }} o
 */
function editCli({ client, remove, dryRun, say, run }) {
  const spec = /** @type {Extract<ClientSpec, { kind: 'cli' }>} */ (CLIENTS[client]);
  const got = run(spec.cmd, spec.get);
  if (got.missing) {
    say(`${client}: \`${spec.cmd}\` is not installed; skipped`);
    return;
  }
  const exists = got.status === 0;
  const ours = exists && isOurs(spec.parse(got.stdout), client);
  if (exists && !ours) {
    throw new InstallError(`${client}: ${spec.cmd} already has an MCP server named "${ENTRY}" that K-Browser cannot confirm is its own: left untouched`);
  }
  const { command, args } = commandFor(client);
  /** @type {string[][]} */ const steps = [];
  if (exists) steps.push(spec.remove);
  if (!remove) steps.push(spec.add([command, ...args]));
  if (!steps.length) {
    say(`${client}: no K-Browser entry; nothing to do`);
    return;
  }
  for (const s of steps) {
    say(`${client}: ${spec.cmd} ${s.join(' ')}`);
    if (dryRun) continue;
    const r = run(spec.cmd, s);
    // its own output is not repeated: a CLI may print settings or secrets of other servers when it fails
    if (r.status !== 0) throw new InstallError(`${client}: \`${spec.cmd} ${s.slice(0, 3).join(' ')}\` failed (exit ${r.status}); run it yourself to see why`);
  }
}

// ---------- install / uninstall ----------

/** @param {string | undefined} which */
function chosen(which) {
  if (!which || which === 'all') return Object.keys(CLIENTS);
  if (!CLIENTS[which]) throw new InstallError(`unknown client ${JSON.stringify(which)} (known: ${Object.keys(CLIENTS).join(', ')}, all)`);
  return [which];
}

/**
 * @param {{ client?: string, dryRun?: boolean, block?: string[], uninstall?: boolean, run?: Run, out?: (line: string) => void,
 *   beforeWrite?: () => void | Promise<void> }} o
 * @returns {Promise<{ ok: boolean, failed: string[] }>}
 */
export async function install({ client, dryRun = false, block = [], uninstall = false, run = realRun, out = (l) => console.log(l), beforeWrite } = {}) {
  /** Everything printed goes through the redactor with every K-Browser credential. @param {string} line */
  const say = (line) => out(redactor({ secrets: [auth.pairKey(), ...auth.clients().values()] }).text(line));
  const names = chosen(client);
  const blocked = patternsFor(block);
  /** @type {string[]} */ const failed = [];
  await withLock(async () => {
    for (const name of names) {
      try {
        if (!uninstall) {
          if (dryRun) say(`${name}: client token ${auth.clientRecord(name) ? 'exists' : 'would be created'} (~/.k-browser/clients/${name}.json)`);
          else {
            auth.addClient(name);
            if (blocked.length) {
              const had = auth.clientRecord(name)?.blockedOrigins ?? [];
              auth.updateClient(name, { blockedOrigins: [...new Set([...had, ...blocked])] });
              say(`${name}: blocks ${blocked.length} site patterns (${block.join(', ')})`);
            }
          }
        }
        const spec = CLIENTS[name];
        if (spec.kind === 'json') await editJson({ client: name, file: spec.file(), remove: uninstall, dryRun, say, beforeWrite });
        else editCli({ client: name, remove: uninstall, dryRun, say, run });
        if (uninstall && !dryRun && auth.removeClient(name)) say(`${name}: client token removed`);
      } catch (e) {
        failed.push(name);
        const msg = e instanceof InstallError ? e.message : `failed (${e instanceof Error ? e.message : String(e)})`;
        say(msg.startsWith(`${name}: `) ? msg : `${name}: ${msg}`);
      }
    }
  });
  if (dryRun) say('(dry run: nothing was changed)');
  return { ok: failed.length === 0, failed };
}
