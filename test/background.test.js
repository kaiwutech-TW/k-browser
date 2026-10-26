// @ts-check
// The real extension/background.js, run against the real bridge and against a scripted bridge, for the parts the
// protocol-level fakes cannot see: per-socket replies, handshake ordering, debugger cleanup.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { WebSocketServer } from 'ws';
import { mac, PROTOCOL, randomHex, transcript } from '../extension/protocol.js';
import * as auth from '../src/auth.js';
import { startBridge } from '../src/server.js';
import { ChromeHarness, EXT_ID } from './chrome-harness.js';
import { FakeCdp, OPEN, sleep, until } from './fakes.js';

/** @type {(() => Promise<void>)[]} */
let cleanups = [];

beforeEach(() => {
  process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bg-'));
  cleanups = [];
});

afterEach(async () => {
  while (OPEN.length) await /** @type {any} */ (OPEN.pop()).close();
  for (const c of cleanups.reverse()) await c();
});

/** @param {ConstructorParameters<typeof ChromeHarness>[0]} o */
function worker(o) {
  const h = new ChromeHarness(o).start();
  cleanups.push(() => h.stop());
  return h;
}

async function realBridge() {
  const b = await startBridge({ port: 0, revokePollMs: 50, log: () => {} });
  cleanups.push(() => b.close());
  return b;
}

/**
 * A scripted bridge: does the handshake (proving the key, or not), then lets the test send commands and see every
 * message the extension sends, per connection.
 * @param {string} key @param {{ impostor?: boolean }} [o]
 */
async function scriptedBridge(key, { impostor = false } = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  /** @type {{ ws: import('ws').WebSocket, seen: any[], authed: boolean }[]} */
  const conns = [];
  wss.on('connection', (ws) => {
    const conn = { ws, seen: /** @type {any[]} */ ([]), authed: false };
    conns.push(conn);
    const bnonce = randomHex(16);
    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL, nonce: bnonce }));
    ws.on('message', async (d) => {
      const m = JSON.parse(d.toString());
      conn.seen.push(m);
      if (m.t === 'hello' && !conn.authed) {
        const script = transcript(bnonce, m.nonce);
        conn.authed = true;
        ws.send(JSON.stringify({ t: 'welcome', mac: impostor ? 'f'.repeat(64) : await mac(key, 'bridge', script) }));
      }
    });
  });
  const address = /** @type {import('node:net').AddressInfo} */ (wss.address());
  cleanups.push(async () => { for (const c of wss.clients) c.terminate(); await new Promise((r) => wss.close(r)); });
  let ids = 1000;
  return {
    port: address.port,
    conns,
    /** @param {number} i @param {string} op @param {Record<string, any>} [args] */
    send(i, op, args = {}) {
      const id = ++ids;
      conns[i].ws.send(JSON.stringify({ t: 'cmd', id, op, args }));
      return id;
    },
    /** @param {number} i @param {number} id */
    reply(i, id) {
      return conns[i].seen.find((m) => m.t === 'res' && m.id === id);
    },
  };
}

// ---------- end to end with the real bridge ----------

test('the real extension pairs, reconciles and forwards a Kav-style session', async () => {
  const b = await realBridge();
  const h = worker({ port: b.port, pairKey: /** @type {string} */ (auth.pairKey({ create: true })) });
  assert.ok(await until(() => b.relay.ext !== null, 3000), 'extension ready');
  assert.equal(h.local.status.state, 'online');
  const cdp = await new FakeCdp(b.base, auth.addClient('kav')).connect();
  const { targetId } = await cdp.call('Target.createTarget', { url: 'https://example.com/', background: true });
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
  const r = await cdp.call('Runtime.evaluate', { expression: '1+1' }, sessionId);
  assert.equal(r.method, 'Runtime.evaluate');
  assert.ok(h.calls.some((c) => c[0] === 'sendCommand' && c[2] === 'Runtime.evaluate'));
  // a debugger event on the owned tab reaches the session
  const tabId = [...h.tabs.keys()].find((id) => h.tabs.get(id)?.id === targetId);
  h.ev.debuggerEvent.fire({ tabId }, 'Runtime.consoleAPICalled', { n: 1 });
  assert.ok(await until(() => cdp.named('Runtime.consoleAPICalled').some((e) => e.sessionId === sessionId)));
});

