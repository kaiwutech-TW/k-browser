// @ts-check
// The installer (src/install.js), in a throwaway HOME with fake `claude` / `codex` runners: nothing real is
// touched. JSON rules (empty, invalid, someone else's entry of the same name, an outside change meanwhile, the lock,
// uninstall removing only ours), backups (0600 / 0700, restored byte for byte), and a fake-secret scan of everything
// printed.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import * as auth from '../src/auth.js';
import { CLI_PATH, ENTRY, install, InstallError, isOurs, nodeBinary, restore } from '../src/install.js';

const OTHER_KEY = 'FAKEotherServerApiKey0123456789';
const PAIR = 'kbFAKEpairKEYforInstallTests0123';

/** @type {string} */ let home;
/** @type {string[]} */ let out;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-install-home-'));
  process.env.HOME = home;
  process.env.KBROWSER_HOME = path.join(home, '.k-browser');
  fs.mkdirSync(process.env.KBROWSER_HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(process.env.KBROWSER_HOME, 'pair.key'), PAIR, { mode: 0o600 });
  out = [];
});

const antigravity = () => path.join(home, '.gemini', 'config', 'mcp_config.json');
const gemini = () => path.join(home, '.gemini', 'settings.json');
/** @param {string} file @param {string} text */
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode: 0o644 }); };
const OTHERS = `{\n\t"theme": "dark",\n\t"mcpServers": {\n\t\t"github": { "command": "gh-mcp", "env": { "GITHUB_TOKEN": "${OTHER_KEY}" } }\n\t},\n\t"note": "中文 ✓"\n}\n`;

/** A fake `claude` / `codex`: remembers what was added. @param {Record<string, string>} [existing] cmd -> stdout of `mcp get` */
function fakeRun(existing = {}) {
  /** @type {Map<string, string>} */ const servers = new Map(Object.entries(existing));
  /** @type {string[][]} */ const calls = [];
  /** @type {import('../src/install.js').Run} */
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'missing-cli') return { status: null, stdout: '', stderr: '', missing: true };
    if (args[1] === 'get') return servers.has(cmd) ? { status: 0, stdout: /** @type {string} */ (servers.get(cmd)), stderr: '' } : { status: 1, stdout: '', stderr: 'not found' };
    if (args[1] === 'add') {
      // what the real CLIs print for `mcp get` afterwards (formats seen in a scratch HOME)
      const [command, ...rest] = args.slice(args.indexOf('--') + 1);
      servers.set(cmd, cmd === 'codex' ? JSON.stringify({ name: ENTRY, enabled: true, disabled_reason: null,
        transport: { type: 'stdio', command, args: rest, env: null, env_vars: [], cwd: null },
        enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null })
        : `${ENTRY}:\n  Type: stdio\n  Command: ${command}\n  Args: ${rest.join(' ')}\n  Environment:\n\nTo remove this server, run: claude mcp remove ${ENTRY} -s user\n`);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[1] === 'remove') { servers.delete(cmd); return { status: 0, stdout: '', stderr: '' }; }
    return { status: 2, stdout: '', stderr: 'unexpected' };
  };
  return { run, calls, servers };
}

/** @param {Parameters<typeof install>[0]} o */
const go = (o) => install({ out: (l) => out.push(l), run: fakeRun().run, ...o });

test('a missing file and an empty file: created with K-Browser\'s entry only (absolute paths, no token)', async () => {
  put(gemini(), '');
  const r = await go({ client: 'all' });
  assert.equal(r.ok, true, out.join('\n'));
  for (const [file, name] of [[antigravity(), 'antigravity'], [gemini(), 'gemini-cli']]) {
    const e = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers[ENTRY];
    assert.deepEqual(e, { command: nodeBinary(), args: [CLI_PATH, 'mcp', '--client', name] });
    assert.ok(path.isAbsolute(e.command) && path.isAbsolute(e.args[0]));
    assert.ok(!fs.readFileSync(file, 'utf8').includes(/** @type {string} */ (auth.clients().get(name))), 'no token in the agent\'s configuration');
  }
  assert.equal(fs.statSync(antigravity()).mode & 0o777, 0o600, 'a new file is private');
  assert.deepEqual([...auth.clients().keys()].sort(), ['antigravity', 'claude-code', 'codex', 'gemini-cli']);
});

