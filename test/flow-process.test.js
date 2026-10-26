// @ts-check
// run_flow when K-Browser's own MCP process goes away (an orphaned Kav went on clicking): the real
// `k-browser mcp` process, the real ChildTransport with Kav's venv python (here a script that runs the fake Kav), killed
// with SIGTERM (it stops the flow first) and with SIGKILL (the guard stops Kav's group).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import * as auth from '../src/auth.js';
import { ChildTransport } from '../src/mcp/flow.js';
import { startBridge } from '../src/server.js';
import { FakeExtension, OPEN, until } from './fakes.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const FAKE_KAV = fileURLToPath(new URL('./fixtures/fake-kav.js', import.meta.url));
/** @type {Awaited<ReturnType<typeof startBridge>>} */ let bridge;
/** @type {string} */ let kfwHome;

beforeEach(async () => {
  process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-flowp-'));
  const kavDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-kavp-'));
  kfwHome = path.join(kavDir, 'home');
  fs.mkdirSync(path.join(kfwHome, 'recipes'), { recursive: true });
  fs.mkdirSync(path.join(kavDir, 'recipes'));
  fs.mkdirSync(path.join(kavDir, '.venv', 'bin'), { recursive: true });
  // "python -m kfw.mcp_server" runs the fake Kav
  fs.writeFileSync(path.join(kavDir, '.venv', 'bin', 'python'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_KAV}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(kfwHome, 'recipes', 'slow.json'), JSON.stringify({ name: 'slow', url: 'https://allowed.example/', fake: { mode: 'hang' } }));
  fs.writeFileSync(path.join(process.env.KBROWSER_HOME, 'config.json'), JSON.stringify({ kav: { dir: kavDir, home: kfwHome } }));
  auth.addClient('codex');
  bridge = await startBridge({ port: 0, revokePollMs: 50, log: () => {} });
  const ext = new FakeExtension(bridge.base, /** @type {string} */ (auth.pairKey({ create: true })));
  assert.ok(await ext.connect());
  assert.ok(await until(() => bridge.relay.ext !== null));
});

afterEach(async () => {
  while (OPEN.length) await /** @type {any} */ (OPEN.pop()).close();
  await bridge.close();
});

/** @param {number} pid */
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

for (const sig of /** @type {const} */ (['SIGTERM', 'SIGKILL'])) {
  test(`k-browser mcp killed with ${sig} while Kav runs a flow: Kav and what it started are gone`, async () => {
    const mcp = new ChildTransport(process.execPath, [CLI, '--port', String(bridge.port), 'mcp', '--client', 'codex'], /** @type {any} */ ({ ...process.env }), process.cwd());
    const client = new Client({ name: 't', version: '0' });
    await client.connect(/** @type {any} */ (mcp));
    void client.callTool({ name: 'run_flow', arguments: { flow: 'slow' } }).catch(() => {});
    const pidsFile = path.join(kfwHome, 'slow.pids.json');
    assert.ok(await until(() => fs.existsSync(pidsFile), 10000), 'Kav started the flow');
    const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
    assert.ok(alive(pids.kav) && alive(pids.child));
    process.kill(/** @type {number} */ (mcp.proc?.pid), sig);
    assert.ok(await until(() => !alive(pids.kav) && !alive(pids.child), 6000), `Kav (${pids.kav}) and its child (${pids.child}) stopped`);
    await mcp.close();
  });
}
