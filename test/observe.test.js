// @ts-check
// Unit tests: the bridge's observation log (src/observe.js) and KBrowser.* through the bridge with a fake
// extension. Each test names the completion condition it covers.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import * as auth from '../src/auth.js';
import { globMatcher, Observer } from '../src/observe.js';
import { describeProtocol, startBridge } from '../src/server.js';
import { FakeCdp, FakeExtension, OPEN, until } from './fakes.js';

const T = 'TARGET-1';
const ME = 'principal-me';

/** @param {Observer} o @param {string} requestId @param {string} url @param {Record<string, any>} [extra] @param {string | null} [child] */
function request(o, requestId, url, extra = {}, child = null) {
  o.event(T, ME, child, 'Network.requestWillBeSent', { requestId, request: { url, method: extra.method ?? 'GET' }, frameId: 'F', loaderId: 'L', ...extra });
}
/** @param {Observer} o @param {string} requestId @param {number} status @param {Record<string, any>} [response] */
function respond(o, requestId, status, response = {}) {
  o.event(T, ME, null, 'Network.responseReceived', { requestId, response: { status, mimeType: 'application/json', ...response } });
  o.event(T, ME, null, 'Network.loadingFinished', { requestId });
}

// ---------- the log ----------

test('the log keeps the newest entries within both an entry and a byte limit; what it drops makes older windows unobservable', () => {
  const o = new Observer({ limits: { entries: 5, bytes: 1_000_000 } });
  o.enabled(T, ME, null);
  const m = o.mark(ME, T, 'before');
  for (let i = 0; i < 8; i++) request(o, `r${i}`, `https://a.test/${i}`);
  const q = o.query(ME, T, { sinceActionId: m.actionId });
  assert.deepEqual(q.entries.map((e) => e.requestId), ['r3', 'r4', 'r5', 'r6', 'r7']);
  assert.equal(q.unobservable, true);
  assert.match(q.why.join(), /dropped/);
  const later = o.mark(ME, T, 'after');
  request(o, 'r8', 'https://a.test/8');
  assert.equal(o.query(ME, T, { sinceActionId: later.actionId }).unobservable, false, 'a window after the drop is fine');

  const small = new Observer({ limits: { entries: 1000, bytes: 2000 } });
  for (let i = 0; i < 20; i++) request(small, `r${i}`, `https://a.test/${'x'.repeat(200)}${i}`);
  const kept = small.logs.get(T);
  assert.ok(kept && kept.bytes <= 2000 && kept.entries.length < 20, `bytes ${kept?.bytes}, entries ${kept?.entries.length}`);
});

test('observable intervals: not enabled, disabled after the mark, child sessions not observed, extension reconnect', () => {
  const o = new Observer();
  const m0 = o.mark(ME, T, '');
  assert.equal(o.query(ME, T, { sinceActionId: m0.actionId }).unobservable, true, 'nothing enabled');
  o.enabled(T, ME, null);
  assert.equal(o.query(ME, T, { sinceActionId: m0.actionId }).unobservable, true, 'enabled only after the mark');
  const m1 = o.mark(ME, T, '');
  assert.deepEqual([o.query(ME, T, { sinceActionId: m1.actionId }).unobservable, o.query(ME, T, { sinceActionId: m1.actionId }).partial], [false, false]);
  o.event(T, ME, null, 'Target.attachedToTarget', { sessionId: 'C1' });
  assert.equal(o.query(ME, T, { sinceActionId: m1.actionId }).partial, true, 'an OOPIF session without Network.enable');
  o.enabled(T, ME, 'C1');
  assert.equal(o.query(ME, T, { sinceActionId: m1.actionId }).partial, true, 'it attached after the mark and was observed only later: a gap');
  const mc = o.mark(ME, T, '');
  assert.equal(o.query(ME, T, { sinceActionId: mc.actionId }).partial, false, 'observed all along from this mark');
  // the child switches its network off and on again inside the window: still partial, and still listed
  o.disabled(T, 'C1', 'Network.disable');
  assert.equal(o.query(ME, T, { sinceActionId: mc.actionId }).partial, true);
  o.enabled(T, ME, 'C1');
  assert.equal(o.query(ME, T, { sinceActionId: mc.actionId }).partial, true, 'an off boundary inside the window stays');
  o.event(T, ME, null, 'Target.detachedFromTarget', { sessionId: 'C1' });
  const md = o.mark(ME, T, '');
  assert.equal(o.query(ME, T, { sinceActionId: md.actionId }).partial, false, 'a child that left is no gap afterwards');
  o.disabled(T, null, 'Network.disable');
  o.enabled(T, ME, null);
  assert.equal(o.query(ME, T, { sinceActionId: m1.actionId }).unobservable, true, 'an off boundary after the mark, even if on again');
  const m2 = o.mark(ME, T, '');
  o.newGeneration();
  o.enabled(T, ME, null);
  const q = o.query(ME, T, { sinceActionId: m2.actionId });
  assert.equal(q.unobservable, true);
  assert.match(q.why.join(), /reconnected/);
});

