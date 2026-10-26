// @ts-check
// Hand-offs to the user (src/handoff.js) — the state machine, and through the bridge with a fake extension:
// KBrowser.handoff / handoffStatus / cancelHandoff / tabHandoff, the extension's list, "交還", and invalidation.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import * as auth from '../src/auth.js';
import { Handoffs, REASON_MAX } from '../src/handoff.js';
import { startBridge } from '../src/server.js';
import { FakeCdp, FakeExtension, OPEN, sleep, until } from './fakes.js';

const T1 = { targetId: 'T1', tabId: 1 };

test('every state change: waiting -> returned / cancelled / expired / invalidated; ended ones stay ended', () => {
  let now = 1000;
  let changes = 0;
  const h = new Handoffs({ ttlMs: 60_000, now: () => now, changed: () => { changes += 1; } });
  const a = h.request('alice', T1, '  log in please  ');
  assert.deepEqual([a.state, a.reason, a.source, a.existing], ['waiting', 'log in please', 'client', false]);
  assert.equal(h.request('alice', T1, 'again').handoffId, a.handoffId, 'one waiting hand-off per tab');
  assert.equal(h.request('alice', T1, 'again').existing, true);
  assert.deepEqual(h.waiting().map((x) => x.handoffId), [a.handoffId]);
  assert.ok(h.returned(a.handoffId, () => 'https://a.test/after'));
  assert.deepEqual([h.get('alice', a.handoffId)?.state, h.get('alice', a.handoffId)?.url], ['returned', 'https://a.test/after']);
  assert.equal(h.returned(a.handoffId, () => 'x'), false, 'returned once');
  assert.equal(h.cancel('alice', a.handoffId)?.state, 'returned', 'an ended hand-off does not change any more');

  const b = h.request('alice', T1, 'b');
  assert.equal(h.cancel('alice', b.handoffId)?.state, 'cancelled');
  const c = h.request('alice', T1, 'c');
  now += 60_000;
  assert.equal(h.get('alice', c.handoffId)?.state, 'expired');
  assert.equal(h.returned(c.handoffId, () => 'x'), false, 'too late to return');
  const d = h.request('alice', T1, 'd');
  h.invalidate((x) => x.targetId === 'T1', 'the tab was closed');
  assert.deepEqual([h.get('alice', d.handoffId)?.state, h.get('alice', d.handoffId)?.why], ['invalidated', 'the tab was closed']);
  assert.ok(changes >= 6, 'the extension hears of every change');
  h.close();
});

test('a reason is required, kept short, and one owner never sees another\'s hand-off', () => {
  const h = new Handoffs();
  assert.throws(() => h.request('alice', T1, ''), /reason/);
  assert.throws(() => h.request('alice', T1, 42), /reason/);
  const a = h.request('alice', T1, 'x'.repeat(500));
  assert.equal(a.reason.length, REASON_MAX);
  assert.equal(h.get('bob', a.handoffId), null);
  assert.equal(h.cancel('bob', a.handoffId), null);
  assert.equal(h.waitingFor('bob', 'T1'), null);
  assert.equal(h.get('alice', a.handoffId)?.state, 'waiting', 'bob changed nothing');
  h.close();
});

test('ids are random: a restarted bridge never hands out an id a client still holds', () => {
  const before = new Handoffs().request('alice', T1, 'x').handoffId;
  const after = new Handoffs().request('alice', T1, 'x').handoffId;
  assert.match(before, /^h[0-9a-f]{16}$/);
  assert.notEqual(before, after);
});

test('expiry happens on its own: the extension\'s list empties without anyone asking', async () => {
  let synced = 0;
  const h = new Handoffs({ ttlMs: 50, changed: () => { synced += 1; } });
  h.request('alice', T1, 'x');
  const before = synced;
  await sleep(120);
  assert.equal(h.waiting().length, 0);
  assert.ok(synced > before, 'the timer told the extension');
  h.close();
});

// ---------- through the bridge ----------

/** @type {Awaited<ReturnType<typeof startBridge>>} */ let bridge;

beforeEach(async () => {
  process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-handoff-'));
  bridge = await startBridge({ port: 0, log: () => {}, revokePollMs: 50 });
});
afterEach(async () => {
  while (OPEN.length) await /** @type {any} */ (OPEN.pop()).close();
  await bridge.close();
});

async function setUp(boot = 'boot-aaaaaaaa') {
  const ext = new FakeExtension(bridge.base, /** @type {string} */ (auth.pairKey({ create: true })), { boot });
  assert.ok(await ext.connect());
  assert.ok(await until(() => bridge.relay.ext !== null));
  const cdp = await new FakeCdp(bridge.base, auth.addClient('me')).connect();
  const { targetId } = await cdp.call('Target.createTarget', { url: 'https://a.test/', background: true });
  const tabId = /** @type {number} */ ([...bridge.relay.byTab.keys()][0]);
  return { ext, cdp, targetId, tabId };
}