test('invalid JSON, and someone else\'s entry named "k-browser": stop, untouched', async () => {
  put(antigravity(), '{ "mcpServers": { oops');
  put(gemini(), JSON.stringify({ mcpServers: { [ENTRY]: { command: 'someone-else', args: ['--flag'] } } }));
  const before = [fs.readFileSync(antigravity()), fs.readFileSync(gemini())];
  const r = await go({ client: 'all' });
  assert.deepEqual(r.failed.sort(), ['antigravity', 'gemini-cli']);
  assert.ok(fs.readFileSync(antigravity()).equals(before[0]) && fs.readFileSync(gemini()).equals(before[1]));
  assert.match(out.join('\n'), /not valid JSON: left untouched/);
  assert.match(out.join('\n'), /not K-Browser's: left untouched/);
});

test('an entry that only looks like ours (another product\'s cli.js) is someone else\'s: untouched, and its secret never printed', async () => {
  const theirs = JSON.stringify({ mcpServers: { [ENTRY]: { command: 'node', args: ['/opt/other-product/cli.js', 'mcp', '--client', 'gemini-cli'], env: { SERVICE_KEY: OTHER_KEY } } } });
  put(gemini(), theirs);
  await go({ client: 'gemini-cli', dryRun: true });
  const r = await go({ client: 'gemini-cli' });
  assert.deepEqual(r.failed, ['gemini-cli']);
  assert.equal(fs.readFileSync(gemini(), 'utf8'), theirs);
  assert.equal(out.join('\n').split(OTHER_KEY).length - 1, 0, out.join('\n'));
});

test('a file that is not UTF-8, and a symbolic link: left untouched', async () => {
  const bytes = Buffer.concat([Buffer.from('{"note":"'), Buffer.from([0xff, 0xfe]), Buffer.from('","mcpServers":{}}')]);
  put(antigravity(), '');
  fs.writeFileSync(antigravity(), bytes);
  const target = path.join(home, 'dotfiles-settings.json');
  fs.writeFileSync(target, OTHERS);
  fs.mkdirSync(path.dirname(gemini()), { recursive: true });
  fs.symlinkSync(target, gemini());
  const r = await go({ client: 'all' });
  assert.deepEqual(r.failed.sort(), ['antigravity', 'gemini-cli']);
  assert.ok(fs.readFileSync(antigravity()).equals(bytes));
  assert.ok(fs.lstatSync(gemini()).isSymbolicLink() && fs.readFileSync(target, 'utf8') === OTHERS);
  assert.match(out.join('\n'), /not UTF-8/);
  assert.match(out.join('\n'), /symbolic link/);
  // a link whose target does not exist yet
  fs.rmSync(gemini());
  fs.symlinkSync(path.join(home, 'not-yet.json'), gemini());
  const r2 = await go({ client: 'gemini-cli' });
  assert.deepEqual(r2.failed, ['gemini-cli']);
  assert.ok(fs.lstatSync(gemini()).isSymbolicLink() && !fs.existsSync(path.join(home, 'not-yet.json')));
});

test('an outside change between reading and writing is detected: stop, nothing written over it', async () => {
  put(antigravity(), OTHERS);
  const theirs = '{"mcpServers":{"added-meanwhile":{"command":"x"}}}';
  const r = await go({ client: 'antigravity', beforeWrite: () => fs.writeFileSync(antigravity(), theirs) });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(antigravity(), 'utf8'), theirs);
  assert.match(out.join('\n'), /changed while K-Browser was editing it/);
});

test('two installs at once: the lock stops the second; a lock left by a process that is gone is taken over', async () => {
  const lock = path.join(/** @type {string} */ (process.env.KBROWSER_HOME), 'install.lock');
  fs.writeFileSync(lock, String(process.pid));
  await assert.rejects(go({ client: 'antigravity' }), (e) => e instanceof InstallError && /another k-browser install/.test(e.message));
  assert.ok(!fs.existsSync(antigravity()));
  fs.writeFileSync(lock, '999999'); // no such process
  assert.equal((await go({ client: 'antigravity' })).ok, true);
  assert.ok(!fs.existsSync(lock), 'released');
  // and truly concurrent: one of two runs at a time
  const [a, b] = await Promise.allSettled([go({ client: 'gemini-cli' }), go({ client: 'gemini-cli' })]);
  assert.deepEqual([a.status, b.status].sort(), ['fulfilled', 'rejected'], 'exactly one ran');
});

test('uninstall removes only K-Browser\'s entry and tokens; everything else in the file stays', async () => {
  put(gemini(), OTHERS);
  await go({ client: 'gemini-cli' });
  assert.ok(JSON.parse(fs.readFileSync(gemini(), 'utf8')).mcpServers[ENTRY]);
  await go({ client: 'gemini-cli', uninstall: true });
  const after = JSON.parse(fs.readFileSync(gemini(), 'utf8'));
  assert.deepEqual(after, JSON.parse(OTHERS));
  assert.equal(auth.clientRecord('gemini-cli'), null);
});

