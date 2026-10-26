// @ts-check
// The bridge with a fake extension: authentication, ownership, method policy, session model, reconnect
// identity, revocation and failure semantics.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import WebSocket from 'ws';
import { mac, transcript } from '../extension/protocol.js';
import * as auth from '../src/auth.js';
import { CdpConn, ExtensionLink } from '../src/relay.js';
import { startBridge } from '../src/server.js';
import { FakeCdp, FakeExtension, OPEN, sleep, until } from './fakes.js';

/** @type {Awaited<ReturnType<typeof startBridge>>} */
let bridge;
/** @type {string[]} */
let logs;

beforeEach(async () => {
  process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
  logs = [];
  bridge = await startBridge({ port: 0, revokePollMs: 50, log: (l) => logs.push(l) });
});

afterEach(async () => {
  while (OPEN.length) await /** @type {any} */ (OPEN.pop()).close();
  await bridge.close();
});

const key = () => /** @type {string} */ (auth.pairKey({ create: true }));

/** @param {ConstructorParameters<typeof FakeExtension>[2]} [o] */
async function online(o) {
  const ext = new FakeExtension(bridge.base, key(), o);
  assert.ok(await ext.connect());
  assert.ok(await until(() => bridge.relay.ext !== null));
  return ext;
}

const client = (name = 'kav') => new FakeCdp(bridge.base, auth.addClient(name)).connect();

/** @param {FakeCdp} cdp */
async function openTab(cdp, url = 'https://example.com/') {
  const { targetId } = await cdp.call('Target.createTarget', { url, background: true });
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
  return { targetId, sessionId };
}

const firstTab = () => /** @type {number} */ ([...bridge.relay.byTab.keys()][0]);

/** @param {string} p @param {Record<string, string>} [headers] */
const get = (p, headers = {}) => fetch(bridge.base + p, { headers });

// ---------- extension authentication ----------

test('handshake: both sides prove the pairing key', async () => {
  const ext = await online();
  assert.ok(ext.bridgeProved);
});

test('wrong pairing key is rejected', async () => {
  key();
  const ext = new FakeExtension(bridge.base, 'not-the-key');
  assert.equal(await ext.connect(), false);
  assert.equal(ext.error.code, 'auth');
  assert.equal(bridge.relay.ext, null);
});

test('another extension origin is rejected', async () => {
  key();
  const ws = new WebSocket(`${bridge.base.replace('http', 'ws')}/ext`, { headers: { Origin: 'chrome-extension://someoneelse' } });
  const status = await new Promise((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)));
  assert.equal(status, 403);
});

test('a MAC from another handshake is rejected', async () => {
  const replay = await mac(key(), 'ext', transcript('old-bridge-nonce', 'e'.repeat(8) + '0123456789abcdef'));
  const ext = new FakeExtension(bridge.base, key());
  assert.equal(await ext.connect({ macOverride: replay }), false);
  assert.equal(ext.error.code, 'auth');
});

test('a second Chrome profile is rejected', async () => {
  const a = await online({ profile: 'profile-aaaaaaaa' });
  await a.close();
  const b = new FakeExtension(bridge.base, key(), { profile: 'profile-bbbbbbbb' });
  assert.equal(await b.connect(), false);
  assert.equal(b.error.code, 'profile');
});

// ---------- discovery and HTTP guards ----------

test('discovery needs a valid token and no Origin; answers are no-store', async () => {
  const token = auth.addClient('kav');
  const r = await get(`/c/${token}/json/version`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const body = await r.json();
  assert.ok(body.webSocketDebuggerUrl.endsWith(`/c/${token}/devtools/browser/k-browser`));
  assert.equal(body['K-Browser-Extension'], 'offline');
  assert.equal((await get('/c/wrong/json/version')).status, 404);
  assert.equal((await get('/c/%E4%B8%AD/json/version')).status, 404);
  assert.equal((await get(`/c/${token}/json/version`, { Origin: 'https://evil.example' })).status, 404);
});

test('a non-loopback Host is refused (DNS rebinding)', async () => {
  const token = auth.addClient('kav');
  const http = await import('node:http');
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: bridge.port, path: `/c/${token}/json/version`, headers: { Host: 'attacker.example:9444' } },
      (res) => resolve(res.statusCode));
  });
  assert.equal(status, 403);
});

// ---------- ownership (D1 / R1) ----------

test('clients only see their own tabs', async () => {
  await online();
  const a = await client('kav');
  const b = await client('mcp');
  const { targetId } = await openTab(a);
  assert.deepEqual((await a.call('Target.getTargets')).targetInfos.map((/** @type {any} */ t) => t.targetId), [targetId]);
  assert.deepEqual((await b.call('Target.getTargets')).targetInfos, []);
  for (const method of ['Target.attachToTarget', 'Target.closeTarget', 'Target.getTargetInfo', 'Target.activateTarget']) {
    const r = await b.raw(method, { targetId, flatten: true });
    assert.match(r.error?.message ?? '', /No target/, method);
  }
});

test('a popup from an owned tab is adopted; an unrelated tab is not', async () => {
  const ext = await online();
  const a = await client();
  await a.call('Target.setDiscoverTargets', { discover: true });
  const { targetId } = await openTab(a);
  const openerTab = firstTab();
  const popup = ext.newTab('https://example.com/popup', openerTab);
  ext.event('tab.created', { tabId: popup, openerTabId: openerTab });
  const stranger = ext.newTab('https://bank.example/');
  ext.event('tab.created', { tabId: stranger, openerTabId: null });
  assert.ok(await until(() => a.named('Target.targetCreated').length >= 2));
  const ids = new Set((await a.call('Target.getTargets')).targetInfos.map((/** @type {any} */ t) => t.targetId));
  assert.deepEqual(ids, new Set([targetId, ext.tabs.get(popup)?.targetId]));
  const created = a.named('Target.targetCreated').find((e) => e.params.targetInfo.targetId === ext.tabs.get(popup)?.targetId);
  assert.equal(created.params.targetInfo.openerId, targetId);
});