test('marks belong to one principal and one target: anyone else\'s, or another target\'s, is refused', () => {
  const o = new Observer();
  o.enabled(T, ME, null);
  o.enabled('TARGET-2', ME, null);
  const m = o.mark(ME, T, 'x'.repeat(500));
  assert.equal(m.label.length, 200, 'labels are capped');
  assert.equal(m.source, 'client');
  assert.throws(() => o.query(ME, 'TARGET-2', { sinceActionId: m.actionId }), /no mark/);
  assert.throws(() => o.query('someone-else', T, { sinceActionId: m.actionId }), /no mark/);
  assert.throws(() => o.query(ME, T, { sinceActionId: 'a999' }), /no mark/);
});

test('an old request redirected after the mark is still the old request, at every hop', () => {
  const o = new Observer();
  o.enabled(T, ME, null);
  request(o, 'old', 'https://a.test/slow');
  const m = o.mark(ME, T, 'submit');
  request(o, 'old', 'https://a.test/api/book', { redirectResponse: { status: 302 } });
  respond(o, 'old', 200);
  request(o, 'new', 'https://a.test/api/book');
  respond(o, 'new', 200);
  const q = o.query(ME, T, { sinceActionId: m.actionId });
  assert.deepEqual(q.entries.map((e) => [e.requestId, e.hop]), [['new', 0]]);
  assert.equal(q.markT, m.t, 'the query says when the mark was taken');
});

test('a request sent before the mark is not "after" it, even if it is answered after', () => {
  const o = new Observer();
  o.enabled(T, ME, null);
  request(o, 'old', 'https://a.test/api/book', { method: 'POST' });
  const m = o.mark(ME, T, 'submit');
  respond(o, 'old', 200);
  request(o, 'new', 'https://a.test/api/book', { method: 'POST' });
  respond(o, 'new', 200);
  assert.deepEqual(o.query(ME, T, { sinceActionId: m.actionId, urlGlob: '*/api/book' }).entries.map((e) => e.requestId), ['new']);
});

test('redirect chains: every hop is its own entry; service worker and cache answers are marked', () => {
  const o = new Observer();
  o.enabled(T, ME, null);
  request(o, 'r', 'https://a.test/r1');
  request(o, 'r', 'https://a.test/r2', { redirectResponse: { status: 302, mimeType: 'text/html' } });
  request(o, 'r', 'https://a.test/final', { redirectResponse: { status: 301 } });
  respond(o, 'r', 200, { fromServiceWorker: true });
  request(o, 'c', 'https://a.test/cached');
  o.event(T, ME, null, 'Network.requestServedFromCache', { requestId: 'c' });
  respond(o, 'c', 200);
  const e = o.query(ME, T, {}).entries;
  assert.deepEqual(e.map((x) => [x.url.slice(15), x.hop, x.status, x.redirectedTo]), [['r1', 0, 302, true], ['r2', 1, 301, true], ['final', 2, 200, false], ['cached', 0, 200, false]]);
  assert.deepEqual([e[2].fromServiceWorker, e[3].fromCache, e[0].fromServiceWorker], [true, true, false]);
  assert.deepEqual(o.query(ME, T, { status: [300, 399] }).entries.map((x) => x.hop), [0, 1]);
});

test('a body comes only from the bridge\'s copy of the getResponseBody reply, attached to the last hop', () => {
  const o = new Observer({ limits: { body: 10 } });
  o.enabled(T, ME, null);
  request(o, 'r', 'https://a.test/r1');
  request(o, 'r', 'https://a.test/api', { redirectResponse: { status: 302 } });
  respond(o, 'r', 200);
  assert.equal(o.query(ME, T, { includeBody: true }).entries[1].body, null, 'nothing until the reply was seen');
  o.body(T, null, 'r', { body: '{"status":"OK","x":1}', base64Encoded: false });
  const [first, last] = o.query(ME, T, { includeBody: true }).entries;
  assert.equal(first.body, null);
  assert.deepEqual([/** @type {any} */ (last.body)?.text, last.body?.truncated], ['{"status":', true]);
  assert.deepEqual(o.query(ME, T, {}).entries[1].body, { captured: true, length: 10, truncated: true }, 'without includeBody: only that there is one');
});