test('backups: 0700 / 0600, never printed, and restore puts the file back byte for byte', async () => {
  put(gemini(), OTHERS);
  const original = fs.readFileSync(gemini());
  await go({ client: 'gemini-cli' });
  const dir = path.join(/** @type {string} */ (process.env.KBROWSER_HOME), 'backups');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const f of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
  const meta = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f))[0];
  assert.ok(fs.readFileSync(meta.replace(/\.json$/, '.bak')).equals(original), 'the backup keeps the original, credentials included');
  // the user adds a server after the install: restoring would lose it, so it is refused unless forced
  const installed = fs.readFileSync(gemini());
  const later = JSON.parse(installed.toString());
  later.mcpServers.added = { command: 'mine', env: { K: OTHER_KEY } };
  fs.writeFileSync(gemini(), JSON.stringify(later));
  assert.throws(() => restore(meta), /changed after K-Browser wrote it/);
  assert.equal(JSON.parse(fs.readFileSync(gemini(), 'utf8')).mcpServers.added.command, 'mine', 'the later server is kept');
  restore(meta, { force: true });
  assert.ok(fs.readFileSync(gemini()).equals(original), 'restored byte for byte (forced)');
  // a file that did not exist is removed again
  await go({ client: 'antigravity' });
  const fresh = fs.readdirSync(dir).filter((f) => f.startsWith('antigravity') && f.endsWith('.json')).map((f) => path.join(dir, f))[0];
  restore(fresh);
  assert.ok(!fs.existsSync(antigravity()));
});

test('--dry-run changes nothing; it and every diagnostic show no other server\'s secret and no K-Browser credential', async () => {
  put(gemini(), OTHERS);
  put(antigravity(), `{ "mcpServers": { "x": { "env": { "K": "${OTHER_KEY}" } } }, broken`);
  const before = fs.readFileSync(gemini());
  await go({ client: 'all', dryRun: true });
  assert.ok(fs.readFileSync(gemini()).equals(before));
  assert.equal(auth.clients().size, 0, 'no token created');
  assert.match(out.join('\n'), /\+ "k-browser"/);
  await go({ client: 'all' }); // the real run: tokens now exist, one file fails
  await go({ client: 'all', uninstall: true, dryRun: true });
  const printed = out.join('\n');
  for (const secret of [OTHER_KEY, PAIR, ...auth.clients().values()]) assert.equal(printed.split(secret).length - 1, 0, `${secret.slice(0, 8)}… printed`);
  assert.doesNotMatch(printed, /github|GITHUB_TOKEN|theme/, 'other entries are not shown at all');
  // a CLI that fails and dumps what it saw (its environment, its config) into stderr: printed only after redaction
  const tokens = [...auth.clients().values()];
  const noisy = () => ({ status: 3, stdout: '', stderr: `boom: KB=${tokens[0]} pair=${PAIR} ok` });
  const before2 = out.length;
  await install({ client: 'codex', run: (cmd, args) => (args[1] === 'get' ? { status: 1, stdout: '', stderr: '' } : noisy()), out: (l) => out.push(l) });
  const failure = out.slice(before2).join('\n');
  assert.match(failure, /failed \(exit 3\); run it yourself/, failure);
  assert.doesNotMatch(failure, /boom/, 'a failing CLI\'s own output is not repeated (it may hold anyone\'s secrets)');
});