test('a command right behind welcome is not lost while the welcome MAC is being checked', async () => {
  const b = await realBridge();
  const h = new ChromeHarness({ port: b.port, pairKey: /** @type {string} */ (auth.pairKey({ create: true })) });
  const hold = h.holdSign(2); // sign #1 proves the extension; #2 checks the bridge's welcome
  h.start();
  cleanups.push(() => h.stop());
  assert.ok(await until(() => hold.entered, 3000), 'welcome verification is in progress');
  assert.ok(await until(() => h.received.some((m) => m.t === 'cmd')), "the bridge's first command arrived meanwhile");
  hold.release();
  assert.ok(await until(() => b.relay.ext !== null, 3000), 'own.sync was answered, so reconciliation completed');
});

test('a wrong pairing code never goes online', async () => {
  const b = await realBridge();
  auth.pairKey({ create: true });
  const h = worker({ port: b.port, pairKey: 'not-the-code' });
  assert.ok(await until(() => h.local.status?.state === 'error', 3000));
  assert.equal(b.relay.ext, null);
});

// ---------- against a scripted bridge ----------

test('an impostor bridge (no pairing key) gets no command answered', async () => {
  const key = 'k'.repeat(43);
  const fake = await scriptedBridge(key, { impostor: true });
  const h = worker({ port: fake.port, pairKey: key });
  assert.ok(await until(() => fake.conns.length === 1 && fake.conns[0].seen.some((m) => m.t === 'hello')));
  const id = fake.send(0, 'tabs.alive', { tabIds: [1] });
  await sleep(100);
  assert.equal(fake.reply(0, id), undefined);
  assert.ok(await until(() => h.local.status?.state === 'error'));
});

test("an old command's result never leaves through a newer, unauthenticated socket", async () => {
  const key = 'k'.repeat(43);
  const fake = await scriptedBridge(key);
  const h = worker({ port: fake.port, pairKey: key });
  assert.ok(await until(() => h.local.status?.state === 'online'));
  /** @type {(v?: any) => void} */
  let release = () => {};
  h.gates.set('Runtime.evaluate', new Promise((r) => { release = r; }));
  const tab = h.addTab('https://example.com/');
  h.attachedBy.set(tab, 'self');
  const id = fake.send(0, 'dbg.send', { tabId: tab, method: 'Runtime.evaluate', params: {} });
  assert.ok(await until(() => h.calls.some((c) => c[0] === 'sendCommand')));
  fake.conns[0].ws.close(); // the bridge goes away with the command in flight
  await h.reconnect();
  assert.ok(await until(() => fake.conns.length === 2 && fake.conns[1].seen.some((m) => m.t === 'hello')));
  release(); // the old command finishes now
  await sleep(100);
  assert.ok(!fake.conns[1].seen.some((m) => m.t === 'res'), 'nothing but the handshake on the new socket');
  assert.equal(fake.reply(0, id), undefined);
});

test("own.sync detaches every tab it left attached, even ones the bridge forgot, and never someone else's", async () => {
  const key = 'k'.repeat(43);
  const fake = await scriptedBridge(key);
  const h = worker({ port: fake.port, pairKey: key });
  assert.ok(await until(() => h.local.status?.state === 'online'));
  const t1 = h.addTab();
  const t2 = h.addTab();
  const devtools = h.addTab();
  h.attachedBy.set(t1, 'self');
  h.attachedBy.set(t2, 'self');
  h.attachedBy.set(devtools, 'other');
  const id = fake.send(0, 'own.sync', { tabIds: [t2, 999] });
  assert.ok(await until(() => fake.reply(0, id) !== undefined));
  assert.equal(fake.reply(0, id).ok, true);
  assert.deepEqual(fake.reply(0, id).result, { missing: [999] });
  assert.deepEqual([...h.attachedBy], [[devtools, 'other']]);
});

test("a retired socket's queued command never runs after a reconnect", async () => {
  const key = 'k'.repeat(43);
  const fake = await scriptedBridge(key);
  const h = new ChromeHarness({ port: fake.port, pairKey: key });
  const hold = h.holdSign(2); // the first socket's welcome check
  h.start();
  cleanups.push(() => h.stop());
  assert.ok(await until(() => hold.entered && fake.conns.length === 1 && fake.conns[0].authed));
  const tab = h.addTab('https://example.com/');
  fake.send(0, 'tabs.close', { tabId: tab }); // queued behind the welcome check on the old socket
  assert.ok(await until(() => h.received.some((m) => m.t === 'cmd' && m.op === 'tabs.close')), 'the command reached the worker');
  await h.reconnect();
  assert.ok(await until(() => fake.conns.length === 2 && h.local.status?.state === 'online'));
  hold.release(); // the old welcome check finishes; its queued command must not run
  await sleep(100);
  assert.ok(h.tabs.has(tab), 'the old socket closed nothing');
  assert.ok(!fake.conns[0].seen.some((m) => m.t === 'res'));
});