// ---------- method policy (R1 / F2) ----------

const refused = [
  ['Network.getCookies', { urls: ['https://bank.example/'] }],
  ['Network.clearBrowserCookies', {}],
  ['Network.getAllCookies', {}],
  ['Storage.clearDataForOrigin', { origin: 'https://bank.example', storageTypes: 'all' }],
  ['DOM.setFileInputFiles', { files: ['/etc/passwd'], nodeId: 1 }],
  ['Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' }],
  ['Browser.close', {}],
  ['Target.createTarget', { url: 'https://example.com' }],
  ['Target.attachToTarget', { targetId: 'x', flatten: true }],
  ['Page.navigate', { url: 'file:///etc/passwd' }],
  ['Page.navigate', { url: 'chrome://settings' }],
  ['Fetch.enable', {}],
  ['IO.read', { handle: 'blob:00000000-0000-0000-0000-000000000000' }],
  ['Runtime.notAuditedYet', {}],
  ['Page.notAuditedYet', {}],
  ['Emulation.setTimezoneOverride', { timezoneId: 'UTC' }],
  ['Network.setUserAgentOverride', { userAgent: 'x' }],
  ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false }],
];

for (const [method, params] of refused) {
  test(`a session cannot reach beyond its tab: ${method} ${JSON.stringify(params).slice(0, 40)}`, async () => {
    const ext = await online();
    const a = await client();
    const { sessionId } = await openTab(a);
    const r = await a.raw(/** @type {string} */ (method), /** @type {any} */ (params), sessionId);
    assert.ok(r.error, `${method} must be refused`);
    assert.ok(!ext.calls.some(([op, args]) => op === 'dbg.send' && args.method === method), 'must not reach Chrome');
  });
}

test('page-scoped methods Kav uses are forwarded', async () => {
  await online();
  const a = await client();
  const { sessionId } = await openTab(a);
  for (const [method, params] of /** @type {[string, any][]} */ ([
    ['Runtime.evaluate', { expression: '1+1' }], ['Page.navigate', { url: 'https://example.org/' }], ['Network.enable', {}],
    ['Runtime.addBinding', { name: '__kfw' }], ['Page.addScriptToEvaluateOnNewDocument', { source: '1' }],
    ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }], ['Emulation.setFocusEmulationEnabled', { enabled: true }],
    ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }],
  ])) {
    assert.equal((await a.call(method, params, sessionId)).echo, method);
  }
});

test('browser-level: unsupported methods, file URLs and isolated contexts are refused', async () => {
  await online();
  const a = await client();
  for (const method of ['Target.setAutoAttach', 'Target.createBrowserContext', 'Browser.close', 'Storage.getCookies']) {
    assert.ok((await a.raw(method, {})).error, method);
  }
  assert.ok((await a.raw('Target.createTarget', { url: 'file:///Users/me/.ssh/id_rsa' })).error);
  const r = await a.raw('Target.createTarget', { url: 'about:blank', browserContextId: 'some-isolated-ctx' });
  assert.match(r.error.message, /isolated/);
});

// ---------- session model (R4 / F5) ----------

test('one operating root session per target', async () => {
  await online();
  const a = await client();
  const { targetId } = await openTab(a);
  assert.match((await a.raw('Target.attachToTarget', { targetId, flatten: true })).error.message, /already has an operating session/);
  const a2 = await new FakeCdp(bridge.base, auth.addClient('kav')).connect(); // same principal, another connection
  assert.ok((await a2.raw('Target.attachToTarget', { targetId, flatten: true })).error);
  await a.close();
  assert.ok(await until(() => !bridge.relay.hasSessions(firstTab())));
  assert.ok((await a2.call('Target.attachToTarget', { targetId, flatten: true })).sessionId);
});

test('root detach ends its child sessions and the debugger', async () => {
  const ext = await online();
  const a = await client();
  const { sessionId } = await openTab(a);
  const tab = firstTab();
  ext.event('dbg.event', { tabId: tab, method: 'Target.attachedToTarget', params: { sessionId: 'CHILD1', targetInfo: { targetId: 'F1', type: 'iframe' } } });
  assert.ok(await until(() => a.named('Target.attachedToTarget').some((e) => e.sessionId === sessionId)));
  assert.equal((await a.call('Runtime.evaluate', { expression: '1' }, 'CHILD1')).child, 'CHILD1');
  await a.call('Target.detachFromTarget', { sessionId });
  assert.equal((await a.raw('Runtime.evaluate', { expression: '1' }, 'CHILD1')).error.message, 'Session with given id not found.');
  assert.ok(await until(() => !ext.attached.has(tab)));
});

test('a child detaching takes its grandchildren with it', async () => {
  const ext = await online();
  const a = await client();
  await openTab(a);
  const tab = firstTab();
  ext.event('dbg.event', { tabId: tab, method: 'Target.attachedToTarget', params: { sessionId: 'C', targetInfo: { type: 'iframe' } } });
  ext.event('dbg.event', { tabId: tab, sessionId: 'C', method: 'Target.attachedToTarget', params: { sessionId: 'GC', targetInfo: { type: 'iframe' } } });
  assert.ok(await until(() => a.named('Target.attachedToTarget').length >= 3));
  assert.ok((await a.call('Runtime.evaluate', {}, 'GC')).echo);
  ext.event('dbg.event', { tabId: tab, method: 'Target.detachedFromTarget', params: { sessionId: 'C' } });
  assert.ok(await until(() => a.named('Target.detachedFromTarget').length >= 1));
  for (const s of ['C', 'GC']) assert.equal((await a.raw('Runtime.evaluate', {}, s)).error.message, 'Session with given id not found.', s);
});

