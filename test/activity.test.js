// @ts-check
// The bridge's activity record (src/activity.js), the side panel's commands through the bridge, the
// extension's sender checks, and the panel page's rendering (extension/panel.js in a VM with a minimal DOM).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, test } from 'node:test';
import { Activity, Feed, localDay } from '../src/activity.js';
import * as auth from '../src/auth.js';
import { CATEGORIES, categoriesIn, withCategory } from '../src/sites.js';
import { startBridge } from '../src/server.js';
import { ChromeHarness, EXT_ID } from './chrome-harness.js';
import { FakeCdp, FakeExtension, OPEN, sleep, until } from './fakes.js';

const SECRET = 'FAKEsecretValue0123456789zz';

test('Feed: merges by key, stays bounded, marks the gap, one batch at a time', async () => {
  /** @type {any[]} */ const got = [];
  /** @type {() => void} */ let release = () => {};
  const held = new Promise((r) => { release = () => r(undefined); });
  let first = true;
  const f = new Feed(async (b) => { got.push(b); if (first) { first = false; await held; } }, 5);
  f.push('a', 1); // delivered at once (and held)
  await sleep(5);
  for (let i = 0; i < 20; i++) f.push(`k${i}`, i);
  f.push('k19', 'merged');
  assert.equal(f.queue.size, 5, 'bounded while the consumer is stuck');
  release();
  await until(() => got.length === 2);
  assert.deepEqual([got[1].gap, got[1].updates.at(-1)], [true, 'merged']);
  assert.ok(got[1].seq > got[0].seq);
});

test('Activity: no parameters kept (but the URL of a navigation, redacted); same command on the same tab merges; capped per client', () => {
  const a = new Activity({ limits: { perPrincipal: 10 } });
  const base = { principal: 'p1', name: 'kav', targetId: 'T1', outcome: /** @type {const} */ ('ok') };
  a.command({ ...base, method: 'Input.insertText', params: { text: SECRET } });
  a.command({ ...base, method: 'Runtime.evaluate', params: { expression: `"${SECRET}"` } });
  for (let i = 0; i < 12; i++) a.command({ ...base, method: 'Input.dispatchKeyEvent', params: { text: SECRET } });
  a.command({ ...base, method: 'Page.navigate', params: { url: `https://x.test/a?session=${SECRET}` } });
  const all = JSON.stringify(a.recent());
  assert.equal(all.split(SECRET).length - 1, 0, all);
  const list = a.recent()[0].entries;
  assert.deepEqual(list.map((e) => [e.method, e.count]), [['Input.insertText', 1], ['Runtime.evaluate', 1], ['Input.dispatchKeyEvent', 12], ['Page.navigate', 1]]);
  assert.equal(list[3].url, 'https://x.test/a?session=[redacted]');
  for (let i = 0; i < 20; i++) a.command({ ...base, method: `M.${i}` });
  assert.equal(a.recent(1000)[0].entries.length, 10, 'oldest dropped');
  assert.throws(() => a.result({ principal: 'p1', name: 'kav', targetId: 'T1', verdict: 'verified by bridge', level: null, recordIds: [] }));
  const r = a.result({ principal: 'p1', name: 'kav', targetId: 'T1', verdict: 'completed', level: 'site_replied', recordIds: ['n3', '<b>x</b>', 'n4'] });
  assert.deepEqual([r.source, r.recordIds], ['sdk', ['n3', 'n4']]);
  const l = a.label({ principal: 'p1', name: 'kav', targetId: 'T1', label: `輸入 textbox「${SECRET}」?token=${SECRET}` });
  assert.ok(l && l.source === 'client' && !String(l.label).includes('token=FAKE'));
});