test('only owned tabs are reported: popups the owned page opened, not tabs that merely inherit it as opener', async () => {
  const key = 'k'.repeat(43);
  const fake = await scriptedBridge(key);
  const h = worker({ port: fake.port, pairKey: key });
  assert.ok(await until(() => h.local.status?.state === 'online'));
  const mine = h.addTab();
  const theirs = h.addTab('https://bank.example/');
  const id = fake.send(0, 'own', { tabId: mine, owned: true });
  assert.ok(await until(() => fake.reply(0, id) !== undefined));
  h.ev.tabUpdated.fire(theirs, { url: 'https://bank.example/inbox' }, { url: 'https://bank.example/inbox', title: 'Inbox' });
  h.ev.debuggerEvent.fire({ tabId: theirs }, 'Network.requestWillBeSent', {});
  h.ev.tabCreated.fire({ id: 50, openerTabId: theirs });
  h.ev.tabCreated.fire({ id: 51, openerTabId: mine }); // Ctrl+T in an owned tab's window: Chrome still sets openerTabId
  h.ev.createdNavigationTarget.fire({ sourceTabId: theirs, sourceFrameId: 0, tabId: 52, url: 'https://bank.example/x' });
  h.ev.createdNavigationTarget.fire({ sourceTabId: mine, sourceFrameId: 0, tabId: 53, url: 'https://example.com/popup' });
  h.ev.tabReplaced.fire(60, mine);
  assert.ok(await until(() => fake.conns[0].seen.some((m) => m.ev === 'tab.replaced')));
  const events = fake.conns[0].seen.filter((m) => m.t === 'ev');
  assert.deepEqual(events, [
    { t: 'ev', ev: 'tab.created', tabId: 53, openerTabId: mine }, // only a popup the owned page itself opened
    { t: 'ev', ev: 'tab.replaced', addedTabId: 60, removedTabId: mine },
  ]);
});

test('a popup closed while its adoption is in flight is reported and never registered', async () => {
  const b = await realBridge();
  const h = worker({ port: b.port, pairKey: /** @type {string} */ (auth.pairKey({ create: true })) });
  assert.ok(await until(() => b.relay.ext !== null, 3000));
  const cdp = await new FakeCdp(b.base, auth.addClient('kav')).connect();
  const { targetId } = await cdp.call('Target.createTarget', { url: 'https://example.com/', background: true });
  const opener = /** @type {number} */ ([...h.tabs].find(([, t]) => t.id === targetId)?.[0]);
  const popup = h.addTab('https://example.com/popup');
  /** @type {() => void} */
  let release = () => {};
  // The worker answers tabs.get for the popup (a valid answer, computed while the tab existed), but that answer is
  // held in flight; the popup then closes and the removal event overtakes it.
  const isPopupGet = (/** @type {any} */ m) => m.t === 'res' && h.received.some((c) => c.t === 'cmd' && c.id === m.id && c.op === 'tabs.get' && c.args.tabId === popup);
  h.outHold = { match: isPopupGet, gate: new Promise((r) => { release = () => r(undefined); }), held: false };
  h.ev.createdNavigationTarget.fire({ sourceTabId: opener, sourceFrameId: 0, tabId: popup, url: 'https://example.com/popup' });
  assert.ok(await until(() => h.outHold?.held === true), 'the stale answer is in flight');
  h.tabs.delete(popup);
  h.ev.tabRemoved.fire(popup);
  await sleep(30);
  release();
  await sleep(50);
  assert.equal(b.relay.byTab.has(popup), false);
});

