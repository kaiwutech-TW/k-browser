// @ts-check
// Release check: `npm pack`, install the tarball into a throwaway project, and run what got installed — not this
// checkout: `k-browser extension-path` points at a directory with the manifest, and `k-browser mcp` started from the
// installed package answers initialize, tools/list and one tool call through a bridge also started from it.
// Needs the npm registry (or its cache) for the dependencies. Run: npm run test:pack

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { sleep } from '../fakes.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-pack-'));
const app = path.join(root, 'app');
const home = path.join(root, 'home');
const bin = path.join(app, 'node_modules', '.bin', 'k-browser');
const env = { ...process.env, KBROWSER_HOME: home };
/** @type {import('node:child_process').ChildProcess | null} */ let bridge = null;
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

  const client = new Client({ name: 'pack-check', version: '0' });
  const transport = new StdioClientTransport({ command: bin, args: ['--port', String(port), 'mcp', '--client', 'codex'], env, stderr: 'pipe' });
  await client.connect(transport); // initialize
  assert.equal(client.getServerVersion()?.name, 'k-browser');
  const { tools } = await client.listTools();
  assert.equal(tools.length, 13); // run_flow is listed only with Kav set up
  // one call through the installed MCP server to the installed bridge (no extension is connected here)
  const r = await client.callTool({ name: 'tabs', arguments: { action: 'list' } });
  const text = JSON.stringify(r.content);
  assert.equal(r.isError, undefined, text);
  assert.deepEqual(r.content, [{ type: 'text', text: '{"tabs":[]}' }], 'the bridge answered (same version), with no tab owned yet');
  await client.close();
});