test('Activity on disk: 0600 files, old days deleted, nothing without activityLog: "disk"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-act-'));
  fs.writeFileSync(path.join(dir, '2000-01-01.jsonl'), '{}\n');
  const a = new Activity({ disk: { dir } });
  assert.ok(!fs.existsSync(path.join(dir, '2000-01-01.jsonl')), 'older than 7 days: deleted');
  a.command({ principal: 'p', name: 'n', method: 'Page.navigate', targetId: null, outcome: 'ok', params: { url: `https://x.test/?code=${SECRET}` } });
  await until(() => fs.readdirSync(dir).length === 1);
  await sleep(20);
  const [f] = fs.readdirSync(dir);
  assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(dir, f), 'utf8').split(SECRET).length - 1, 0);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-act-home-'));
  process.env.KBROWSER_HOME = home;
  const b = await startBridge({ port: 0, log: () => {} });
  await b.close();
  assert.ok(!fs.existsSync(path.join(home, 'activity')), 'the default keeps it in memory only');
});

test('Activity on disk files a record under the user\'s own calendar day, not the UTC one', async () => {
  const tz = process.env.TZ;
  process.env.TZ = 'Asia/Taipei';
  try {
    const at = Date.parse('2026-10-24T17:30:00Z'); // 01:30 on the 25th in Taiwan
    assert.equal(localDay(at), '2026-10-25');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-act-'));
    const a = new Activity({ disk: { dir }, now: () => at });
    a.command({ principal: 'p', name: 'n', method: 'Page.reload', targetId: null, outcome: 'ok' });
    await until(() => fs.readdirSync(dir).length === 1);
    assert.deepEqual(fs.readdirSync(dir), ['2026-10-25.jsonl']);
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('Activity on disk keeps its total cap within a day, not only when the day changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-act-cap-'));
  const a = new Activity({ limits: { diskBytes: 2000 }, disk: { dir } });
  for (let i = 0; i < 200; i++) {
    a.command({ principal: 'p', name: 'n', method: `M.${i}`, targetId: null, outcome: 'ok' });
    if (i % 20 === 0) await sleep(5);
  }
  await sleep(100);
  const total = fs.readdirSync(dir).reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
  assert.ok(total > 0 && total <= 2000, `${total} bytes`);
});

// ---------- through the bridge ----------

/** @type {Awaited<ReturnType<typeof startBridge>>} */ let bridge;

beforeEach(async () => {
  process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-activity-'));
  bridge = await startBridge({ port: 0, log: () => {}, revokePollMs: 50 });
});
afterEach(async () => {
  while (OPEN.length) await /** @type {any} */ (OPEN.pop()).close();
  await bridge.close();
});

async function setUp() {
  const ext = new FakeExtension(bridge.base, /** @type {string} */ (auth.pairKey({ create: true })));
  assert.ok(await ext.connect());
  assert.ok(await until(() => bridge.relay.ext !== null));
  const cdp = await new FakeCdp(bridge.base, auth.addClient('kav')).connect();
  const { targetId } = await cdp.call('Target.createTarget', { url: 'https://a.test/', background: true });
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
  return { ext, cdp, targetId, sessionId };
}

