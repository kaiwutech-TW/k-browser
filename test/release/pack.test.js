// @ts-check
// Release check: `npm pack`, install the tarball into a throwaway project, and run what got installed — not this
// checkout: `k-browser extension-path` points at a directory with the manifest, and `k-browser mcp` started from the
// installed package answers initialize, tools/list and one tool call through a bridge also started from it.
// Then the npx install, through real `npx --package <tarball>`: install puts the release at <home>/app, the agent's
// configuration and the bridge use that copy, and `npx k-browser mcp` is run by it. HOME is a throwaway folder and PATH
// holds only node, npm, npx and the system's /usr/bin:/bin (npm needs sh), so no agent CLI or real configuration is reached.
// Needs the npm registry (or its cache) for the dependencies. Run: npm run test:pack

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOLS } from '../../src/mcp/tools.js';
import { sleep } from '../fakes.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-pack-'));
const app = path.join(root, 'app');
const home = path.join(root, 'home');
const bin = path.join(app, 'node_modules', '.bin', 'k-browser');
const env = { ...process.env, KBROWSER_HOME: home };
/** @type {import('node:child_process').ChildProcess | null} */ let bridge = null;
/** @type {import('node:child_process').ChildProcess | null} */ let bridge2 = null;
/** @type {number} */ let port;
/** @type {string} */ let tarball;

before(async () => {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', root], { cwd: REPO, encoding: 'utf8' }));
  tarball = path.join(root, packed[0].filename);
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'package.json'), '{ "name": "kb-pack-check", "private": true }');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', tarball], { cwd: app, stdio: 'ignore' });
  const s = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  port = /** @type {import('node:net').AddressInfo} */ (s.address()).port;
  await new Promise((r) => s.close(r));
});

after(() => {
  bridge?.kill('SIGTERM');
  bridge2?.kill('SIGTERM');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the tarball holds the code and the extension, not tests, records or secrets', () => {
  const files = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: REPO, encoding: 'utf8' }))[0].files.map((/** @type {any} */ f) => f.path);
  assert.ok(files.includes('src/cli.js') && files.includes('extension/manifest.json') && files.includes('package.json'));
  assert.deepEqual(files.filter((/** @type {string} */ f) => /^(test|docs|\.flightwake|\.claude)\//.test(f) || /\.(key|bak)$|pair|token/.test(f)), []);
});

