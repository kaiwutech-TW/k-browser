// @ts-check
// The npx install: which copy is running (locate.js), putting a release at <home>/app and handing commands to it
// (launcher.js), and `update` of that install (update.js). npm really runs, offline, on small fake k-browser tarballs;
// the fake cli.js records what it was asked and whether install.lock was held. Agent CLIs are never run (run is a
// fake that reports them missing) and HOME is a throwaway folder, so no real agent configuration is read or written.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { launcherMain, otherInstalls } from '../src/launcher.js';
import { appCli, appDir, appPackage, compareVersions, everInstalled, identity, recover, swapIn, usable } from '../src/locate.js';
import { update } from '../src/update.js';
import { VERSION } from '../src/version.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-locate-'));
const saved = { home: process.env.HOME, kb: process.env.KBROWSER_HOME, spec: process.env.KBROWSER_PACKAGE_SPEC };
/** @type {string} */ let home;
/** @type {string} */ let out;
const missing = () => ({ status: null, stdout: '', missing: true });
const quiet = () => {};

/** A fake k-browser package of that version, packed: its cli.js writes { argv, locked } to $KB_OUT and exits $KB_CODE. */
function tarball(/** @type {string} */ version, { name = 'k-browser' } = {}) {
  const dir = path.join(scratch, `pkg-${name}-${version}`);
  const file = path.join(scratch, `${name}-${version}.tgz`);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'extension'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, files: ['src', 'extension'] }));
  fs.writeFileSync(path.join(dir, 'extension', 'manifest.json'), '{}');
  fs.writeFileSync(path.join(dir, 'src', 'cli.js'), `const fs = require('node:fs'), path = require('node:path');
fs.writeFileSync(process.env.KB_OUT, JSON.stringify({ argv: process.argv.slice(2), self: __filename,
  locked: fs.existsSync(path.join(process.env.KBROWSER_HOME, 'install.lock')) }));
process.exit(Number(process.env.KB_CODE || 0));\n`);
  const packed = execFileSync('npm', ['pack', '--json', '--pack-destination', scratch], { cwd: dir, encoding: 'utf8' });
  fs.renameSync(path.join(scratch, JSON.parse(packed)[0].filename), file);
  return file;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(scratch, 'home-'));
  process.env.HOME = home;
  process.env.KBROWSER_HOME = path.join(home, '.k-browser');
  out = path.join(home, 'out.json');
  process.env.KB_OUT = out;
  delete process.env.KB_CODE;
});

afterEach(() => {
  for (const [k, v] of [['HOME', saved.home], ['KBROWSER_HOME', saved.kb], ['KBROWSER_PACKAGE_SPEC', saved.spec]]) {
    if (v === undefined) delete process.env[/** @type {string} */ (k)];
    else process.env[/** @type {string} */ (k)] = v;
  }
});

process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

/** Put a fake release at <home>/app the way npm does. @param {string} version */
function installApp(version) {
  fs.mkdirSync(appDir(), { recursive: true });
  execFileSync('npm', ['install', '--prefix', appDir(), '--no-audit', '--no-fund', tarball(version)], { stdio: 'ignore' });
}

const ran = () => JSON.parse(fs.readFileSync(out, 'utf8'));

test('identity: <home>/app (also through a symlinked home), a git checkout, anything else', () => {
  assert.equal(identity(fs.mkdtempSync(path.join(scratch, 'npx-'))), 'launcher');
  const clone = fs.mkdtempSync(path.join(scratch, 'clone-'));
  fs.mkdirSync(path.join(clone, '.git'));
  assert.equal(identity(clone), 'clone');
  installApp('9.0.0');
  assert.equal(identity(appPackage()), 'app');
  const link = path.join(scratch, `link-${path.basename(home)}`);
  fs.symlinkSync(process.env.KBROWSER_HOME ?? '', link);
  process.env.KBROWSER_HOME = link;
  assert.equal(identity(appPackage()), 'app', 'the same folder through a symlinked home');
  assert.equal(identity(fs.realpathSync(appPackage())), 'app');
});

test('usable: only a plain folder of ours holding k-browser with cli.js and the manifest', () => {
  assert.match(String(/** @type {any} */ (usable()).why), /missing/);
  installApp('9.0.0');
  assert.deepEqual(usable(), { ok: true, version: '9.0.0' });
  fs.rmSync(path.join(appPackage(), 'extension', 'manifest.json'));
  assert.match(String(/** @type {any} */ (usable()).why), /manifest\.json is missing/);
  fs.rmSync(appDir(), { recursive: true });
  const elsewhere = fs.mkdtempSync(path.join(scratch, 'other-'));
  fs.symlinkSync(elsewhere, appDir());
  assert.match(String(/** @type {any} */ (usable()).why), /not a plain folder/);
  fs.rmSync(appDir());
  fs.mkdirSync(appDir(), { recursive: true });
  execFileSync('npm', ['install', '--prefix', appDir(), '--no-audit', '--no-fund', tarball('1.0.0', { name: 'k-browser-other' })], { stdio: 'ignore' });
  fs.renameSync(path.join(appDir(), 'node_modules', 'k-browser-other'), appPackage());
  assert.match(String(/** @type {any} */ (usable()).why), /not k-browser/);
});