test('a replaced owned tab stays watched: its replacement closing before adoption is reported (p1a-2 ①)', async () => {
  const b = await realBridge();
  const h = worker({ port: b.port, pairKey: /** @type {string} */ (auth.pairKey({ create: true })) });
  assert.ok(await until(() => b.relay.ext !== null, 3000));
  const cdp = await new FakeCdp(b.base, auth.addClient('kav')).connect();
  const { targetId } = await cdp.call('Target.createTarget', { url: 'https://example.com/', background: true });
  const old = /** @type {number} */ ([...h.tabs].find(([, t]) => t.id === targetId)?.[0]);
  const fresh = h.addTab('https://example.com/');
  /** @type {() => void} */
  let release = () => {};
  h.getTargetsGate = new Promise((r) => { release = () => r(undefined); }); // the adoption's targetId lookup is slow
  h.tabs.delete(old);
  h.ev.tabReplaced.fire(fresh, old);
  assert.ok(await until(() => h.received.some((m) => m.t === 'cmd' && m.op === 'tabs.get' && m.args.tabId === fresh)));
  h.tabs.delete(fresh);
  h.ev.tabRemoved.fire(fresh); // the replacement closes while the bridge is still adopting it
  release();
  await sleep(100);
  assert.equal(b.relay.byTab.has(fresh), false, 'no ghost target');
});

test('an attempt still reading old settings cannot override a newer connection (p1a-2 ②)', async () => {
  const key = 'k'.repeat(43);
  const oldBridge = await scriptedBridge(key);
  const newBridge = await scriptedBridge(key);
  const h = new ChromeHarness({ port: oldBridge.port, pairKey: key });
  /** @type {(() => void)[]} */
  const releases = [];
  const gate = () => new Promise((r) => { releases.push(() => r(undefined)); });
  h.storageGetGates.push(/** @type {any} */ (gate()), /** @type {any} */ (gate())); // the first two settings reads are slow
  h.start();
  cleanups.push(() => h.stop());
  await sleep(30);
  await h.chrome.storage.local.set({ port: newBridge.port }); // a new attempt starts; its read is held too
  await sleep(30);
  releases[0](); // the stale attempt's read (old port) answers first, while nothing is connected yet
  await sleep(100);
  releases[1](); // then the new attempt's read (new port)
  assert.ok(await until(() => h.local.status?.state === 'online' && newBridge.conns.length === 1));
  await sleep(150);
  assert.equal(oldBridge.conns.length, 0, 'the stale attempt never connected');
  assert.equal(newBridge.conns[0].ws.readyState, 1, 'the newer connection is still the one');
});

test("input and screenshots first restore the tab's window if it was minimized", async () => {
  const key = 'k'.repeat(43);
  const fake = await scriptedBridge(key);
  const h = worker({ port: fake.port, pairKey: key });
  assert.ok(await until(() => h.local.status?.state === 'online'));
  const tab = h.addTab('https://example.com/');
  h.attachedBy.set(tab, 'self');
  h.windows.set(1, { state: 'minimized' }); // the user minimized the K-Browser window after the session was set up
  const id = fake.send(0, 'dbg.send', { tabId: tab, method: 'Page.captureScreenshot', params: {} });
  assert.ok(await until(() => fake.reply(0, id) !== undefined));
  assert.equal(fake.reply(0, id).ok, true);
  const order = h.calls.filter((c) => c[0] === 'windows.update' || c[0] === 'sendCommand').map((c) => c[0]);
  assert.deepEqual(order, ['windows.update', 'sendCommand'], 'restored before the command ran');
  // (compared as JSON: the object comes from the worker's VM realm)
  assert.equal(JSON.stringify(h.calls.find((c) => c[0] === 'windows.update')?.[2]), JSON.stringify({ state: 'normal', focused: false }));
  const id2 = fake.send(0, 'dbg.send', { tabId: tab, method: 'Runtime.evaluate', params: {} });
  assert.ok(await until(() => fake.reply(0, id2) !== undefined));
  assert.equal(h.calls.filter((c) => c[0] === 'windows.update').length, 1, 'commands that need no rendering do not touch windows');
});

test('the K-Browser window is never focused, even for an active tab or activateTarget', async () => {
  const key = 'k'.repeat(43);
  const fake = await scriptedBridge(key);
  const h = worker({ port: fake.port, pairKey: key });
  assert.ok(await until(() => h.local.status?.state === 'online'));
  const first = fake.send(0, 'tabs.create', { url: 'https://example.com/', active: true, windowId: null });
  assert.ok(await until(() => fake.reply(0, first) !== undefined));
  assert.equal(fake.reply(0, first).ok, true);
  // (compared as JSON: the object comes from the worker's VM realm)
  assert.equal(JSON.stringify(h.calls.find((c) => c[0] === 'windows.create')?.[1].focused), 'false', 'a new window opens unfocused');
  const second = fake.send(0, 'tabs.create', { url: 'https://example.org/', active: true, windowId: 1 });
  assert.ok(await until(() => fake.reply(0, second) !== undefined));
  const tabId = fake.reply(0, second).result.tabId;
  const act = fake.send(0, 'tabs.activate', { tabId });
  assert.ok(await until(() => fake.reply(0, act) !== undefined));
  assert.equal(fake.reply(0, act).ok, true);
  assert.ok(!h.calls.some((c) => c[0] === 'windows.update' && c[2]?.focused), 'no call ever focuses the window');
});