test('bridge: every client command is recorded without its parameters; refused ones marked; the panel gets a snapshot, then updates', async () => {
  const { ext, cdp, targetId, sessionId } = await setUp();
  await cdp.call('Input.insertText', { text: SECRET }, sessionId);
  await cdp.call('Runtime.evaluate', { expression: SECRET }, sessionId);
  for (let i = 0; i < 12; i++) await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', text: SECRET }, sessionId);
  await assert.rejects(cdp.call('Browser.close', {}, sessionId));
  const recent = JSON.stringify(bridge.relay.activity.recent());
  assert.equal(recent.split(SECRET).length - 1, 0);
  const entries = bridge.relay.activity.recent()[0].entries;
  assert.deepEqual(entries.find((e) => e.method === 'Input.dispatchKeyEvent')?.count, 12);
  assert.equal(entries.find((e) => e.method === 'Browser.close')?.outcome, 'refused');
  assert.equal(entries.find((e) => e.method === 'Input.insertText')?.targetId, targetId);
  ext.event('panel.open');
  assert.ok(await until(() => ext.panel.some((b) => b.updates.some((/** @type {any} */ u) => u.type === 'snapshot'))));
  const snap = ext.panel.flatMap((b) => b.updates).find((/** @type {any} */ u) => u.type === 'snapshot');
  assert.deepEqual(snap.state.clients.map((/** @type {any} */ c) => c.name), ['kav']);
  assert.equal(snap.state.tabs[0].targetId, targetId);
  await cdp.call('Page.reload', {}, sessionId);
  assert.ok(await until(() => ext.panel.flatMap((b) => b.updates).some((/** @type {any} */ u) => u.type === 'entry' && u.entry.method === 'Page.reload')));
  ext.event('panel.close');
  await sleep(30);
  const n = ext.panel.length;
  await cdp.call('Page.reload', {}, sessionId);
  await sleep(50);
  assert.equal(ext.panel.length, n, 'no panel subscribed: nothing pushed');
});

test('bridge: a client added a moment ago is masked from its first use: its token never reaches the record, the panel or the file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-act-new-'));
  const own = await startBridge({ port: 0, log: () => {}, activity: new Activity({ disk: { dir } }) });
  try {
    const ext = new FakeExtension(own.base, /** @type {string} */ (auth.pairKey({ create: true })));
    assert.ok(await ext.connect());
    assert.ok(await until(() => own.relay.ext !== null));
    ext.event('panel.open');
    const first = await new FakeCdp(own.base, auth.addClient('first')).connect();
    const { targetId: t1 } = await first.call('Target.createTarget', { url: 'https://a.test/', background: true });
    await first.call('KBrowser.mark', { targetId: t1, label: 'warm the redactor' });
    const token = auth.addClient('newcomer'); // right after the redactor was built
    const late = await new FakeCdp(own.base, token).connect();
    const { targetId } = await late.call('Target.createTarget', { url: `https://a.test/?x=${token}`, background: true });
    await late.call('KBrowser.mark', { targetId, label: `label with ${token}` });
    await sleep(300);
    const disk = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    for (const [where, text] of [['record', JSON.stringify(own.relay.activity.recent())], ['panel', JSON.stringify(ext.panel)], ['file', disk]]) {
      assert.equal(text.split(token).length - 1, 0, `the new token in the ${where}`);
    }
    assert.match(JSON.stringify(own.relay.activity.recent()), /label with \[redacted:credential\]/);
  } finally {
    while (OPEN.length) await /** @type {any} */ (OPEN.pop()).close();
    await own.close();
  }
});

