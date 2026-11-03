// @ts-check
// The MCP shim: the agent keeps one connection while workers come and go (an update, a changed or re-added client
// record, a crash). With a fake worker (fixtures/fake-mcp-worker.js), then with the real `k-browser mcp`.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as auth from '../src/auth.js';
import { Shim } from '../src/mcp/shim.js';
import { sleep, until } from './fakes.js';

const FAKE = new URL('./fixtures/fake-mcp-worker.js', import.meta.url).pathname;
const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } };

/** A shim on a fake worker; the test plays the agent. @param {{ cooldownMs?: number[] }} [o] */
function setup(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-shim-'));
  const logFile = path.join(dir, 'log');
  const ctrlFile = path.join(dir, 'ctrl');
  fs.writeFileSync(logFile, '');
  let gen = 'g1';
  /** @type {any[]} */ const out = [];
  const shim = new Shim({ argv: [process.execPath, FAKE], generation: () => gen, write: (m) => out.push(m),
    env: { ...process.env, FAKE_LOG: logFile, FAKE_CTRL: ctrlFile }, ...o });
  const log = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return {
    shim, out, log,
    setGen: (/** @type {string} */ g) => { gen = g; },
    ctrl: (/** @type {any} */ c) => fs.writeFileSync(ctrlFile, JSON.stringify(c)),
    /** the agent's message @param {any} m */
    send: (m) => shim.fromAgent({ jsonrpc: '2.0', ...m }),
    /** the answer to the agent's request id @param {string | number} id */
    async answer(id, ms = 10_000) {
      assert.ok(await until(() => out.some((m) => m.id === id && m.method === undefined), ms), `an answer to ${id}`);
      return out.find((m) => m.id === id && m.method === undefined);
    },
    /** what a tools/call answered (its JSON line) @param {any} a */
    body: (a) => JSON.parse(a.result.content[0].text),
    pids: () => [...new Set(log().filter((x) => x.started).map((x) => x.pid))],
    async init() {
      this.send({ id: 'init', method: 'initialize', params: INIT });
      await this.answer('init');
      this.send({ method: 'notifications/initialized' });
    },
  };
}