test('recover: each state a cut-off replacement can leave comes back usable', () => {
  installApp('9.0.0');
  fs.renameSync(appDir(), `${appDir()}.old`); // stopped after the first rename
  fs.mkdirSync(`${appDir()}.staging`);
  assert.equal(everInstalled(), true);
  recover();
  assert.equal(usable().ok, true);
  assert.equal(fs.existsSync(`${appDir()}.old`) || fs.existsSync(`${appDir()}.staging`), false);
  fs.mkdirSync(`${appDir()}.old`); // stopped before the clean-up
  recover();
  assert.equal(usable().ok, true);
  assert.equal(fs.existsSync(`${appDir()}.old`), false);
});

test('swapIn: the second rename failing puts the old install back', () => {
  installApp('9.0.0');
  assert.throws(() => swapIn()); // no app.staging
  assert.deepEqual(usable(), { ok: true, version: '9.0.0' });
});

test('compareVersions', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('0.6.5', '0.6.5'), 0);
  assert.ok(compareVersions('0.6.5', '1.0.0') < 0);
});

test('launcher install: puts this version at <home>/app, lets go of the lock, then runs install there with the same arguments', async () => {
  process.env.KBROWSER_PACKAGE_SPEC = tarball(VERSION);
  process.env.KB_CODE = '3';
  const argv = ['--port', '9999', 'install', '--block', '', '--client', 'gemini-cli'];
  const code = await launcherMain(argv, 'install', argv.slice(3), { say: quiet, run: missing });
  assert.equal(code, 3, "install's exit code");
  assert.deepEqual(usable(), { ok: true, version: VERSION });
  const r = ran();
  assert.deepEqual(r.argv, argv);
  assert.equal(fs.realpathSync(r.self), fs.realpathSync(appCli()));
  assert.equal(r.locked, false, 'install.lock is free for install()');
  assert.equal(fs.existsSync(`${appDir()}.staging`) || fs.existsSync(`${appDir()}.old`), false);
});

test('launcher install: the same version is not fetched again; a newer one at <home>/app is kept', async () => {
  installApp(VERSION);
  process.env.KBROWSER_PACKAGE_SPEC = path.join(scratch, 'no-such.tgz'); // npm would fail if it ran
  assert.equal(await launcherMain(['install'], 'install', [], { say: quiet, run: missing }), 0);
  fs.rmSync(appDir(), { recursive: true });
  installApp('99.0.0');
  assert.equal(await launcherMain(['install'], 'install', [], { say: quiet, run: missing }), 0);
  assert.deepEqual(usable(), { ok: true, version: '99.0.0' });
});

test('launcher install: npm failing leaves <home>/app as it was and no staging behind', async () => {
  installApp('0.0.1');
  process.env.KBROWSER_PACKAGE_SPEC = path.join(scratch, 'no-such.tgz');
  /** @type {string[]} */ const errors = [];
  const orig = console.error;
  console.error = (/** @type {any} */ m) => { errors.push(String(m)); };
  try {
    assert.equal(await launcherMain(['install'], 'install', [], { say: quiet, run: missing }), 1);
  } finally {
    console.error = orig;
  }
  assert.match(errors.join('\n'), /nothing was changed/);
  assert.deepEqual(usable(), { ok: true, version: '0.0.1' });
  assert.equal(fs.existsSync(`${appDir()}.staging`), false);
  assert.equal(fs.existsSync(out), false, 'install was not run');
});