test('attach completing after the target was destroyed does not create a session', async () => {
  const ext = await online();
  const a = await client();
  const { targetId } = await openTab(a);
  await a.call('Target.detachFromTarget', { sessionId: a.named('Target.attachedToTarget')[0].params.sessionId });
  assert.ok(await until(() => !ext.attached.has(firstTab())));
  /** @type {(v?: any) => void} */
  let release = () => {};
  ext.gates.set('dbg.attach', new Promise((r) => { release = r; }));
  const tab = firstTab();
  const pending = a.raw('Target.attachToTarget', { targetId, flatten: true });
  assert.ok(await until(() => ext.calls.filter(([op]) => op === 'dbg.attach').length === 2));
  ext.tabs.delete(tab);
  ext.event('tab.removed', { tabId: tab });
  assert.ok(await until(() => !bridge.relay.byTab.has(tab)));
  release();
  const r = await pending;
  assert.match(r.error?.message ?? '', /went away/);
  assert.equal(bridge.relay.hasSessions(tab), false);
});

test('events reach the session in order', async () => {
  const ext = await online();
  const a = await client();
  const { sessionId } = await openTab(a);
  const tab = firstTab();
  for (let i = 0; i < 50; i++) ext.event('dbg.event', { tabId: tab, method: 'Runtime.consoleAPICalled', params: { i } });
  assert.ok(await until(() => a.named('Runtime.consoleAPICalled').length === 50));
  assert.deepEqual(a.named('Runtime.consoleAPICalled').map((e) => e.params.i), [...Array(50).keys()]);
  assert.ok(a.named('Runtime.consoleAPICalled').every((e) => e.sessionId === sessionId));
});

// ---------- reconnect identity (R2 / F3 / F6) ----------

test('a worker restart keeps tabs whose targetId matches', async () => {
  const ext = await online({ boot: 'boot-aaaaaaaa' });
  const a = await client();
  const { targetId, sessionId } = await openTab(a);
  const tabs = new Map(ext.tabs);
  await ext.close();
  assert.ok(await until(() => bridge.relay.ext === null));
  assert.ok(await until(() => a.named('Target.detachedFromTarget').some((e) => e.params.sessionId === sessionId)));
  const ext2 = new FakeExtension(bridge.base, key(), { boot: 'boot-aaaaaaaa' });
  ext2.tabs = tabs;
  assert.ok(await ext2.connect());
  assert.ok(await until(() => bridge.relay.ext !== null));
  assert.deepEqual((await a.call('Target.getTargets')).targetInfos.map((/** @type {any} */ t) => t.targetId), [targetId]);
});

test('a reused tab id naming another page is not inherited', async () => {
  const ext = await online({ boot: 'boot-aaaaaaaa' });
  const a = await client();
  await openTab(a);
  const tab = firstTab();
  await ext.close();
  assert.ok(await until(() => bridge.relay.ext === null));
  const ext2 = new FakeExtension(bridge.base, key(), { boot: 'boot-aaaaaaaa' });
  ext2.tabs.set(tab, { targetId: 'SOMEONE-ELSES-PAGE', url: 'https://bank.example/', title: '', opener: null });
  assert.ok(await ext2.connect());
  assert.ok(await until(() => bridge.relay.ext !== null));
  assert.deepEqual((await a.call('Target.getTargets')).targetInfos, []);
  assert.ok(ext2.calls.some(([op, args]) => op === 'own.sync' && args.tabIds.length === 0));
});

test('a new extension lifetime drops every old target', async () => {
  const ext = await online({ boot: 'boot-aaaaaaaa' });
  const a = await client();
  await openTab(a);
  const tabs = new Map(ext.tabs);
  await ext.close();
  assert.ok(await until(() => bridge.relay.ext === null));
  const ext2 = new FakeExtension(bridge.base, key(), { boot: 'boot-bbbbbbbb' });
  ext2.tabs = tabs; // same tab ids and even the same target ids: a new lifetime still owns nothing
  assert.ok(await ext2.connect());
  assert.ok(await until(() => bridge.relay.ext !== null));
  assert.deepEqual((await a.call('Target.getTargets')).targetInfos, []);
});

test('a new link closes the old one', async () => {
  const old = await online();
  const a = await client();
  await openTab(a);
  const fresh = new FakeExtension(bridge.base, key());
  fresh.tabs = new Map(old.tabs);
  assert.ok(await fresh.connect());
  assert.ok(await until(() => bridge.relay.ext !== null && old.ws.readyState === WebSocket.CLOSED));
});

test('an unready or replaced link cannot change targets', async () => {
  const old = await online();
  const a = await client();
  const { targetId } = await openTab(a);
  const tab = firstTab();
  const oldLink = /** @type {ExtensionLink} */ (bridge.relay.ext);
  const fresh = new FakeExtension(bridge.base, key());
  fresh.tabs = new Map(old.tabs);
  /** @type {(v?: any) => void} */
  let release = () => {};
  fresh.gates.set('tabs.alive', new Promise((r) => { release = r; }));
  assert.ok(await fresh.connect());
  assert.ok(await until(() => fresh.calls.some(([op]) => op === 'tabs.alive')));
  bridge.relay.extEvent(oldLink, { ev: 'tab.removed', tabId: tab }); // a message the replaced link had buffered
  release();
  assert.ok(await until(() => bridge.relay.ext !== null));
  assert.deepEqual((await a.call('Target.getTargets')).targetInfos.map((/** @type {any} */ t) => t.targetId), [targetId]);
});

test('a tab closing during reconciliation is applied once the link is ready', async () => {
  const old = await online();
  const a = await client();
  await openTab(a);
  const tab = firstTab();
  const fresh = new FakeExtension(bridge.base, key());
  fresh.tabs = new Map(old.tabs);
  /** @type {(v?: any) => void} */
  let release = () => {};
  fresh.gates.set('own.sync', new Promise((r) => { release = r; }));
  assert.ok(await fresh.connect());
  assert.ok(await until(() => fresh.calls.some(([op]) => op === 'own.sync')));
  // Chrome reports the tab closed after own.sync took its snapshot but before the answer arrived: the snapshot
  // still lists it, so only the buffered event can remove it.
  fresh.event('tab.removed', { tabId: tab });
  await sleep(30);
  release();
  assert.ok(await until(() => bridge.relay.ext !== null));
  assert.deepEqual((await a.call('Target.getTargets')).targetInfos, []);
});