test('globs: * and ? only, regular-expression characters are literal, and a hostile pattern stays fast', () => {
  const m = globMatcher('https://a.test/api/*?id=?');
  assert.equal(m('https://a.test/api/book?id=7'), true);
  assert.equal(m('https://a.test/api/book?id=77'), false);
  assert.equal(globMatcher('*.json')('https://a.test/x.json'), true);
  assert.equal(globMatcher('*a.test(1)*')('https://a.test(1)/'), true);
  assert.equal(globMatcher('a.c')('abc'), false, '. is a dot');
  const hostile = `${'*a'.repeat(400)}b`;
  const started = Date.now();
  assert.equal(globMatcher(hostile)('a'.repeat(4000)), false);
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
  assert.throws(() => globMatcher('x'.repeat(2000)), /at most/);
  assert.throws(() => globMatcher(/** @type {any} */ (/re/)));
});

test('navigation: the main frame\'s URL, loader and history; child frames do not count', () => {
  const o = new Observer();
  o.event(T, ME, null, 'Page.frameNavigated', { frame: { id: 'M', url: 'https://a.test/', loaderId: 'L1' } });
  o.event(T, ME, null, 'Page.frameNavigated', { frame: { id: 'C', parentId: 'M', url: 'https://ads.test/', loaderId: 'L9' } });
  o.event(T, ME, 'CHILD', 'Page.frameNavigated', { frame: { id: 'X', url: 'https://oop.test/', loaderId: 'L8' } });
  o.event(T, ME, null, 'Page.navigatedWithinDocument', { frameId: 'M', url: 'https://a.test/#done' });
  const n = o.navigation(T);
  assert.deepEqual([n.url, n.loaderId, n.history.map((h) => h.sameDocument)], ['https://a.test/#done', 'L1', [false, true]]);
});

// ---------- KBrowser.* through the bridge ----------

/** @type {Awaited<ReturnType<typeof startBridge>>} */ let bridge;

beforeEach(async () => {
  process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-obs-'));
  bridge = await startBridge({ port: 0, log: () => {} });
});
afterEach(async () => {
  while (OPEN.length) await /** @type {any} */ (OPEN.pop()).close();
  await bridge.close();
});

async function setUp() {
  const ext = new FakeExtension(bridge.base, /** @type {string} */ (auth.pairKey({ create: true })));
  assert.ok(await ext.connect());
  assert.ok(await until(() => bridge.relay.ext !== null));
  const cdp = await new FakeCdp(bridge.base, auth.addClient('me')).connect();
  const { targetId } = await cdp.call('Target.createTarget', { url: 'https://a.test/', background: true });
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
  const tabId = /** @type {number} */ ([...bridge.relay.byTab.keys()][0]);
  /** @param {string} method @param {Record<string, any>} params @param {string | null} [child] */
  const event = (method, params, child = null) => ext.event('dbg.event', { tabId, sessionId: child, method, params });
  return { ext, cdp, targetId, sessionId, tabId, event };
}

test('KBrowser.*: browser level only (with a sessionId refused), and only on the caller\'s own targets', async () => {
  const { cdp, targetId, sessionId } = await setUp();
  await assert.rejects(cdp.call('KBrowser.mark', { targetId }, sessionId), /not allowed/);
  const other = await new FakeCdp(bridge.base, auth.addClient('other')).connect();
  for (const m of ['KBrowser.mark', 'KBrowser.queryNetwork', 'KBrowser.getNavigation']) {
    await assert.rejects(other.call(m, { targetId }), /No target with given id/, `${m} on someone else's target`);
  }
});