test('bridge: a credential file rewritten in place (the directory unchanged) is masked from the new token\'s first use', async () => {
  const { cdp, targetId } = await setUp();
  await cdp.call('KBrowser.mark', { targetId, label: 'warm the redactor' });
  const dir = path.join(auth.home(), 'clients');
  const before = fs.statSync(dir).mtimeMs;
  const file = path.join(dir, 'kav.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const fresh = 'kbREWRITTENtoken0123456789abcdefXY';
  fs.writeFileSync(file, JSON.stringify({ ...rec, token: fresh })); // in place: no rename
  assert.equal(fs.statSync(dir).mtimeMs, before, 'the directory did not change');
  const again = await new FakeCdp(bridge.base, fresh).connect();
  await again.call('KBrowser.mark', { targetId, label: `label with ${fresh}` });
  assert.equal(JSON.stringify(bridge.relay.activity.recent()).split(fresh).length - 1, 0);
});

test('bridge: a stuck panel never holds up CDP replies; its queue stays bounded and the panel later sees a gap', async () => {
  const { ext, cdp, sessionId } = await setUp();
  /** @type {() => void} */ let release = () => {};
  ext.panelGate = new Promise((r) => { release = () => r(undefined); });
  ext.event('panel.open');
  await sleep(30);
  const t0 = Date.now();
  for (let i = 0; i < 400; i++) await cdp.call(`Runtime.evaluate`, { expression: String(i), returnByValue: i % 2 === 0 }, sessionId);
  assert.ok(Date.now() - t0 < 10_000);
  for (let i = 0; i < 300; i++) await cdp.call(i % 2 ? 'Page.reload' : 'Runtime.evaluate', {}, sessionId);
  assert.ok(/** @type {any} */ (bridge.relay.activity.panel).queue.size <= bridge.relay.activity.limits.queue);
  release();
  ext.panelGate = null;
  assert.ok(await until(() => ext.panel.some((b) => b.gap), 3000), 'the panel is told it missed updates');
});

test('bridge: panel commands — wrong principal, re-created client, stale hand-off and an unreconciled link are all refused', async () => {
  const { ext, cdp, targetId } = await setUp();
  ext.event('panel.open');
  await sleep(30);
  const principal = /** @type {string} */ (auth.clientRecord('kav')?.principal);
  const results = () => ext.panel.flatMap((b) => b.updates).filter((/** @type {any} */ u) => u.type === 'result');

  ext.event('panel.cmd', { op: 'show', principal: 'someone-else', targetId });
  ext.event('panel.cmd', { op: 'show', principal, targetId });
  assert.ok(await until(() => results().length === 2));
  assert.deepEqual(results().map((/** @type {any} */ r) => r.ok), [false, true]);
  assert.equal(ext.shown.length, 1);

  const h = await cdp.call('KBrowser.handoff', { targetId, reason: 'x' });
  await cdp.call('KBrowser.cancelHandoff', { handoffId: h.handoffId });
  ext.event('panel.cmd', { op: 'return', principal, handoffId: h.handoffId });
  assert.ok(await until(() => results().length === 3));
  assert.equal(results()[2].ok, false, 'a cancelled hand-off cannot be returned');

  // a confirmation for the old principal must not revoke a client re-created under the same name
  auth.removeClient('kav');
  auth.addClient('kav');
  ext.event('panel.cmd', { op: 'revoke', principal });
  assert.ok(await until(() => results().length === 4));
  assert.equal(results()[3].ok, false);
  assert.ok(auth.clientRecord('kav'), 'the new client is still there');

  // a link that has not finished reconciling sends commands for nothing
  const fresh = auth.clientRecord('kav');
  const other = new FakeExtension(bridge.base, /** @type {string} */ (auth.pairKey()));
  /** @type {() => void} */ let reconcile = () => {};
  other.gates.set('own.sync', new Promise((r) => { reconcile = () => r(undefined); }));
  assert.ok(await other.connect());
  assert.ok(await until(() => bridge.relay.candidate !== null));
  other.event('panel.cmd', { op: 'revoke', principal: fresh?.principal });
  await sleep(100);
  assert.ok(auth.clientRecord('kav'), 'not revoked by an unreconciled link');
  reconcile(); // and not later either, once the link is the current one
  assert.ok(await until(() => bridge.relay.ext !== null && bridge.relay.candidate === null));
  await sleep(100);
  assert.ok(auth.clientRecord('kav'), 'a command from before the reconciliation is never applied');
});

test('bridge: revoke from the panel removes the client and drops its connections at once', async () => {
  const { ext, cdp } = await setUp();
  ext.event('panel.open');
  const principal = /** @type {string} */ (auth.clientRecord('kav')?.principal);
  ext.event('panel.cmd', { op: 'revoke', principal });
  assert.ok(await until(() => auth.clientRecord('kav') === null));
  assert.ok(await until(() => cdp.closed, 2000), 'connection closed');
});

test('site categories: on adds a category\'s patterns, off removes only its own; a pattern another fully-on category holds and the user\'s own entries stay', () => {
  const bank = CATEGORIES.banking.hosts;
  const mine = ['https://mine.example', '*.corp.example'];
  let list = withCategory(mine, 'banking', true);
  assert.deepEqual(list, [...mine, ...bank]);
  assert.deepEqual(withCategory(list, 'banking', true), list, 'on twice adds nothing');
  assert.deepEqual(categoriesIn([...list, 'paypal.com']), { on: ['banking'], part: ['payments'], other: 2 });
  assert.deepEqual(withCategory(list, 'banking', false), mine);
  // a pattern shared with another category that stays fully on is kept; with one only partly on it goes
  CATEGORIES.test_shared = { label: 'test', hosts: [bank[0], 'shared-only.example'] };
  try {
    list = withCategory(withCategory(mine, 'banking', true), 'test_shared', true);
    assert.deepEqual(withCategory(list, 'banking', false), [...mine, bank[0], 'shared-only.example']);
    assert.deepEqual(withCategory(list, 'test_shared', false), [...mine, ...bank]);
    const partly = list.filter((x) => x !== 'shared-only.example');
    assert.deepEqual(withCategory(partly, 'banking', false), mine);
  } finally {
    delete CATEGORIES.test_shared;
  }
});

test('bridge: settings from the panel — site categories, screenshots, eval (off only), the decision dataset; bad name, principal, category or type refused; token, principal and the user\'s own sites untouched', async () => {
  const { ext } = await setUp();
  ext.event('panel.open');
  await sleep(30);
  auth.addClient('agent');
  auth.updateClient('agent', { blockedOrigins: ['https://mine.example', 'paypal.com'], eval: true, note: 'kept' });
  const first = /** @type {Record<string, any>} */ (auth.clientRecord('agent'));
  const { principal } = first;
  const results = () => ext.panel.flatMap((b) => b.updates).filter((/** @type {any} */ u) => u.type === 'result');
  /** @param {Record<string, any>} m */
  const run = async (m) => {
    const n = results().length;
    ext.event('panel.cmd', m);
    assert.ok(await until(() => results().length === n + 1));
    return results()[n];
  };
  const rec = () => /** @type {Record<string, any>} */ (auth.clientRecord('agent'));
  const shown = () => bridge.relay.panelState().configured.find((c) => c.name === 'agent');

  assert.deepEqual(shown()?.sites, { on: [], part: ['payments'], other: 1 });
  assert.deepEqual(bridge.relay.panelState().about.categories.map((/** @type {any} */ c) => c.id), Object.keys(CATEGORIES));
  assert.equal((await run({ op: 'sites', name: 'agent', principal, category: 'banking', on: true })).ok, true);
  assert.deepEqual(rec().blockedOrigins, ['https://mine.example', 'paypal.com', ...CATEGORIES.banking.hosts]);
  assert.deepEqual(shown()?.sites, { on: ['banking'], part: ['payments'], other: 1 });
  assert.deepEqual([rec().token, rec().principal, rec().note, rec().eval], [first.token, principal, 'kept', true], 'nothing else changes');
  assert.equal((await run({ op: 'sites', name: 'agent', principal, category: 'banking', on: false })).ok, true);
  assert.deepEqual(rec().blockedOrigins, ['https://mine.example', 'paypal.com'], 'the user\'s own entries stay');

  const now = JSON.stringify(rec());
  for (const [m, why] of /** @type {[Record<string, any>, RegExp][]} */ ([
    [{ op: 'sites', name: 'nobody', principal, category: 'banking', on: true }, /no such client/],
    [{ op: 'sites', name: '../agent', principal, category: 'banking', on: true }, /no such client/],
    [{ op: 'sites', name: 'agent', principal: 'someone-else', category: 'banking', on: true }, /no such client/],
    [{ op: 'sites', name: 'agent', category: 'banking', on: true }, /no such client/],
    [{ op: 'sites', name: 'agent', principal, category: 'toString', on: true }, /unknown site category/],
    [{ op: 'sites', name: 'agent', principal, category: '__proto__', on: true }, /unknown site category/],
    [{ op: 'sites', name: 'agent', principal, on: true }, /unknown site category/],
    [{ op: 'sites', name: 'agent', principal, category: 'banking', on: 'true' }, /on: true or false/],
    [{ op: 'screenshot', name: 'agent', principal, on: 0 }, /on: true or false/],
    [{ op: 'eval', name: 'agent', principal, on: true }, /only in a terminal/],
    [{ op: 'decisionLog', on: 'on' }, /on: true or false/],
  ])) {
    const r = await run(m);
    assert.equal(r.ok, false, JSON.stringify(m));
    assert.match(r.why, why);
  }
  assert.equal(JSON.stringify(rec()), now, 'a refused command changes nothing');

  assert.equal((await run({ op: 'screenshot', name: 'agent', principal, on: false })).ok, true);
  assert.equal(rec().screenshot, false);
  assert.equal((await run({ op: 'eval', name: 'agent', principal, on: false })).ok, true);
  assert.equal(rec().eval, false);
  assert.deepEqual([shown()?.screenshot, shown()?.eval], [false, false]);
  assert.equal((await run({ op: 'screenshot', name: 'agent', principal, on: true })).ok, true);
  assert.equal(shown()?.screenshot, true);
  assert.deepEqual([rec().token, rec().principal, rec().note], [first.token, principal, 'kept']);

  // a client re-created under the same name is another one
  auth.removeClient('agent');
  auth.addClient('agent');
  assert.equal((await run({ op: 'screenshot', name: 'agent', principal, on: false })).ok, false);
  assert.equal(rec().screenshot, undefined);

  // an allow list, or a blockedOrigins that is not a list, is left to the file
  auth.updateClient('agent', { allowedOrigins: ['https://only.example'] });
  const p2 = rec().principal;
  assert.match((await run({ op: 'sites', name: 'agent', principal: p2, category: 'email', on: true })).why, /allow list/);
  assert.equal(shown()?.allowList, true);
  auth.updateClient('agent', { allowedOrigins: undefined, blockedOrigins: 'bank.example' });
  assert.match((await run({ op: 'sites', name: 'agent', principal: p2, category: 'email', on: true })).why, /not a list/);
  assert.equal(shown()?.sites, null);
  assert.equal(rec().blockedOrigins, 'bank.example');

  // the decision dataset: the rest of config.json is kept
  const configFile = path.join(/** @type {string} */ (process.env.KBROWSER_HOME), 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ model: { backend: 'kev' } }));
  assert.equal((await run({ op: 'decisionLog', on: true })).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { model: { backend: 'kev' }, decisionLog: 'on' });
  assert.equal(bridge.relay.panelState().about.decisionLog, true);
  assert.equal((await run({ op: 'decisionLog', on: false })).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).decisionLog, 'off');
  assert.equal(bridge.relay.panelState().about.decisionLog, false);
});