test('claude-code and codex through their own CLIs: our entry added; someone else\'s "k-browser" left alone; a missing CLI skipped', async () => {
  const f = fakeRun();
  const r = await install({ client: 'all', run: f.run, out: (l) => out.push(l) });
  assert.equal(r.ok, true, out.join('\n'));
  const add = f.calls.find((c) => c[0] === 'claude' && c[2] === 'add');
  assert.deepEqual(add, ['claude', 'mcp', 'add', '--scope', 'user', ENTRY, '--', nodeBinary(), CLI_PATH, 'mcp', '--client', 'claude-code']);
  assert.deepEqual(f.calls.find((c) => c[0] === 'codex' && c[2] === 'add')?.slice(0, 5), ['codex', 'mcp', 'add', ENTRY, '--']);
  // the node a configuration names survives `brew upgrade node`: a stable link to this binary when there is one
  assert.equal(fs.realpathSync(nodeBinary()), fs.realpathSync(process.execPath));
  if (fs.existsSync('/opt/homebrew/bin/node') && fs.realpathSync('/opt/homebrew/bin/node') === fs.realpathSync(process.execPath)) {
    assert.equal(nodeBinary(), '/opt/homebrew/bin/node');
  }
  // installing again: recognised as ours, replaced
  const again = await install({ client: 'all', run: f.run, out: (l) => out.push(l) });
  assert.equal(again.ok, true, out.join('\n'));
  assert.ok(f.calls.some((c) => c[0] === 'codex' && c[2] === 'remove') && f.calls.some((c) => c[0] === 'claude' && c[2] === 'remove'));
  // someone else's, even with "--client codex" in its args
  for (const [cmd, client, stdout] of [
    ['codex', 'codex', JSON.stringify({ transport: { type: 'stdio', command: '/usr/bin/printf', args: ['--client', 'codex'], env: { K: 'v' } } })],
    ['codex', 'codex', JSON.stringify({ transport: { type: 'stdio', command: 'node', args: ['/opt/other-product/cli.js', 'mcp', '--client', 'codex'] } })],
    ['codex', 'codex', 'not json at all'],
    // ours, but with settings the user added: a remove + add would lose them (second round, seen with the real codex CLI)
    ...[{ transport: { env_vars: ['KBROWSER_HOME'] } }, { transport: { cwd: '/tmp' } }, { enabled_tools: ['tabs'] }, { enabled: false },
      { startup_timeout_sec: 30 }, { something_new: 'x' }, { enabled_tools: [] }, { disabled_tools: [] }, { transport: { env: {} } }].map((extra) => ['codex', 'codex', JSON.stringify({ name: ENTRY, enabled: true, ...extra,
      transport: { type: 'stdio', command: process.execPath, args: [CLI_PATH, 'mcp', '--client', 'codex'], env: null, ...extra.transport } })]),
    ['claude', 'claude-code', `${ENTRY}:\n  Command: /usr/bin/printf\n  Args: --client claude-code\n  Environment:\n`],
    ['claude', 'claude-code', `${ENTRY}:\n  Command: ${process.execPath}\n  Args: ${CLI_PATH} mcp --client claude-code\n  Environment:\n    API_KEY=${OTHER_KEY}\n`],
  ]) {
    const foreign = fakeRun({ [cmd]: stdout });
    const r2 = await install({ client, run: foreign.run, out: (l) => out.push(l) });
    assert.deepEqual(r2.failed, [client], stdout);
    assert.ok(!foreign.calls.some((c) => c[2] === 'add' || c[2] === 'remove'), `not touched: ${stdout}`);
  }
  const missing = await install({ client: 'claude-code', run: () => ({ status: null, stdout: '', stderr: '', missing: true }), out: (l) => out.push(l) });
  assert.equal(missing.ok, true);
  assert.match(out.join('\n'), /`claude` is not installed; skipped/);
  assert.ok(!out.some((l) => /^(codex|claude-code): \1: /.test(l)), 'the client name is said once');
});

test('site categories go into the client\'s blockedOrigins; an unknown one is refused before anything changes', async () => {
  await go({ client: 'antigravity', block: ['banking', 'email'] });
  const rec = auth.clientRecord('antigravity');
  assert.ok(rec?.blockedOrigins.includes('bot.com.tw') && rec.blockedOrigins.includes('mail.google.com'));
  await assert.rejects(go({ client: 'gemini-cli', block: ['nope'] }), /unknown site categories/);
  assert.ok(!fs.existsSync(gemini()));
  assert.equal(isOurs({ command: '/other/node', args: [CLI_PATH, 'mcp', '--client', 'codex'] }, 'codex'), true, 'node may have moved');
  assert.equal(isOurs({ command: 'node', args: [CLI_PATH, 'mcp', '--client', 'codex'] }, 'claude-code'), false);
  assert.equal(isOurs({ command: 'node', args: ['/x/k-browser/src/cli.js', 'mcp', '--client', 'codex'] }, 'codex'), false, 'another checkout: not provably ours');
  assert.equal(isOurs({ command: 'node', args: [CLI_PATH, 'mcp', '--client', 'codex'], env: { K: 'v' } }, 'codex'), false, 'ours never has an env');
  for (const extra of [{ cwd: '/tmp' }, { timeout: 5000 }, { trust: true }, { includeTools: ['a'] }, { type: 'sse' }]) {
    assert.equal(isOurs({ command: 'node', args: [CLI_PATH, 'mcp', '--client', 'gemini-cli'], ...extra }, 'gemini-cli'), false, JSON.stringify(extra));
  }
  assert.equal(isOurs({ command: 'node', args: [CLI_PATH, 'mcp', '--client', 'gemini-cli'], type: 'stdio', env: null }, 'gemini-cli'), true);
  // an empty list or object is a setting too (enabled_tools: [] allows no tool; third round)
  for (const extra of [{ env: {} }, { includeTools: [] }, { excludeTools: [] }, { env_vars: ['X'] }]) {
    assert.equal(isOurs({ command: 'node', args: [CLI_PATH, 'mcp', '--client', 'gemini-cli'], ...extra }, 'gemini-cli'), false, JSON.stringify(extra));
  }
});
