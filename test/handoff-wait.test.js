// @ts-check
// needs_human {action: "wait"} through the MCP session, against a fake bridge: it answers as soon as the hand-off is no
// longer waiting (exactly as status would), "waiting" when its time is up, stops at a cancellation even while a
// question to the bridge is still out, never runs past its time when the bridge is slow, and sends MCP progress only
// when the request carried a progress token, and none after it is over.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import * as auth from '../src/auth.js';
import { handoffWaitDefault, McpSession } from '../src/mcp/server.js';
import { SdkError } from '../src/sdk/cdp.js';

beforeEach(() => {
  process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-hwait-'));
});

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A session whose bridge answers handoffStatus with status(n) for the n-th question (it may return a promise).
 * @param {(n: number, params: any) => any} status @param {{ blocked?: string[], name?: string }} [o]
 */
function setup(status, { blocked = [], name = 'codex' } = {}) {
  auth.addClient(name);
  auth.updateClient(name, { blockedOrigins: blocked });
  /** @type {{ at: number, params: any, timeoutMs: number | undefined }[]} */ const asked = [];
  const client = {
    closedWhy: null,
    onEvent() {},
    async call(/** @type {string} */ method, /** @type {any} */ params, /** @type {any} */ _sid, /** @type {any} */ o) {
      if (method === 'Target.setDiscoverTargets') return {};
      if (method === 'KBrowser.handoffStatus') {
        asked.push({ at: Date.now(), params, timeoutMs: o?.timeoutMs });
        return status(asked.length, params);
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const s = new McpSession({ name, port: 1, record: /** @type {any} */ (auth.clientRecord(name)), connect: /** @type {any} */ (async () => ({ client, close() {} })) });
  s.waitTiming = { pollMs: 20, queryMs: 200, progressMs: 50 };
  return { s, asked };
}

/** @param {any} r */
const parse = (r) => {
  const text = r.content.map((/** @type {any} */ c) => c.text).join('\n');
  return { head: JSON.parse(text.split('\n')[0]), text, isError: r.isError === true };
};
const waiting = { handoffId: 'h1', state: 'waiting', targetId: 'T1' };

test('already returned: wait answers at once, as status does (the URL, or only the origin of a blocked site)', async () => {
  const { s, asked } = setup(() => ({ handoffId: 'h1', state: 'returned', targetId: 'T1', url: 'https://shop.example/done' }));
  const w = parse(await s.call('needs_human', { action: 'wait', handoff: 'h1' }));
  const st = parse(await s.call('needs_human', { action: 'status', handoff: 'h1' }));
  assert.deepEqual(w.head, st.head);
  assert.equal(w.text, st.text);
  assert.equal(w.head.state, 'returned');
  assert.match(w.head.note, /not that the task succeeded/);
  assert.match(w.text, /shop\.example\/done/);
  assert.equal(asked.length, 2);

  const b = setup(() => ({ handoffId: 'h1', state: 'returned', targetId: 'T1', url: 'https://bank.example/account/123' }), { blocked: ['bank.example'], name: 'other' });
  const bw = parse(await b.s.call('needs_human', { action: 'wait', handoff: 'h1' }));
  assert.deepEqual([bw.head.state, bw.head.status, bw.head.origin], ['returned', 'blocked_origin', 'https://bank.example']);
  assert.doesNotMatch(bw.text, /account\/123/);
});

test('the hand-off ends while waiting: wait answers with the new state at the next question', async () => {
  for (const end of [{ state: 'returned', url: 'https://shop.example/' }, { state: 'cancelled', why: 'the client cancelled it' },
    { state: 'expired', why: 'nobody returned it within 30 min' }, { state: 'invalidated', why: 'the tab was closed' }]) {
    const { s, asked } = setup((n) => (n < 4 ? waiting : { handoffId: 'h1', targetId: 'T1', ...end }));
    const t0 = Date.now();
    const w = parse(await s.call('needs_human', { action: 'wait', handoff: 'h1', timeoutMs: 5000 }));
    assert.equal(w.head.state, end.state);
    assert.equal(w.isError, false);
    if ('why' in end) assert.equal(w.head.why, end.why);
    assert.equal(asked.length, 4);
    assert.ok(Date.now() - t0 < 1000, 'answered at the next question, not at the end of the wait');
  }
});

test('an unknown or someone else\'s id reads as invalidated at once (the bridge does not say which)', async () => {
  const { s, asked } = setup(() => ({ handoffId: 'hX', state: 'invalidated', why: 'this bridge does not know it (it may have restarted)' }));
  const w = parse(await s.call('needs_human', { action: 'wait', handoff: 'hX', timeoutMs: 5000 }));
  assert.deepEqual([w.isError, w.head.state, asked.length], [false, 'invalidated', 1]);
});

test('time up: waiting with what to do next, not an error, on time; timeoutMs is clamped to 1 s..30 min', async () => {
  const { s, asked } = setup(() => waiting);
  const t0 = Date.now();
  const w = parse(await s.call('needs_human', { action: 'wait', handoff: 'h1', timeoutMs: 1000 }));
  const took = Date.now() - t0;
  assert.deepEqual([w.isError, w.head.state, w.head.waiting, w.head.handoffId, w.head.tab], [false, 'waiting', true, 'h1', null]);
  assert.match(w.head.next, /call needs_human \{action:"wait"\} again/);
  assert.ok(took >= 980 && took < 1150, `${took} ms`);
  assert.ok(asked.length >= 20, 'kept asking meanwhile');
  const t1 = Date.now();
  const low = parse(await s.call('needs_human', { action: 'wait', handoff: 'h1', timeoutMs: -5 }));
  assert.equal(low.head.state, 'waiting');
  assert.ok(Date.now() - t1 >= 980, 'a timeout under 1 s waits 1 s');
  const bad = parse(await s.call('needs_human', { action: 'wait' }));
  assert.deepEqual([bad.isError, bad.head.error], [true, 'bad_argument']);
});

test('the bridge slow to answer: no question runs past the wait\'s end; one that got no answer is asked again', async () => {
  // a bridge that answers nothing: each question fails when the time the session gave it runs out, as the SDK does
  const { s, asked } = setup((n, _p) => new Promise((_, reject) => {
    const q = asked[n - 1];
    setTimeout(() => reject(new SdkError('result_unknown', 'KBrowser.handoffStatus got no answer')), q.timeoutMs ?? 30_000);
  }));
  const t0 = Date.now();
  const w = parse(await s.call('needs_human', { action: 'wait', handoff: 'h1', timeoutMs: 1000 }));
  const took = Date.now() - t0;
  assert.deepEqual([w.isError, w.head.state], [false, 'waiting'], w.text);
  assert.ok(took < 1100, `${took} ms: never past the wait`);
  assert.ok(asked.length >= 2, 'asked again after a question got no answer');
  assert.ok(asked.every((q) => typeof q.timeoutMs === 'number' && q.timeoutMs <= 200), JSON.stringify(asked.map((q) => q.timeoutMs)));

  // with the real question length (5 s): the last question gets only what is left of the wait
  const slow = setup((n, _p) => new Promise((_, reject) => {
    setTimeout(() => reject(new SdkError('result_unknown', 'no answer')), slow.asked[n - 1].timeoutMs ?? 30_000);
  }), { name: 'slow' });
  slow.s.waitTiming = { pollMs: 300, queryMs: 5000, progressMs: 15_000 };
  const t1 = Date.now();
  const w2 = parse(await slow.s.call('needs_human', { action: 'wait', handoff: 'h1', timeoutMs: 1200 }));
  assert.equal(w2.head.state, 'waiting');
  assert.ok(Date.now() - t1 < 1300, `${Date.now() - t1} ms`);
  assert.ok(slow.asked.every((q) => /** @type {number} */ (q.timeoutMs) <= 1200), JSON.stringify(slow.asked.map((q) => q.timeoutMs)));
});

test('cancelled while a question is still out: wait stops at once, and asks nothing more', async () => {
  const { s, asked } = setup(() => new Promise(() => {})); // never answers
  const ac = new AbortController();
  const t0 = Date.now();
  const r = s.call('needs_human', { action: 'wait', handoff: 'h1', timeoutMs: 10_000 }, ac.signal);
  await sleep(100);
  ac.abort();
  const w = parse(await r);
  assert.ok(Date.now() - t0 < 500, 'stopped at the cancellation, not at the question\'s timeout');
  assert.deepEqual([w.isError, w.head.error], [true, 'cancelled']);
  const n = asked.length;
  await sleep(200);
  assert.equal(asked.length, n, 'no question after the cancellation');
});

test('cancelled between questions: stops during the pause', async () => {
  const { s, asked } = setup(() => waiting);
  s.waitTiming = { pollMs: 1000, queryMs: 200, progressMs: 50 };
  const ac = new AbortController();
  const r = s.call('needs_human', { action: 'wait', handoff: 'h1', timeoutMs: 10_000 }, ac.signal);
  await sleep(100);
  ac.abort();
  const t0 = Date.now();
  const w = parse(await r);
  assert.ok(Date.now() - t0 < 200);
  assert.equal(w.head.error, 'cancelled');
  assert.equal(asked.length, 1);
});

test('progress: every progressMs with the agent\'s own token and a rising count; none without a token, none after the end', async () => {
  /** @type {any[]} */ const sent = [];
  const notify = async (/** @type {any} */ n) => { sent.push(n); };
  const { s } = setup(() => waiting);
  await s.call('needs_human', { action: 'wait', handoff: 'h1', timeoutMs: 1000 }, undefined, { token: 'tok-7', notify });
  assert.ok(sent.length >= 3, `${sent.length} notifications`);
  assert.ok(sent.every((n) => n.method === 'notifications/progress' && n.params.progressToken === 'tok-7'));
  assert.deepEqual(sent.map((n) => n.params.progress), sent.map((_, i) => i + 1));
  const after = sent.length;
  await sleep(200);
  assert.equal(sent.length, after, 'nothing after the wait answered');

  sent.length = 0;
  await s.call('needs_human', { action: 'wait', handoff: 'h1', timeoutMs: 1000 }, undefined, { token: undefined, notify });
  assert.equal(sent.length, 0, 'no token, no progress');

  const ac = new AbortController();
  const r = s.call('needs_human', { action: 'wait', handoff: 'h1', timeoutMs: 5000 }, ac.signal, { token: 1, notify });
  await sleep(120);
  ac.abort();
  await r;
  const atCancel = sent.length;
  await sleep(200);
  assert.equal(sent.length, atCancel, 'nothing after a cancellation');
});

test('defaults by client, as measured: Codex 280 s (it cuts at 300 s), Claude Code until the hand-off ends, others 50 s', () => {
  assert.equal(handoffWaitDefault('codex'), 280_000);
  assert.equal(handoffWaitDefault('claude-code'), 30 * 60_000);
  for (const n of ['antigravity', 'gemini-cli', 'kav', 'toString', '__proto__']) assert.equal(handoffWaitDefault(n), 50_000, n);
});

test('start answers with tell_user for the user and next for the agent', async () => {
  const text = fs.readFileSync(new URL('../src/mcp/server.js', import.meta.url), 'utf8');
  assert.match(text, /tell_user: TELL_USER, next: HANDOFF_NEXT/);
  const { TOOLS } = await import('../src/mcp/tools.js');
  const nh = /** @type {any} */ (TOOLS.find((t) => t.name === 'needs_human'));
  assert.deepEqual(nh.inputSchema.properties.action.enum, ['start', 'wait', 'status', 'cancel']);
  assert.match(nh.description, /call wait in the same turn/);
});