test('the installed k-browser: extension-path has the manifest; bridge and mcp run from the installed package', async () => {
  assert.ok(fs.realpathSync(bin).startsWith(fs.realpathSync(app)), 'the bin is the installed copy');
  const ext = execFileSync(bin, ['extension-path'], { env, encoding: 'utf8' }).trim();
  assert.ok(fs.realpathSync(ext).startsWith(fs.realpathSync(app)) && fs.existsSync(path.join(ext, 'manifest.json')), ext);
  execFileSync(bin, ['client', 'add', 'codex'], { env, stdio: 'ignore' });

  bridge = spawn(bin, ['--port', String(port), 'bridge'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let up = false;
  for (let i = 0; i < 50 && !up; i++, await sleep(100)) {
    up = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false);
  }
  assert.ok(up, 'the installed bridge answers');

  await mcpCheck({ command: bin, args: ['--port', String(port), 'mcp', '--client', 'codex'], env });
});

/** initialize, tools/list and tabs list through `command args` (no extension is connected here). @param {{ command: string, args: string[], env: Record<string, string | undefined> }} o */
async function mcpCheck({ command, args, env: e }) {
  const client = new Client({ name: 'pack-check', version: '0' });
  const transport = new StdioClientTransport({ command, args, env: /** @type {Record<string, string>} */ (e), stderr: 'pipe' });
  try {
    await client.connect(transport); // initialize
    assert.equal(client.getServerVersion()?.name, 'k-browser');
    const { tools } = await client.listTools();
    assert.equal(tools.length, TOOLS.length - 2); // run_flow is listed only with Kav set up, eval only when turned on
    // one call through the installed MCP server to the installed bridge: a server without the client's token would
    // answer with an error, not the empty list
    const r = await client.callTool({ name: 'tabs', arguments: { action: 'list' } });
    const text = JSON.stringify(r.content);
    assert.equal(r.isError, undefined, text);
    assert.deepEqual(r.content, [{ type: 'text', text: '{"tabs":[]}' }], 'the bridge answered (same version), with no tab owned yet');
  } finally {
    await client.close();
  }
}

test('npx install: the release goes to <home>/app, and the agent, the bridge and `npx k-browser mcp` all use that copy', async () => {
  const home2 = path.join(root, 'home2');
  const kb = path.join(home2, '.k-browser');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(home2);
  fs.mkdirSync(binDir);
  const which = (/** @type {string} */ c) => execFileSync('/usr/bin/which', [c], { encoding: 'utf8' }).trim();
  for (const c of ['node', 'npm', 'npx']) fs.symlinkSync(fs.realpathSync(which(c)), path.join(binDir, c));
  const env2 = { ...process.env, HOME: home2, KBROWSER_HOME: kb, PATH: `${binDir}:/usr/bin:/bin`, KBROWSER_PACKAGE_SPEC: tarball };
  const npx = path.join(binDir, 'npx');
  const viaNpx = ['--yes', '--package', tarball, 'k-browser'];
  /** stdout, and everything (the launcher's own lines go to stderr). @param {string[]} args */
  const run = (args) => {
    const r = spawnSync(npx, [...viaNpx, ...args], { cwd: root, env: env2, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(r.status, 0, r.stderr);
    return { out: r.stdout, all: r.stdout + r.stderr };
  };

  const first = run(['install', '--client', 'gemini-cli', '--block', '', '--no-service']).all;
  const app = fs.realpathSync(path.join(kb, 'app', 'node_modules', 'k-browser'));
  assert.ok(fs.existsSync(path.join(app, 'extension', 'manifest.json')), first);
  assert.match(first, /npm install /);
  const entry = JSON.parse(fs.readFileSync(path.join(home2, '.gemini', 'settings.json'), 'utf8')).mcpServers['k-browser'];
  assert.deepEqual(entry.args, [path.join(app, 'src', 'cli.js'), 'mcp', '--client', 'gemini-cli'], 'the agent runs <home>/app, not npx\'s cache');

  // the shrinkwrap is in the package and no development package came along. npm follows a package's own shrinkwrap
  // only when it comes from the registry, not from a tarball file like this one: that part is checked after publishing
  const appModules = path.join(kb, 'app', 'node_modules');
  assert.ok(fs.existsSync(path.join(app, 'npm-shrinkwrap.json')));
  assert.ok(fs.existsSync(path.join(appModules, 'ws', 'package.json')));
  assert.equal(fs.existsSync(path.join(appModules, 'typescript')), false);

  const again = run(['install', '--client', 'gemini-cli', '--block', '', '--no-service']).all;
  assert.doesNotMatch(again, /npm install /, 'the same version is not fetched again');
  assert.equal(fs.realpathSync(run(['extension-path']).out.trim()), path.join(app, 'extension'), 'extension-path is answered by <home>/app');

  const s = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const port2 = /** @type {import('node:net').AddressInfo} */ (s.address()).port;
  await new Promise((r) => s.close(r));
  bridge2 = spawn(process.execPath, [path.join(app, 'src', 'cli.js'), '--port', String(port2), 'bridge'], { env: env2, stdio: ['ignore', 'ignore', 'pipe'] });
  let up = false;
  for (let i = 0; i < 50 && !up; i++, await sleep(100)) {
    up = await fetch(`http://127.0.0.1:${port2}/health`).then((r) => r.ok, () => false);
  }
  assert.ok(up, 'the bridge from <home>/app answers');
  await mcpCheck({ command: npx, args: [...viaNpx, '--port', String(port2), 'mcp', '--client', 'gemini-cli'], env: env2 });
});