test('launcher install with a clone install in place: refused before anything is written', async () => {
  const clone = '/Users/someone/K-Browser/src/cli.js';
  const agents = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  const plist = path.join(agents, 'com.k-browser.bridge.plist');
  fs.writeFileSync(plist, `<plist><dict><key>ProgramArguments</key><array><string>/opt/homebrew/bin/node</string><string>${clone}</string>`
    + '<string>--port</string><string>8765</string><string>bridge</string></array></dict></plist>');
  assert.deepEqual(otherInstalls({ run: missing, plist }), [{ where: plist, cli: clone }]);
  fs.rmSync(plist);
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  const settings = (/** @type {string} */ cli) => fs.writeFileSync(path.join(home, '.gemini', 'settings.json'),
    JSON.stringify({ mcpServers: { 'k-browser': { command: 'node', args: [cli, 'mcp', '--client', 'gemini-cli'] } } }));
  settings(clone);
  assert.deepEqual(otherInstalls({ run: missing, plist }), [{ where: 'gemini-cli', cli: clone }]);
  settings(appCli());
  assert.deepEqual(otherInstalls({ run: missing, plist }), [], "<home>/app's own entry is not another install");
  const fromCodex = () => ({ status: 0, stdout: JSON.stringify({ name: 'k-browser', enabled: true,
    transport: { type: 'stdio', command: 'node', args: [clone, 'mcp', '--client', 'codex'] } }) });
  assert.deepEqual(otherInstalls({ run: (cmd) => (cmd === 'codex' ? fromCodex() : missing()), plist }), [{ where: 'codex', cli: clone }]);

  settings(clone);
  process.env.KBROWSER_PACKAGE_SPEC = tarball(VERSION);
  const orig = console.error;
  /** @type {string[]} */ const errors = [];
  console.error = (/** @type {any} */ m) => { errors.push(String(m)); };
  try {
    assert.equal(await launcherMain(['install'], 'install', [], { say: quiet, run: missing }), 1);
  } finally {
    console.error = orig;
  }
  assert.match(errors.join('\n'), /already installed from \/Users\/someone\/K-Browser\/src\/cli\.js/);
  assert.equal(fs.existsSync(process.env.KBROWSER_HOME ?? ''), false, 'nothing under ~/.k-browser');
});

test('launcher, other commands: run by <home>/app; here when nothing was ever installed; update says to install first', async () => {
  assert.equal(await launcherMain(['doctor'], 'doctor', [], { say: quiet }), null, 'never installed: this copy runs it');
  const orig = console.error;
  console.error = quiet;
  try {
    assert.equal(await launcherMain(['update'], 'update', [], { say: quiet }), 1);
  } finally {
    console.error = orig;
  }
  installApp('9.0.0');
  process.env.KB_CODE = '0';
  assert.equal(await launcherMain(['--port', '1', 'mcp', '--client', 'x'], 'mcp', ['--client', 'x'], { say: quiet }), 0);
  assert.deepEqual(ran().argv, ['--port', '1', 'mcp', '--client', 'x']);
  fs.renameSync(appDir(), `${appDir()}.old`); // an update cut off: put right, then run
  fs.rmSync(out);
  // with the default say, as an agent starting `npx k-browser mcp` gets it: nothing of the launcher's on stdout, which
  // is the MCP stream
  /** @type {string[]} */ const stdout = [];
  /** @type {string[]} */ const stderr = [];
  const [log, error] = [console.log, console.error];
  console.log = (/** @type {any} */ m) => { stdout.push(String(m)); };
  console.error = (/** @type {any} */ m) => { stderr.push(String(m)); };
  try {
    assert.equal(await launcherMain(['mcp', '--client', 'x'], 'mcp', ['--client', 'x']), 0);
  } finally {
    [console.log, console.error] = [log, error];
  }
  assert.deepEqual(stdout, []);
  assert.match(stderr.join('\n'), /put back/);
  assert.deepEqual(ran().argv, ['mcp', '--client', 'x']);
});

test('update of <home>/app: a newer release is swapped in and the bridge restarted; the same one changes nothing', async () => {
  installApp('9.0.0');
  /** @type {string[]} */ const said = [];
  let restarts = 0;
  let running = '9.0.0';
  const o = {
    root: appPackage(), port: 1, say: (/** @type {string} */ s) => { said.push(s); },
    service: { status: () => ({ loaded: true }), restart: () => { restarts++; running = /** @type {string} */ (usable().ok && /** @type {any} */ (usable()).version); } },
    probe: async () => /** @type {any} */ ({ kind: 'bridge', health: { version: running } }), waitMs: 2000,
  };
  process.env.KBROWSER_PACKAGE_SPEC = tarball('9.0.0');
  assert.deepEqual(await update(o), { from: '9.0.0', to: '9.0.0', pulled: false, installed: false, restarted: false });
  assert.equal(fs.existsSync(`${appDir()}.staging`), false);
  process.env.KBROWSER_PACKAGE_SPEC = tarball('9.1.0');
  assert.deepEqual(await update(o), { from: '9.0.0', to: '9.1.0', pulled: true, installed: true, restarted: true });
  assert.equal(restarts, 1);
  assert.deepEqual(usable(), { ok: true, version: '9.1.0' });
  assert.match(said.join('\n'), /9\.0\.0 -> 9\.1\.0[\s\S]*press ↻/);
  process.env.KBROWSER_PACKAGE_SPEC = path.join(scratch, 'no-such.tgz');
  await assert.rejects(update(o), /nothing was changed/);
  assert.deepEqual(usable(), { ok: true, version: '9.1.0' });
});