test('own.sync reports owned tabs that are already gone', async () => {
  const old = await online();
  const a = await client();
  await openTab(a);
  const fresh = new FakeExtension(bridge.base, key());
  fresh.tabs = new Map(old.tabs);
  /** @type {(v?: any) => void} */
  let release = () => {};
  fresh.gates.set('own.sync', new Promise((r) => { release = r; }));
  assert.ok(await fresh.connect());
  assert.ok(await until(() => fresh.calls.some(([op]) => op === 'own.sync')));
  fresh.tabs.clear(); // gone without any event (the new worker's owned set was empty when it closed)
  release();
  assert.ok(await until(() => bridge.relay.ext !== null));
  assert.deepEqual((await a.call('Target.getTargets')).targetInfos, []);
});

test('an older reconciliation finishing late cannot take over from a newer link', async () => {
  const first = await online();
  const a = await client();
  await openTab(a);
  const slow = new FakeExtension(bridge.base, key());
  slow.tabs = new Map(first.tabs);
  /** @type {(v?: any) => void} */
  let release = () => {};
  slow.gates.set('tabs.alive', new Promise((r) => { release = r; }));
  assert.ok(await slow.connect());
  assert.ok(await until(() => slow.calls.some(([op]) => op === 'tabs.alive')));
  const fast = new FakeExtension(bridge.base, key());
  fast.tabs = new Map(first.tabs);
  assert.ok(await fast.connect());
  assert.ok(await until(() => bridge.relay.ext !== null));
  const ready = bridge.relay.ext;
  release();
  await sleep(50);
  assert.equal(bridge.relay.ext, ready, 'the newer link stays');
  assert.ok(await until(() => slow.ws.readyState === WebSocket.CLOSED));
  assert.equal(fast.ws.readyState, WebSocket.OPEN);
});

test('adoption started under an old link never registers under a new one', async () => {
  const first = await online();
  const a = await client();
  await openTab(a);
  const opener = firstTab();
  const popup = first.newTab('https://example.com/popup', opener);
  /** @type {(v?: any) => void} */
  let release = () => {};
  first.gates.set('tabs.get', new Promise((r) => { release = r; }));
  first.event('tab.created', { tabId: popup, openerTabId: opener });
  assert.ok(await until(() => first.calls.some(([op]) => op === 'tabs.get')));
  const next = new FakeExtension(bridge.base, key(), { boot: 'boot-bbbbbbbb' }); // a new lifetime: tab ids mean nothing now
  next.tabs.set(popup, { targetId: 'STRANGER', url: 'https://bank.example/', title: '', opener: null });
  assert.ok(await next.connect());
  assert.ok(await until(() => bridge.relay.ext !== null));
  release();
  await sleep(50);
  assert.deepEqual((await a.call('Target.getTargets')).targetInfos, []);
  assert.ok(!next.calls.some(([op]) => op === 'own'), 'no command from the stale adoption reaches the new link');
});

// Relay-level races the websocket fakes cannot produce (closing a link rejects its pending calls first): a link
// whose answers arrive whenever the test says, even after it was closed.
class ScriptedLink extends ExtensionLink {
  /** @param {string} bootId */
  constructor(bootId) {
    super(async () => {}, { bootId }, () => {});
    /** @type {Map<string, { promise: Promise<any>, release: (v: any) => void }>} */
    this.gated = new Map();
    /** @type {[string, any][]} */
    this.sent = [];
  }
  /** @param {string} op */
  gate(op) {
    /** @type {(v: any) => void} */
    let release = () => {};
    const promise = new Promise((r) => { release = r; });
    this.gated.set(op, { promise, release });
    return release;
  }
  /** The next tabs.create answers with this tab id. */
  nextTab = 7;
  /** @param {string} op @param {Record<string, any>} [args] */
  async call(op, args = {}) {
    this.sent.push([op, args]);
    const g = this.gated.get(op);
    if (g) {
      this.gated.delete(op); // one call only; later calls of the same op answer normally
      return g.promise;
    }
    if (op === 'own.sync') return { missing: [] };
    if (op === 'tabs.create') return { tabId: this.nextTab, windowId: 1, targetId: `T${this.nextTab}`, url: args.url };
    if (op === 'tabs.get') return { tabId: args.tabId, targetId: `T${args.tabId}`, url: 'https://example.com/', title: '' };
    return true;
  }
}

test('a reconciliation whose answer lands after it was superseded does not commit', async () => {
  const relay = bridge.relay;
  const a = new ScriptedLink('boot-aaaaaaaa');
  const releaseA = a.gate('own.sync');
  const doneA = relay.extConnected(a);
  const b = new ScriptedLink('boot-aaaaaaaa');
  await relay.extConnected(b);
  assert.equal(relay.ext, b);
  releaseA({ missing: [] }); // A's answer arrives anyway
  await doneA;
  assert.equal(relay.ext, b, 'the older reconciliation must not take over');
});

test('an adoption whose answer lands after its link was replaced does not register', async () => {
  const relay = bridge.relay;
  const a = new ScriptedLink('boot-aaaaaaaa');
  await relay.extConnected(a);
  const cdp = await client();
  await cdp.call('Target.createTarget', { url: 'https://example.com/' }); // tab 7, owned
  const releaseGet = a.gate('tabs.get');
  relay.extEvent(a, { ev: 'tab.created', tabId: 8, openerTabId: 7 });
  assert.ok(await until(() => a.sent.some(([op]) => op === 'tabs.get')));
  const b = new ScriptedLink('boot-bbbbbbbb'); // a new lifetime: tab 8 may be anyone's page now
  await relay.extConnected(b);
  releaseGet({ tabId: 8, targetId: 'T8', url: 'https://bank.example/', title: '' });
  await sleep(20);
  assert.equal(relay.byTab.has(8), false);
  assert.ok(!b.sent.some(([op]) => op === 'own'));
});