test('bridge: a hand-off shows in the extension; "交還" there returns it with the URL the user left; the extension list empties', async () => {
  const { ext, cdp, targetId, tabId } = await setUp();
  const h = await cdp.call('KBrowser.handoff', { targetId, reason: 'solve the captcha' });
  assert.deepEqual([h.state, h.source, h.reason], ['waiting', 'client', 'solve the captcha']);
  assert.ok(await until(() => ext.handoffs.length === 1));
  assert.deepEqual([ext.handoffs[0].handoffId, ext.handoffs[0].tabId], [h.handoffId, tabId]);
  assert.equal((await cdp.call('KBrowser.tabHandoff', { targetId })).handoffId, h.handoffId);
  ext.event('tab.updated', { tabId, url: 'https://a.test/done', title: 'done' });
  ext.event('handoff.return', { handoffId: h.handoffId });
  await sleep(50);
  const s = await cdp.call('KBrowser.handoffStatus', { handoffId: h.handoffId });
  assert.deepEqual([s.state, s.url], ['returned', 'https://a.test/done']);
  assert.equal((await cdp.call('KBrowser.tabHandoff', { targetId })).handoffId, null);
  assert.ok(await until(() => ext.handoffs.length === 0));
});

test('bridge: cancel; a closed tab, a revoked client, and an extension restart invalidate; unknown ids read as invalidated', async () => {
  const { ext, cdp, targetId, tabId } = await setUp();
  // a second tab first (the fake extension would reuse a closed tab's id)
  const { targetId: t2 } = await cdp.call('Target.createTarget', { url: 'https://a.test/2', background: true });
  const a = await cdp.call('KBrowser.handoff', { targetId, reason: 'a' });
  assert.equal((await cdp.call('KBrowser.cancelHandoff', { handoffId: a.handoffId })).state, 'cancelled');

  const b = await cdp.call('KBrowser.handoff', { targetId, reason: 'b' });
  ext.tabs.delete(tabId);
  ext.event('tab.removed', { tabId });
  await sleep(50);
  const sb = await cdp.call('KBrowser.handoffStatus', { handoffId: b.handoffId });
  assert.deepEqual([sb.state, sb.why], ['invalidated', 'the tab was closed']);

  assert.deepEqual((await cdp.call('KBrowser.handoffStatus', { handoffId: 'h999' })).state, 'invalidated');
  await assert.rejects(cdp.call('KBrowser.handoff', { targetId: 'nope', reason: 'x' }));
  await assert.rejects(cdp.call('KBrowser.handoff', { targetId, reason: 'x' }), 'the tab is gone');

  // another client cannot see or cancel it
  const c = await cdp.call('KBrowser.handoff', { targetId: t2, reason: 'c' });
  const other = await new FakeCdp(bridge.base, auth.addClient('other')).connect();
  assert.equal((await other.call('KBrowser.handoffStatus', { handoffId: c.handoffId })).state, 'invalidated');
  assert.equal((await other.call('KBrowser.cancelHandoff', { handoffId: c.handoffId })).state, 'invalidated');
  await assert.rejects(other.call('KBrowser.tabHandoff', { targetId: t2 }));
  assert.equal((await cdp.call('KBrowser.handoffStatus', { handoffId: c.handoffId })).state, 'waiting');
  // the extension restarts (a new lifetime): every waiting hand-off is invalidated
  await ext.close();
  const ext2 = new FakeExtension(bridge.base, /** @type {string} */ (auth.pairKey()), { boot: 'boot-bbbbbbbb' });
  assert.ok(await ext2.connect());
  assert.ok(await until(() => bridge.relay.ext !== null && bridge.relay.bootId === 'boot-bbbbbbbb'));
  const sc = await cdp.call('KBrowser.handoffStatus', { handoffId: c.handoffId });
  assert.deepEqual([sc.state, sc.why], ['invalidated', 'the extension restarted']);
});

test('bridge: removing the client invalidates its hand-offs', async () => {
  const { cdp, targetId } = await setUp();
  const h = await cdp.call('KBrowser.handoff', { targetId, reason: 'x' });
  auth.removeClient('me');
  assert.ok(await until(() => bridge.relay.handoffs.get(/** @type {any} */ ([...bridge.relay.handoffs.items.values()][0]).owner, h.handoffId)?.state === 'invalidated', 2000));
  assert.equal([...bridge.relay.handoffs.items.values()][0].why, 'the client was revoked');
});