test('the agent\'s ids come back as they were; the shim\'s own requests never reach the agent, whatever ids the agent uses', async () => {
  const s = setup();
  try {
    await s.init();
    const init = s.out.find((m) => m.id === 'init');
    assert.equal(init.result.protocolVersion, INIT.protocolVersion);
    assert.equal(init.result.capabilities.tools.listChanged, true, 'the agent is told the list may change');
    s.send({ id: 'kb-shim-1', method: 'tools/list' });
    s.send({ id: 1, method: 'tools/call', params: { name: 'echo' } });
    assert.deepEqual((await s.answer('kb-shim-1')).result.tools.map((/** @type {any} */ t) => t.name), ['echo']);
    assert.equal(s.body(await s.answer(1)).name, 'echo');
    s.send({ id: 'p', method: 'ping' });
    assert.deepEqual((await s.answer('p')).result, {});
    assert.deepEqual(s.out.map((m) => m.id), ['init', 'kb-shim-1', 1, 'p'], 'nothing else was written');
    const got = s.log().filter((x) => x.got).map((x) => x.got.method);
    assert.deepEqual(got, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'], 'ping is answered by the shim');
  } finally {
    await s.shim.close();
  }
});

test('a request before initialize (an agent probing for a newer protocol): "method not found", and no worker is started for it', async () => {
  const s = setup();
  try {
    s.send({ id: 'probe', method: 'server/discover', params: {} });
    assert.equal((await s.answer('probe')).error.code, -32601);
    assert.equal(s.pids().length, 0, 'nothing started');
    await s.init();
    assert.equal(s.out.find((m) => m.id === 'init').result.protocolVersion, INIT.protocolVersion, 'initialize afterwards works');
  } finally {
    await s.shim.close();
  }
});

test('a new generation: no new request reaches the old worker; they wait for its running call, then go to a new one', async () => {
  const s = setup();
  try {
    await s.init();
    s.send({ id: 1, method: 'tools/call', params: { name: 'echo' } });
    const first = s.body(await s.answer(1)).pid;
    s.send({ id: 2, method: 'tools/call', params: { name: 'slow', arguments: { ms: 400 } } });
    await until(() => s.log().some((x) => x.got?.params?.name === 'slow'), 5000);
    s.setGen('g2'); // e.g. eval turned off in the side panel
    s.send({ id: 3, method: 'tools/call', params: { name: 'echo' } });
    assert.equal(s.body(await s.answer(2)).pid, first, 'the running call finished on the old worker');
    const after = s.body(await s.answer(3)).pid;
    assert.notEqual(after, first, 'the next call went to a new worker');
    const oldGot = s.log().filter((x) => x.pid === first && x.got?.method === 'tools/call').map((x) => x.got.params.name);
    assert.deepEqual(oldGot, ['echo', 'slow'], 'the old worker never got the call made after the change');
    assert.ok(s.log().some((x) => x.pid === after && x.got?.method === 'notifications/initialized'), 'the new worker was initialized');
  } finally {
    await s.shim.close();
  }
});

test('the tool list of the new worker differs: list_changed; the same: nothing', async () => {
  const s = setup();
  try {
    await s.init();
    s.send({ id: 1, method: 'tools/list' });
    await s.answer(1);
    s.setGen('g2');
    s.send({ id: 2, method: 'tools/call', params: { name: 'echo' } });
    await s.answer(2);
    assert.ok(!s.out.some((m) => m.method === 'notifications/tools/list_changed'), 'same tools');
    s.ctrl({ tools: ['echo', 'eval'] });
    s.setGen('g3');
    s.send({ id: 3, method: 'tools/call', params: { name: 'echo' } });
    await s.answer(3);
    const i = s.out.findIndex((m) => m.method === 'notifications/tools/list_changed');
    assert.ok(i >= 0 && i < s.out.findIndex((m) => m.id === 3), 'list_changed before the answer');
  } finally {
    await s.shim.close();
  }
});

test('the worker dies during a call: result_unknown, never sent again; a tools/list it owed is asked again; the next call starts a new worker', async () => {
  const s = setup();
  try {
    await s.init();
    s.send({ id: 1, method: 'tools/call', params: { name: 'slow', arguments: { ms: 5000 } } });
    s.send({ id: 2, method: 'tools/list' });
    s.send({ id: 3, method: 'tools/call', params: { name: 'die' } });
    const lost = await s.answer(1);
    assert.equal(s.body(lost).error, 'result_unknown');
    assert.equal(lost.result.isError, true);
    assert.equal(s.body(await s.answer(3)).error, 'result_unknown');
    assert.deepEqual((await s.answer(2)).result.tools.map((/** @type {any} */ t) => t.name), ['echo'], 'tools/list again, on a new worker');
    s.send({ id: 4, method: 'tools/call', params: { name: 'echo' } });
    assert.equal(s.body(await s.answer(4)).name, 'echo');
    assert.equal(s.log().filter((x) => x.got?.params?.name === 'slow').length, 1, 'the lost call was not sent again');
    assert.equal(s.pids().length, 2);
  } finally {
    await s.shim.close();
  }
});

test('a worker that does not start: worker_failed; no new attempt during the cool-down; afterwards it recovers by itself', async () => {
  const s = setup({ cooldownMs: [600] });
  try {
    s.ctrl({ fail: true });
    s.send({ id: 'init', method: 'initialize', params: INIT });
    assert.match((await s.answer('init')).error.message, /did not start.*doctor/);
    s.send({ id: 1, method: 'tools/call', params: { name: 'echo' } });
    assert.equal(s.body(await s.answer(1)).error, 'worker_failed');
    assert.equal(s.log().filter((x) => x.started).length, 1, 'no attempt during the cool-down');
    s.ctrl({}); // e.g. npm ci finished
    await sleep(700);
    s.send({ id: 'init2', method: 'initialize', params: INIT });
    assert.equal((await s.answer('init2')).result.protocolVersion, INIT.protocolVersion);
    s.send({ id: 2, method: 'tools/call', params: { name: 'echo' } });
    assert.equal(s.body(await s.answer(2)).name, 'echo', 'the same generation, recovered');
  } finally {
    await s.shim.close();
  }
});

test('cancelled: a queued call is never handed on; a running one is cancelled under the worker\'s id, gets no answer, and does not hold back the new worker', async () => {
  const s = setup();
  try {
    await s.init();
    s.send({ id: 1, method: 'tools/call', params: { name: 'slow', arguments: { ms: 60_000 } } }); // a long run_flow, say
    await until(() => s.log().some((x) => x.got?.params?.name === 'slow'), 5000);
    const first = s.pids()[0];
    s.setGen('g2');
    s.send({ id: 2, method: 'tools/call', params: { name: 'echo' } }); // queued behind the running call
    s.send({ id: 3, method: 'tools/call', params: { name: 'echo' } });
    s.send({ method: 'notifications/cancelled', params: { requestId: 2 } });
    s.send({ method: 'notifications/cancelled', params: { requestId: 1 } });
    const pid = s.body(await s.answer(3)).pid;
    assert.notEqual(pid, first, 'the new worker took over without waiting for the cancelled call');
    await sleep(200);
    assert.ok(!s.out.some((m) => m.id === 1 || m.id === 2), 'no answer to a cancelled request');
    assert.equal(s.log().filter((x) => x.got?.params?.name === 'echo').length, 1, 'the cancelled queued call was never handed on');
    const slowId = s.log().find((x) => x.got?.params?.name === 'slow').got.id;
    const cancel = s.log().find((x) => x.pid === first && x.got?.method === 'notifications/cancelled');
    assert.equal(cancel.got.params.requestId, slowId, 'the worker\'s own id');
  } finally {
    await s.shim.close();
  }
});

test('a new worker answering initialize differently: worker_incompatible, and nothing is handed to it', async () => {
  const s = setup();
  try {
    await s.init();
    s.ctrl({ protocol: '2099-01-01' });
    s.setGen('g2');
    s.send({ id: 1, method: 'tools/call', params: { name: 'echo' } });
    const a = await s.answer(1);
    assert.equal(s.body(a).error, 'worker_incompatible');
    assert.match(s.body(a).message, /reconnect/);
    const second = s.pids()[1];
    assert.ok(!s.log().some((x) => x.pid === second && x.got?.method === 'tools/call'));
  } finally {
    await s.shim.close();
  }
});

test('the tab table goes from one worker to the next (adopt), after a crash too', async () => {
  const s = setup();
  try {
    await s.init();
    const state = { next: 3, tabs: [{ alias: 't1', targetId: 'A', opener: false, space: 'a', seq: 4 }, { alias: 't3', targetId: 'C', opener: true }] };
    s.send({ id: 1, method: 'tools/call', params: { name: 'tab', arguments: { state } } });
    await s.answer(1);
    s.send({ id: 2, method: 'tools/call', params: { name: 'die' } });
    await s.answer(2);
    s.send({ id: 3, method: 'tools/call', params: { name: 'echo' } });
    const pid = s.body(await s.answer(3)).pid;
    const adopt = s.log().find((x) => x.pid === pid && x.got?.method === 'k-browser/adopt');
    assert.deepEqual(adopt?.got.params, state);
    assert.ok(!s.out.some((m) => m.method === 'k-browser/tabs'), 'the table is not the agent\'s');
  } finally {
    await s.shim.close();
  }
});

test('the real `k-browser mcp`: revoked, then added again and given eval, without the agent reconnecting', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-shim-real-'));
  process.env.KBROWSER_HOME = home;
  const child = spawn(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, 'mcp', '--client', 'codex', '--port', '1'],
    { env: { ...process.env, KBROWSER_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  /** @type {any[]} */ const out = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  let ids = 0;
  /** @param {string} method @param {any} [params] */
  const rpc = async (method, params = {}) => {
    const id = ++ids;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    assert.ok(await until(() => out.some((m) => m.id === id), 20_000), method);
    return out.find((m) => m.id === id);
  };
  const names = async () => (await rpc('tools/list')).result.tools.map((/** @type {any} */ t) => t.name);
  try {
    await rpc('initialize', INIT);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    assert.deepEqual(await names(), ['status']);
    const gone = JSON.parse((await rpc('tools/call', { name: 'status', arguments: {} })).result.content[0].text);
    assert.equal(gone.error, 'unknown_client');
    auth.addClient('codex');
    const listed = await names();
    assert.ok(listed.includes('tabs') && !listed.includes('eval'), listed.join());
    assert.ok(out.some((m) => m.method === 'notifications/tools/list_changed'));
    auth.updateClient('codex', { eval: true });
    assert.ok((await names()).includes('eval'), 'eval turned on: listed at the next call');
    auth.updateClient('codex', { eval: false });
    assert.ok(!(await names()).includes('eval'), 'and off again');
    assert.equal(child.exitCode, null, 'the same process throughout');
  } finally {
    child.stdin.end();
    await new Promise((r) => child.once('exit', r));
  }
  assert.equal(child.exitCode, 0);
});