test('KBrowser: what the session enabled is observed; Network.disable makes the window unobservable; bodies come from the bridge\'s copy', async () => {
  const { ext, cdp, targetId, sessionId, event } = await setUp();
  const before = await cdp.call('KBrowser.mark', { targetId, label: 'not yet' });
  await cdp.call('Network.enable', {}, sessionId);
  const { actionId } = await cdp.call('KBrowser.mark', { targetId, label: 'submit' });
  assert.ok(ext.calls.some(([op, a]) => op === 'dbg.send' && a.method === 'Page.getFrameTree'), 'a barrier went through the tab before the mark');
  event('Network.requestWillBeSent', { requestId: 'R1', request: { url: 'https://a.test/api/book', method: 'POST' } });
  event('Network.responseReceived', { requestId: 'R1', response: { status: 200, mimeType: 'application/json' } });
  event('Network.loadingFinished', { requestId: 'R1' });
  ext.sendResults.set('Network.getResponseBody', { body: '{"status":"OK"}', base64Encoded: false });
  await cdp.call('Network.getResponseBody', { requestId: 'R1' }, sessionId);
  const q = await cdp.call('KBrowser.queryNetwork', { targetId, sinceActionId: actionId, urlGlob: '*/api/*', includeBody: true });
  assert.deepEqual([q.unobservable, q.entries.length, q.entries[0].status, q.entries[0].body?.text], [false, 1, 200, '{"status":"OK"}'],
    'the body is the bridge\'s copy of the reply it forwarded');
  assert.equal((await cdp.call('KBrowser.queryNetwork', { targetId, sinceActionId: before.actionId })).unobservable, true, 'the earlier mark predates Network.enable');
  await cdp.call('Network.disable', {}, sessionId);
  const after = await cdp.call('KBrowser.queryNetwork', { targetId, sinceActionId: actionId });
  assert.equal(after.unobservable, true);
  assert.match(after.why.join(), /Network\.disable/);
});

test('/json/protocol: only what K-Browser supports, KBrowser included, no-store, and 404 for a wrong token', async () => {
  const token = auth.addClient('proto');
  const res = await fetch(`${bridge.base}/c/${token}/json/protocol`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const doc = await res.json();
  const names = doc.domains.flatMap((/** @type {any} */ d) => d.commands.map((/** @type {any} */ c) => `${d.domain}.${c.name}`));
  for (const m of ['KBrowser.mark', 'KBrowser.queryNetwork', 'KBrowser.getNavigation', 'DOM.getNodeForLocation', 'Target.createTarget', 'Network.getResponseBody']) assert.ok(names.includes(m), m);
  for (const m of ['Storage.clearDataForOrigin', 'Network.getAllCookies', 'DOM.setFileInputFiles', 'Fetch.enable', 'Browser.close']) assert.ok(!names.includes(m), `${m} is not offered`);
  assert.deepEqual(doc, describeProtocol());
  assert.equal((await fetch(`${bridge.base}/c/not-a-token/json/protocol`)).status, 404);
});

test('review round 2: a child\'s gap outlives its detach; a redirect whose first hop is gone is never "after" a mark', () => {
  const o = new Observer({ limits: { entries: 3 } });
  o.enabled(T, ME, null);
  const m = o.mark(ME, T, '');
  o.event(T, ME, null, 'Target.attachedToTarget', { sessionId: 'C' });
  o.enabled(T, ME, 'C'); // late: a gap between attach and enable
  o.event(T, ME, null, 'Target.detachedFromTarget', { sessionId: 'C' });
  assert.equal(o.query(ME, T, { sinceActionId: m.actionId }).partial, true, 'the gap is still inside the window');
  o.event(T, ME, null, 'Target.attachedToTarget', { sessionId: 'D' });
  o.event(T, ME, null, 'Target.detachedFromTarget', { sessionId: 'D' }); // never observed
  const m2 = o.mark(ME, T, '');
  assert.equal(o.query(ME, T, { sinceActionId: m2.actionId }).partial, false, 'both left before this mark');

  const r = new Observer({ limits: { entries: 2 } });
  r.enabled(T, ME, null);
  request(r, 'old', 'https://a.test/slow'); // first hop, before the mark
  const mk = r.mark(ME, T, '');
  request(r, 'x1', 'https://a.test/x1');
  request(r, 'x2', 'https://a.test/x2'); // pushes the old first hop out
  request(r, 'old', 'https://a.test/api/book', { redirectResponse: { status: 302 } });
  respond(r, 'old', 200);
  const q = r.query(ME, T, { sinceActionId: mk.actionId, urlGlob: '*/api/book' });
  assert.deepEqual(q.entries.map((e) => e.requestId), [], 'its chain start is unknown: not after the mark');
});