test('a title (and which tab is shown) reported before the new tab was registered is kept, not dropped', async () => {
  const relay = bridge.relay;
  const a = new ScriptedLink('boot-aaaaaaaa');
  await relay.extConnected(a);
  const cdp = await client();
  const release = a.gate('tabs.create');
  const created = cdp.call('Target.createTarget', { url: 'https://example.com/', background: true });
  assert.ok(await until(() => a.sent.some(([op]) => op === 'tabs.create')));
  // the page loaded fast: the extension (already owning tab 7) reports it before the bridge has registered the tab
  relay.extEvent(a, { ev: 'tab.updated', tabId: 7, url: 'https://example.com/', title: 'loaded title' });
  relay.extEvent(a, { ev: 'tab.updated', tabId: 7, active: true });
  release({ tabId: 7, windowId: 1, targetId: 'T7', url: 'https://example.com/', title: '', active: false });
  const { targetId } = await created;
  const info = (await cdp.call('Target.getTargets')).targetInfos.find((/** @type {any} */ t) => t.targetId === targetId);
  assert.equal(info.title, 'loaded title');
  assert.equal(relay.byTab.get(7)?.active, true);
  assert.equal(relay.early.size, 0, 'used up');
});

// ---------- revocation (R5 / F8) ----------

test('a removed client is disconnected and a new one with the same name inherits nothing', async () => {
  await online();
  const a = await client('kav');
  await openTab(a);
  auth.removeClient('kav');
  assert.ok(await until(() => a.closed));
  const again = await client('kav');
  assert.deepEqual((await again.call('Target.getTargets')).targetInfos, []);
});

test('a malformed client record revokes only that client', async () => {
  await online();
  const a = await client('kav');
  const b = await client('mcp');
  fs.writeFileSync(path.join(auth.home(), 'clients', 'kav.json'), '[]');
  assert.ok(await until(() => a.closed));
  await sleep(150);
  assert.equal(b.closed, false);
  assert.deepEqual((await b.call('Target.getTargets')).targetInfos, []);
});

test('a rotated pairing key drops the extension', async () => {
  const ext = await online();
  auth.pairKey({ rotate: true });
  assert.ok(await until(() => bridge.relay.ext === null));
  assert.ok(await until(() => ext.ws.readyState === WebSocket.CLOSED));
});

test('a revoked connection runs nothing more', async () => {
  const ext = await online();
  const a = await client('kav');
  const { sessionId } = await openTab(a);
  const conn = [...bridge.relay.conns][0];
  conn.close(); // closed, but the socket's close handler has not cleaned up yet
  const before = ext.calls.length;
  await bridge.relay.handle(conn, JSON.stringify({ id: 99, sessionId, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 1, y: 1 } }));
  assert.equal(ext.calls.length, before);
});

test('tokens never reach the log', async () => {
  const token = auth.addClient('kav');
  await get(`/c/${token}/json/version`);
  await get('/c/guess/json/version');
  await online();
  const a = await client();
  await a.raw('Browser.close');
  a.ws.send('{"id": "not-a-number"');
  await sleep(30);
  assert.ok(!logs.join('\n').includes(token));
});

// ---------- failure semantics (R6 / D3 / F7) ----------

test('an offline extension fails fast', async () => {
  const a = await client();
  const r = await a.raw('Target.createTarget', { url: 'about:blank' }, undefined, 2000);
  assert.match(r.error.message, /not connected/);
});