// ---------- the extension's sender checks (the real background.js) ----------

test('extension: only its own panel document may connect, only its own popup or panel may return a hand-off', async () => {
  const h = new ChromeHarness({ port: 1 }).start();
  try {
    /** @param {any} sender */
    const port = (sender) => {
      const p = { name: 'panel', sender, disconnected: false, onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() { this.disconnected = true; }, postMessage() {} };
      h.ev.runtimeConnect.fire(p);
      return p;
    };
    assert.equal(port({ id: EXT_ID, url: 'https://evil.test/', tab: { id: 1 } }).disconnected, true, 'a web page');
    assert.equal(port({ id: 'otherextensionidxxxxxxxxxxxxxxxx', url: `chrome-extension://otherextensionidxxxxxxxxxxxxxxxx/panel.html` }).disconnected, true, 'another extension');
    assert.equal(port({ id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html` }).disconnected, true, 'another of our pages');
    assert.equal(port({ id: EXT_ID, url: `chrome-extension://${EXT_ID}/panel.html` }).disconnected, false, 'the panel');
    /** @param {any} sender */
    const ret = (sender) => { let answered = null; h.ev.runtimeMessage.fire({ type: 'handoff.return', handoffId: 'h1' }, sender, (/** @type {any} */ v) => { answered = v; }); return answered; };
    assert.equal(ret({ id: EXT_ID, url: 'https://evil.test/', tab: { id: 1 } }), null);
    assert.equal(ret({ id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html` }), true);
  } finally {
    await h.stop();
  }
});

// ---------- the panel page: plain text only ----------

test('panel page: hostile titles, labels and reasons show as plain text; a fake record format stays inside one entry', () => {
  /** @type {any[]} */ const made = [];
  const node = (/** @type {string} */ tag) => {
    const n = { tag, textContent: '', className: '', hidden: false, children: /** @type {any[]} */ ([]),
      append(/** @type {any[]} */ ...c) { this.children.push(...c); }, replaceChildren() { this.children = []; }, addEventListener() {},
      /** @param {string} _v */ set innerHTML(_v) { throw new Error('innerHTML must not be used'); } };
    made.push(n);
    return n;
  };
  const byId = { status: node('div'), gap: node('div'), clients: node('div'), about: node('div'), configured: node('div'), modelBox: node('div'), model: node('div'),
    decisionsBox: node('div'), decisions: node('div') };
  /** @type {(m: any) => void} */ let deliver = () => {};
  const messages = JSON.parse(fs.readFileSync(new URL('../extension/_locales/zh_TW/messages.json', import.meta.url), 'utf8'));
  const chrome = { runtime: { connect: () => ({ onMessage: { addListener: (/** @type {any} */ f) => { deliver = f; } }, onDisconnect: { addListener() {} }, postMessage() {} }) },
    i18n: { getMessage: (/** @type {string} */ k) => messages[k]?.message ?? '' } };
  const document = { getElementById: (/** @type {'status'|'gap'|'clients'|'about'|'configured'|'modelBox'|'model'|'decisionsBox'|'decisions'} */ id) => byId[id], createElement: node, body: { dataset: {} } };
  const context = vm.createContext({ chrome, document, Date, setTimeout, String, Math, Map });
  for (const f of ['i18n.js', 'panel.js']) vm.runInContext(fs.readFileSync(new URL(`../extension/${f}`, import.meta.url), 'utf8'), context);
  const evil = '<img src=x onerror="alert(1)">';
  const fakeRecord = '\n12:00:00 Target.closeTarget\n已執行:revoke';
  deliver({ type: 'push', batch: { seq: 1, gap: true, updates: [{ type: 'snapshot',
    state: { clients: [{ principal: 'p1', name: evil, connections: 1, lastActive: Date.now() }],
      tabs: [{ principal: 'p1', targetId: 'T', title: evil, url: 'https://x.test/', openedBy: null }],
      handoffs: [{ handoffId: 'h1', principal: 'p1', targetId: 'T', reason: evil, since: Date.now() }] },
    activity: [{ principal: 'p1', entries: [{ id: 1, principal: 'p1', kind: 'label', label: `${evil}${fakeRecord}`, source: 'client' }] }] }] } });
  assert.ok(!made.some((n) => n.tag === 'img' || n.tag === 'script'), 'no element from page text');
  const texts = made.map((n) => n.textContent);
  assert.ok(texts.some((t) => t.includes(evil)), 'shown literally');
  const labels = made.filter((n) => n.className === 'entry label');
  assert.equal(labels.length, 1, 'the fake record format did not become more entries');
  assert.ok(texts.includes('客戶端提供'));
  assert.equal(byId.gap.hidden, false, 'the gap is shown');
});