test('panel commands: only well-typed fields go on to the bridge; forged, oversized or ill-typed ones and eval on are dropped', async () => {
  const key = 'k'.repeat(43);
  const fake = await scriptedBridge(key);
  const h = worker({ port: fake.port, pairKey: key });
  assert.ok(await until(() => h.local.status?.state === 'online'));
  /** @type {(m: any) => void} */ let post = () => {};
  h.ev.runtimeConnect.fire({ name: 'panel', sender: { id: EXT_ID, url: `chrome-extension://${EXT_ID}/panel.html` }, disconnect() {}, postMessage() {},
    onMessage: { addListener: (/** @type {any} */ f) => { post = f; } }, onDisconnect: { addListener() {} } });
  const P = 'a'.repeat(24);
  for (const m of [
    { op: 'decisionLog', on: 'on' },
    { op: 'decisionLog' },
    { op: 'sites', name: 'agent', principal: P, category: 'banking', on: 'true' },
    { op: 'sites', name: 'agent', principal: P, on: true },
    { op: 'sites', name: 'agent', principal: P, category: { toString: 'banking' }, on: true },
    { op: 'sites', name: 'a'.repeat(33), principal: P, category: 'banking', on: true },
    { op: 'sites', name: 'agent', principal: P, category: 'b'.repeat(33), on: true },
    { op: 'sites', name: '', principal: P, category: 'banking', on: true },
    { op: 'screenshot', name: ['agent'], principal: P, on: false },
    { op: 'screenshot', name: 'agent', principal: 'p'.repeat(65), on: false },
    { op: 'screenshot', name: 'agent', on: false },
    { op: 'eval', name: 'agent', principal: P, on: true },
    { op: 'eval', name: 'agent', principal: P, on: 'false' },
    { op: 'blockedOrigins', name: 'agent', principal: P, value: ['x'] },
  ]) post({ type: 'cmd', ...m });
  post({ type: 'cmd', op: 'decisionLog', on: true, extra: 'x' });
  post({ type: 'cmd', op: 'sites', name: 'agent', principal: P, category: 'banking', on: false, blockedOrigins: ['x'], token: 't' });
  post({ type: 'cmd', op: 'screenshot', name: 'agent', principal: P, on: true, category: 'banking' });
  post({ type: 'cmd', op: 'eval', name: 'agent', principal: P, on: false, eval: true });
  const sent = () => fake.conns[0].seen.filter((m) => m.t === 'ev' && m.ev === 'panel.cmd');
  assert.ok(await until(() => sent().length === 4));
  await sleep(100);
  assert.deepEqual(sent().map(({ t: _t, ev: _e, ...rest }) => rest), [
    { op: 'decisionLog', on: true },
    { op: 'sites', name: 'agent', principal: P, on: false, category: 'banking' },
    { op: 'screenshot', name: 'agent', principal: P, on: true },
    { op: 'eval', name: 'agent', principal: P, on: false },
  ]);
});

test('a title the page set while its tab was being created reaches the bridge (the update itself came before the tab was owned)', async () => {
  const key = 'k'.repeat(43);
  const fake = await scriptedBridge(key);
  const h = worker({ port: fake.port, pairKey: key });
  assert.ok(await until(() => h.local.status?.state === 'online'));
  // a fast page: its title is set (and onUpdated fires) before chrome.tabs.create has answered the worker
  const create = h.chrome.tabs.create;
  h.chrome.tabs.create = async (/** @type {any} */ o) => {
    const t = await create(o);
    /** @type {any} */ (h.tabs.get(t.id)).title = 'loaded title';
    h.ev.tabUpdated.fire(t.id, { title: 'loaded title' }, { ...t, title: 'loaded title' });
    return t;
  };
  const id = fake.send(0, 'tabs.create', { url: 'https://example.com/', active: true, windowId: 1 });
  assert.ok(await until(() => fake.reply(0, id) !== undefined));
  assert.equal(fake.reply(0, id).result.title, 'loaded title');
  assert.ok(!fake.conns[0].seen.some((m) => m.t === 'ev' && m.ev === 'tab.updated'), 'not owned yet when it fired: not reported, so only the answer can carry it');
});