test('an in-flight command is reported unknown, not retried', async () => {
  const ext = await online();
  const a = await client();
  const { sessionId } = await openTab(a);
  ext.hang.add('dbg.send');
  const pending = a.raw('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }, sessionId);
  assert.ok(await until(() => ext.calls.some(([op]) => op === 'dbg.send')));
  await ext.close();
  const r = await pending;
  assert.match(r.error.message, /effect is unknown/);
  assert.match(r.error.message, /not retried/);
  assert.equal(ext.calls.filter(([op, x]) => op === 'dbg.send' && x.method === 'Input.dispatchMouseEvent').length, 1);
});

test('a send that never completes still hits the deadline as unknown', async () => {
  const link = new ExtensionLink(() => new Promise(() => {}), { bootId: 'b' }, () => {});
  await assert.rejects(link.call('dbg.send', {}, 30), /no answer within/);
});

test('a send that fails is reported unknown', async () => {
  const link = new ExtensionLink(() => Promise.reject(new Error('EPIPE')), { bootId: 'b' }, () => {});
  await assert.rejects(link.call('dbg.send', {}, 1000), /effect is unknown/);
});

test('a stuck client is disconnected instead of buffering forever', async () => {
  let closed = false;
  const conn = new CdpConn({ id: 'p1', name: 'kav' }, () => new Promise(() => {}), () => { closed = true; }, { limit: 3 });
  for (let i = 0; i < 10; i++) conn.emit('Runtime.consoleAPICalled', { i });
  assert.ok(closed && conn.closed);
});

test('a client whose writer fails is closed', async () => {
  let closed = false;
  const conn = new CdpConn({ id: 'p1', name: 'kav' }, () => Promise.reject(new Error('EPIPE')), () => { closed = true; });
  conn.emit('Runtime.consoleAPICalled', {});
  assert.ok(await until(() => closed && conn.closed));
});

test('an oversized backlog in bytes disconnects the client', async () => {
  let closed = false;
  const conn = new CdpConn({ id: 'p1', name: 'kav' }, () => new Promise(() => {}), () => { closed = true; }, { limitBytes: 1000 });
  conn.emit('x', { blob: 'a'.repeat(400) });
  conn.emit('x', { blob: 'a'.repeat(400) });
  conn.emit('x', { blob: 'a'.repeat(400) });
  assert.ok(closed);
});

test('a replaced tab retires the old target and adopts the new one', async () => {
  const ext = await online();
  const a = await client();
  await a.call('Target.setDiscoverTargets', { discover: true });
  const { targetId } = await openTab(a);
  const oldTab = firstTab();
  const newTab = ext.newTab('https://example.com/');
  ext.event('tab.replaced', { addedTabId: newTab, removedTabId: oldTab });
  assert.ok(await until(() => a.named('Target.targetDestroyed').length > 0 && a.named('Target.targetCreated').length >= 2));
  const ids = (await a.call('Target.getTargets')).targetInfos.map((/** @type {any} */ t) => t.targetId);
  assert.deepEqual(ids, [ext.tabs.get(newTab)?.targetId]);
  assert.ok(!ids.includes(targetId));
});

// ---------- races on close and adoption; limits and logging ----------

test('closing a link while a send is still pending is not an unhandled rejection', async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  try {
    /** @type {() => void} */
    let finishSend = () => {};
    const link = new ExtensionLink(() => new Promise((r) => { finishSend = () => r(undefined); }), { bootId: 'b' }, () => {});
    const pending = link.call('dbg.send', {}, 1000).catch((e) => e);
    link.close('disconnected'); // rejects the answer while the send has not completed
    await sleep(20); // Node's unhandled-rejection check runs while the send is still pending
    finishSend();
    assert.match(String(await pending), /effect is unknown/);
    await sleep(20);
    assert.equal(unhandled, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a target cleared while own() was in flight is never announced', async () => {
  const relay = bridge.relay;
  const a = new ScriptedLink('boot-aaaaaaaa');
  await relay.extConnected(a);
  const cdp = await client();
  await cdp.call('Target.setDiscoverTargets', { discover: true });
  const releaseOwn = a.gate('own');
  const creating = cdp.raw('Target.createTarget', { url: 'https://example.com/' });
  assert.ok(await until(() => a.sent.some(([op]) => op === 'own')));
  relay.extEvent(a, { ev: 'tab.removed', tabId: 7 }); // the tab is gone before own() answered
  releaseOwn(true);
  const r = await creating;
  assert.ok(r.error, 'createTarget reports that the tab is gone');
  await sleep(20);
  const created = cdp.named('Target.targetCreated').filter((e) => e.params.targetInfo.targetId === 'T7');
  assert.equal(created.length, 0);
});

test('a popup closed while its tabs.get answer was in flight is not adopted', async () => {
  const relay = bridge.relay;
  const a = new ScriptedLink('boot-aaaaaaaa');
  await relay.extConnected(a);
  const cdp = await client();
  await cdp.call('Target.createTarget', { url: 'https://example.com/' }); // tab 7
  const releaseGet = a.gate('tabs.get');
  relay.extEvent(a, { ev: 'tab.created', tabId: 8, openerTabId: 7 });
  assert.ok(await until(() => a.sent.some(([op]) => op === 'tabs.get')));
  relay.extEvent(a, { ev: 'tab.removed', tabId: 8 }); // not registered yet: only the generation remembers it
  releaseGet({ tabId: 8, targetId: 'T8', url: 'https://example.com/popup', title: '' });
  await sleep(20);
  assert.equal(relay.byTab.has(8), false);
});

test('a connection closed while waiting for the attach lock never touches Chrome', async () => {
  const relay = bridge.relay;
  const a = new ScriptedLink('boot-aaaaaaaa');
  await relay.extConnected(a);
  const first = await client('kav');
  const second = await client('mcp');
  const { targetId: t1 } = await first.call('Target.createTarget', { url: 'https://example.com/' });
  /** @type {() => void} */
  let releaseFirst = () => {};
  const firstAttach = new Promise((r) => { releaseFirst = () => r(true); });
  a.call = /** @type {any} */ (async (/** @type {string} */ op, /** @type {any} */ args = {}) => {
    a.sent.push([op, args]);
    if (op === 'tabs.create') return { tabId: 9, windowId: 1, targetId: 'T9', url: args.url };
    return op === 'dbg.attach' && args.tabId === 7 ? firstAttach : true; // the first attach holds the lock
  });
  const { targetId: t2 } = await second.call('Target.createTarget', { url: 'https://example.org/' });
  void first.raw('Target.attachToTarget', { targetId: t1, flatten: true }).catch(() => {});
  assert.ok(await until(() => a.sent.some(([op, x]) => op === 'dbg.attach' && x.tabId === 7)));
  void second.raw('Target.attachToTarget', { targetId: t2, flatten: true }).catch(() => null);
  assert.ok(await until(() => relay.lock.queued === 2), 'the second attach is really queued behind the first');
  const conn = [...relay.conns].find((c) => c.principal.name === 'mcp');
  conn?.close(); // revoked while queued behind the lock
  releaseFirst(); // the lock frees; the queued attach now runs and must notice it is stale before touching Chrome
  assert.ok(await until(() => relay.lock.queued === 0), 'both attaches finished');
  assert.ok(!a.sent.some(([op, x]) => op === 'dbg.attach' && x.tabId === 9), 'no dbg.attach for the closed connection');
});

test('a rejected upgrade whose peer never closes does not block shutdown', async () => {
  const net = await import('node:net');
  const sock = net.connect(bridge.port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  sock.allowHalfOpen = true;
  sock.on('error', () => {});
  sock.write('GET /invalid HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  await sleep(30);
  const started = Date.now();
  await bridge.close();
  assert.ok(Date.now() - started < 1500, 'close() has a hard boundary');
  bridge = await startBridge({ port: 0, revokePollMs: 50, log: (l) => logs.push(l) }); // for afterEach
  sock.destroy();
});

test('the outbox limit counts UTF-8 bytes, not string length', () => {
  let closed = false;
  const conn = new CdpConn({ id: 'p1', name: 'kav' }, () => new Promise(() => {}), () => { closed = true; }, { limitBytes: 100, log: () => {} });
  conn.emit('x', { t: '中文中文中文中文中文中文' }); // 36 bytes of text in 12 UTF-16 units
  conn.emit('x', { t: '中文中文中文中文中文中文' });
  assert.ok(closed, 'two messages of ~60 UTF-8 bytes exceed 100 bytes');
});

test('the Host must be an exact loopback authority; discovery never echoes it', async () => {
  const token = auth.addClient('kav');
  const http = await import('node:http');
  /** @param {string} host @returns {Promise<{ status: number | undefined, body: string }>} */
  const withHost = (host) => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: bridge.port, path: `/c/${token}/json/version`, headers: { Host: host } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
  });
  for (const bad of [`127.0.0.1:80@evil.example`, `127.0.0.1:${bridge.port}.evil.example`, `localhost.evil.example`, `127.0.0.1:1`]) {
    assert.equal((await withHost(bad)).status, 403, bad);
  }
  const ok = await withHost(`localhost:${bridge.port}`);
  assert.equal(ok.status, 200);
  assert.ok(JSON.parse(ok.body).webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${bridge.port}/c/`));
});

test('every log line goes through the injected logger and carries no token', async () => {
  const token = auth.addClient('kav');
  const original = { error: console.error, warn: console.warn, info: console.info, log: console.log };
  /** @type {string[]} */
  const consoleLines = [];
  for (const k of /** @type {const} */ (['error', 'warn', 'info', 'log'])) console[k] = (/** @type {any[]} */ ...a) => { consoleLines.push(a.join(' ')); };
  try {
    await online();
    const a = await new FakeCdp(bridge.base, token).connect();
    await openTab(a);
    await a.raw('Browser.close');
    a.ws.send('{"id": "not-a-number"');
    auth.removeClient('kav'); // revocation logs
    assert.ok(await until(() => a.closed));
    await sleep(30);
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(consoleLines, [], 'nothing bypasses the logger');
  assert.ok(logs.some((l) => l.includes('revoked')));
  assert.ok(!logs.join('\n').includes(token));
});

test('a tab closed before tabs.create answered is not registered', async () => {
  const relay = bridge.relay;
  const a = new ScriptedLink('boot-aaaaaaaa');
  await relay.extConnected(a);
  const cdp = await client();
  const release = a.gate('tabs.create');
  const creating = cdp.raw('Target.createTarget', { url: 'https://example.com/' });
  assert.ok(await until(() => a.sent.some(([op]) => op === 'tabs.create')));
  relay.extEvent(a, { ev: 'tab.removed', tabId: 7 }); // Chrome closed it before our answer arrived
  release({ tabId: 7, windowId: 1, targetId: 'T7', url: 'https://example.com/' });
  const r = await creating;
  assert.match(r.error?.message ?? '', /closed before it could be registered/);
  assert.equal(relay.byTab.has(7), false);
});

test('resetting the removal counters does not let a stale adoption through (r3 ②, ABA)', async () => {
  const relay = bridge.relay;
  const a = new ScriptedLink('boot-aaaaaaaa');
  await relay.extConnected(a);
  const cdp = await client();
  await cdp.call('Target.createTarget', { url: 'https://example.com/' }); // tab 7
  const releaseGet = a.gate('tabs.get');
  relay.extEvent(a, { ev: 'tab.created', tabId: 8, openerTabId: 7 });
  assert.ok(await until(() => a.sent.some(([op]) => op === 'tabs.get')));
  relay.extEvent(a, { ev: 'tab.removed', tabId: 8 });
  for (let i = 0; i < 10001; i++) relay.extEvent(a, { ev: 'tab.removed', tabId: 100000 + i }); // forces the reset
  releaseGet({ tabId: 8, targetId: 'T8', url: 'https://example.com/popup', title: '' });
  await sleep(20);
  assert.equal(relay.byTab.has(8), false);
});

// ---------- popup adoption and tab id reuse; the shared window ----------

test('a popup replaced before its adoption finished: the replacement is adopted, the old id is not (p1a-2 ①)', async () => {
  const relay = bridge.relay;
  const a = new ScriptedLink('boot-aaaaaaaa');
  await relay.extConnected(a);
  const cdp = await client();
  await cdp.call('Target.createTarget', { url: 'https://example.com/' }); // tab 7
  const releaseGet = a.gate('tabs.get');
  relay.extEvent(a, { ev: 'tab.created', tabId: 8, openerTabId: 7 });
  assert.ok(await until(() => a.sent.some(([op, x]) => op === 'tabs.get' && x.tabId === 8)));
  relay.extEvent(a, { ev: 'tab.replaced', addedTabId: 9, removedTabId: 8 });
  releaseGet({ tabId: 8, targetId: 'T8', url: 'https://example.com/popup', title: '' });
  assert.ok(await until(() => relay.byTab.has(9)), 'the replacement is adopted');
  assert.equal(relay.byTab.has(8), false);
  assert.equal(relay.byTab.get(9)?.openerId, 'T7');
});

test("an old lifetime's removal records do not block a reused tab id in a new one (p1a-2 ③)", async () => {
  const relay = bridge.relay;
  const a = new ScriptedLink('boot-aaaaaaaa');
  await relay.extConnected(a);
  const cdp = await client();
  await cdp.call('Target.createTarget', { url: 'https://example.com/' }); // tab 7
  relay.extEvent(a, { ev: 'tab.removed', tabId: 7 });
  const b = new ScriptedLink('boot-bbbbbbbb'); // Chrome restarted: tab id 7 can come back
  await relay.extConnected(b);
  const { targetId } = await cdp.call('Target.createTarget', { url: 'https://example.org/' });
  assert.equal(targetId, 'T7');
  assert.ok(relay.byTab.has(7));
});

test('attaching turns on focus emulation, so background tabs in the shared window take input', async () => {
  const ext = await online();
  const a = await client();
  const { targetId } = await a.call('Target.createTarget', { url: 'https://example.com/', background: true });
  await a.call('Target.attachToTarget', { targetId, flatten: true });
  const sent = ext.calls.filter(([op, x]) => op === 'dbg.send' && x.method === 'Emulation.setFocusEmulationEnabled');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][1].params, { enabled: true });
  assert.equal(sent[0][1].sessionId, null, 'on the root session, not a child');
});

test('every tab opens in the one K-Browser window once it exists', async () => {
  const ext = await online();
  const a = await client();
  await a.call('Target.createTarget', { url: 'https://example.com/' });
  await a.call('Target.createTarget', { url: 'https://example.org/' });
  const creates = ext.calls.filter(([op]) => op === 'tabs.create').map(([, x]) => x.windowId);
  assert.deepEqual(creates, [null, 1], 'the second create targets the window the first one opened');
});

// ---------- the shared window: focus emulation and creation ----------

test('a target closed while focus emulation was being set up does not get a session', async () => {
  const ext = await online();
  const a = await client();
  const { targetId } = await a.call('Target.createTarget', { url: 'https://example.com/', background: true });
  /** @type {() => void} */
  let release = () => {};
  ext.sendGates.set('Emulation.setFocusEmulationEnabled', new Promise((r) => { release = () => r(undefined); }));
  const attaching = a.raw('Target.attachToTarget', { targetId, flatten: true });
  assert.ok(await until(() => ext.calls.some(([op, x]) => op === 'dbg.send' && x.method === 'Emulation.setFocusEmulationEnabled')));
  const tab = firstTab();
  ext.tabs.delete(tab);
  ext.event('tab.removed', { tabId: tab });
  assert.ok(await until(() => !bridge.relay.byTab.has(tab)));
  release();
  const r = await attaching;
  assert.match(r.error?.message ?? '', /went away/);
  assert.equal(bridge.relay.hasSessions(tab), false);
  assert.ok(!a.named('Target.attachedToTarget').length, 'no attachedToTarget for a session that does not exist');
});

test('if focus emulation cannot be enabled, the attach is refused, not silently degraded', async () => {
  const ext = await online();
  const a = await client();
  const { targetId } = await a.call('Target.createTarget', { url: 'https://example.com/', background: true });
  ext.sendFail.add('Emulation.setFocusEmulationEnabled');
  const r = await a.raw('Target.attachToTarget', { targetId, flatten: true });
  assert.match(r.error?.message ?? '', /could not enable focus emulation/);
  assert.equal(bridge.relay.hasSessions(firstTab()), false);
  assert.ok(await until(() => !ext.attached.has(firstTab())), 'the debugger is detached again');
});

test('two first tabs created at once share one K-Browser window', async () => {
  const ext = await online();
  const a = await client('kav');
  const b = await client('mcp');
  await Promise.all([a.call('Target.createTarget', { url: 'https://example.com/' }), b.call('Target.createTarget', { url: 'https://example.org/' })]);
  const asked = ext.calls.filter(([op]) => op === 'tabs.create').map(([, x]) => x.windowId);
  assert.deepEqual(asked, [null, 1], 'only the first create opens a window; the second uses it');
});

// ---------- the window lock ----------

test('a connection closed while waiting for the window lock never creates a tab (window r2 ①)', async () => {
  const ext = await online();
  const a = await client('kav');
  const b = await client('mcp');
  /** @type {() => void} */
  let release = () => {};
  ext.gates.set('tabs.create', new Promise((r) => { release = () => r(undefined); }));
  const first = a.call('Target.createTarget', { url: 'https://example.com/' });
  assert.ok(await until(() => ext.calls.some(([op]) => op === 'tabs.create')), 'the first create holds the window lock');
  void b.raw('Target.createTarget', { url: 'https://example.org/' }).catch(() => null); // its client is closed: no answer to wait for
  assert.ok(await until(() => bridge.relay.windowLock.queued === 2), 'the second create is really queued behind the first');
  [...bridge.relay.conns].find((c) => c.principal.name === 'mcp')?.close(); // revoked while queued
  release(); // the lock frees; the queued create must notice it is stale before asking Chrome for a tab
  await first;
  assert.ok(await until(() => bridge.relay.windowLock.queued === 0), 'both creates finished');
  assert.equal(ext.calls.filter(([op]) => op === 'tabs.create').length, 1, 'no tabs.create for the closed connection');
});

// ---------- never focusing the window ----------

test('Page.bringToFront is refused and never reaches Chrome: the window is never focused', async () => {
  const ext = await online();
  const a = await client();
  const { targetId } = await a.call('Target.createTarget', { url: 'https://example.com/', background: true });
  const { sessionId } = await a.call('Target.attachToTarget', { targetId, flatten: true });
  const r = await a.raw('Page.bringToFront', {}, sessionId);
  assert.match(r.error?.message ?? '', /never brings its window to the front/);
  assert.ok(!ext.calls.some(([op, x]) => op === 'dbg.send' && x.method === 'Page.bringToFront'), 'not forwarded to Chrome');
});

test('an extension reconnect while a create waits for the window lock sends it to neither link', async () => {
  const relay = bridge.relay;
  const a = new ScriptedLink('boot-aaaaaaaa');
  await relay.extConnected(a);
  const kav = await client('kav');
  const mcp = await client('mcp');
  const releaseFirst = a.gate('tabs.create');
  const first = kav.raw('Target.createTarget', { url: 'https://example.com/' }).catch(() => null);
  assert.ok(await until(() => a.sent.some(([op]) => op === 'tabs.create')), 'the first create holds the window lock');
  const second = mcp.raw('Target.createTarget', { url: 'https://example.org/' });
  assert.ok(await until(() => relay.windowLock.queued === 2), 'the second create is really queued behind the first');
  const b = new ScriptedLink('boot-bbbbbbbb');
  await relay.extConnected(b); // the extension reconnected while the second create was queued
  releaseFirst({ tabId: 7, windowId: 1, targetId: 'T7', url: 'https://example.com/' });
  const r = await second;
  assert.match(r.error?.message ?? '', /no tab was opened/);
  await first;
  assert.equal(a.sent.filter(([op]) => op === 'tabs.create').length, 1, 'the old link got only the first create');
  assert.ok(!b.sent.some(([op]) => op === 'tabs.create'), 'the new link never got the stale create');
});
