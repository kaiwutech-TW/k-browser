// @ts-check
// Unit tests: the evidence contract (src/sdk/evidence.js) against a scripted bridge (KBrowser.* answers).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { open, rejectsWith, Wire } from './wire.js';

/** A bridge log: entries the scripted KBrowser.queryNetwork returns (bodies only with includeBody, as the bridge does). */
function bridge({ unobservable = false, why = /** @type {string[]} */ ([]) } = {}) {
  const w = new Wire();
  /** @type {any[]} */ const entries = [];
  /** @type {Map<string, string>} bodies the bridge captured, by requestId */ const kept = new Map();
  /** @type {Map<string, string>} what Chrome would answer to getResponseBody (the bridge keeps it) */ const chrome = new Map();
  const state = { unobservable, why, url: 'https://a.test/', partial: false, markT: Date.now() - 10_000, offAfterBody: false };
  w.on('KBrowser.queryNetwork', (p) => ({
    entries: entries.map((e) => ({ ...e, body: kept.has(e.requestId) ? (p.includeBody ? { text: kept.get(e.requestId), base64Encoded: false, truncated: false } : { captured: true }) : null })),
    truncated: false, unobservable: state.unobservable || (state.offAfterBody && p.includeBody === true), why: state.offAfterBody ? ['Network.disable'] : state.why,
    partial: state.partial, markT: state.markT,
  }));
  w.on('KBrowser.getNavigation', () => ({ url: state.url, loaderId: 'L', history: [] }));
  w.on('Network.getResponseBody', (p) => {
    const body = chrome.get(p.requestId);
    if (body === undefined) throw new Error('No resource with given identifier found');
    kept.set(p.requestId, body); // what the bridge records from Chrome's reply
    return { body: 'TEXT THE SDK SEES IS IGNORED', base64Encoded: false };
  });
  /** @param {string} requestId @param {Record<string, any>} [o] */
  const add = (requestId, o = {}) => entries.push({ id: `n${entries.length + 1}`, requestId, url: 'https://a.test/api/book', method: 'POST', status: 200,
    finished: true, failed: null, redirectedTo: false, fromServiceWorker: false, fromCache: false, child: null, t: Date.now() - 5000, endedAt: Date.now() - 5000, ...o });
  return { w, entries, add, chrome, kept, state };
}

const BOOK = /** @type {const} */ ({ kind: 'business', urlGlob: '*/api/book', success: { path: 'status', equals: 'OK' }, match: { train: '123' }, limits: 'the site could still cancel later' });

test('no assertions: unverified, not completed', async () => {
  const { w } = bridge();
  const r = await (await open(w)).waitFor([], { sinceActionId: 'a1' });
  assert.deepEqual([r.completed, r.verdict], [false, 'unverified']);
});

test('network: at most "site replied", never a business result', async () => {
  const { w, add } = bridge();
  add('R1');
  const r = await (await open(w)).waitFor([{ kind: 'network', urlGlob: '*/api/book' }], { sinceActionId: 'a1', timeoutMs: 0 });
  assert.deepEqual([r.completed, r.level, r.results[0].level, r.judgedBy], [true, 'site_replied', 'site_replied', 'sdk']);
  assert.equal(r.results[0].evidence?.recordId, 'n1');
});

test('business: needs a success condition, matching data, a source and limits; only then "business confirmed"', async () => {
  const { w, add, chrome } = bridge();
  const tab = await open(w);
  for (const bad of [{ ...BOOK, match: {} }, { ...BOOK, limits: ' ' }, { ...BOOK, success: undefined }, { ...BOOK, urlGlob: undefined }]) {
    await rejectsWith(() => tab.waitFor([/** @type {any} */ (bad)], { sinceActionId: 'a1' }), 'bad_argument');
  }
  await rejectsWith(() => tab.waitFor([BOOK]), 'bad_argument'); // no mark
  add('R1');
  chrome.set('R1', JSON.stringify({ status: 'OK', train: '123' }));
  const r = await tab.waitFor([BOOK], { sinceActionId: 'a1', timeoutMs: 0 });
  assert.deepEqual([r.completed, r.level, r.results[0].evidence?.limits], [true, 'business_confirmed', BOOK.limits]);
});

test('business: another request to the same URL with other data does not count', async () => {
  const { w, add, chrome } = bridge();
  add('OTHER');
  chrome.set('OTHER', JSON.stringify({ status: 'OK', train: '999' }));
  const r = await (await open(w)).waitFor([BOOK], { sinceActionId: 'a1', timeoutMs: 0 });
  assert.deepEqual([r.completed, r.verdict, r.results[0].status], [false, 'not_proven', 'not_proven']);
  assert.match(String(r.results[0].note), /train is "999"/);
});

test('bodies: what the bridge kept decides, never the text the SDK itself got back', async () => {
  {
    const { w, add, chrome } = bridge();
    add('R1');
    chrome.set('R1', JSON.stringify({ status: 'FAILED', train: '123' })); // the SDK's own copy would say "IGNORED"
    const r = await (await open(w)).waitFor([{ kind: 'network', urlGlob: '*/api/book', bodyIncludes: 'IGNORED' }], { sinceActionId: 'a1', timeoutMs: 0 });
    assert.equal(r.completed, false);
  }
  {
    const { w, add, chrome } = bridge();
    add('R1');
    chrome.set('R1', '{"status":"OK"}');
    const r = await (await open(w)).waitFor([{ kind: 'network', urlGlob: '*/api/book', bodyIncludes: '"OK"' }], { sinceActionId: 'a1', timeoutMs: 0 });
    assert.equal(r.completed, true);
    assert.ok(w.sent.some((m) => m.method === 'Network.getResponseBody' && m.sessionId === 'ROOT'), 'asked Chrome on the entry\'s session');
  }
});

test('any unobservable assertion means not completed, whatever the others say', async () => {
  const { w, state } = bridge({ unobservable: true, why: ['Network.disable'] });
  state.url = 'https://a.test/done';
  const r = await (await open(w)).waitFor([{ kind: 'url', glob: '*/done' }, { kind: 'network', urlGlob: '*' }], { sinceActionId: 'a1', timeoutMs: 0 });
  assert.deepEqual([r.completed, r.verdict, r.results.map((x) => x.status)], [false, 'unobservable', ['proven', 'unobservable']]);
});

test('quiet is a helper: on its own it completes nothing', async () => {
  const { w } = bridge();
  const r = await (await open(w)).waitFor([{ kind: 'quiet', ms: 100 }], { sinceActionId: 'a1', timeoutMs: 0 });
  assert.deepEqual([r.results[0].status, r.completed, r.verdict], ['proven', false, 'not_proven']);
});

test('waiting: a response that arrives later is picked up before the time runs out', async () => {
  const { w, add } = bridge();
  const tab = await open(w);
  setTimeout(() => add('LATE'), 50);
  const r = await tab.waitFor([{ kind: 'network', urlGlob: '*/api/book' }], { sinceActionId: 'a1', timeoutMs: 2000, pollMs: 20 });
  assert.equal(r.completed, true);
});

// ---------- the observation window ----------

test('the window turning unobservable while bodies are fetched counts; the earlier answer does not', async () => {
  const { w, add, chrome, state } = bridge();
  add('R1');
  chrome.set('R1', JSON.stringify({ status: 'OK', train: '123' }));
  state.offAfterBody = true; // Network.disable lands between the first query and the body query
  const r = await (await open(w)).waitFor([BOOK], { sinceActionId: 'a1', timeoutMs: 0 });
  assert.deepEqual([r.completed, r.verdict, r.results[0].status], [false, 'unobservable', 'unobservable']);
});

test('quiet counts from the mark, not from the beginning of time; frames possibly missing make it unknowable', async () => {
  {
    const { w, state } = bridge();
    state.markT = Date.now(); // marked just now, nothing since
    const r = await (await open(w)).waitFor([{ kind: 'url', glob: '*' }, { kind: 'quiet', ms: 60_000 }], { sinceActionId: 'a1', timeoutMs: 0 });
    assert.deepEqual([r.completed, r.results[1].status], [false, 'not_proven']);
  }
  {
    const { w, state } = bridge();
    state.partial = true;
    const r = await (await open(w)).waitFor([{ kind: 'url', glob: '*' }, { kind: 'quiet', ms: 100 }], { sinceActionId: 'a1', timeoutMs: 0 });
    assert.deepEqual([r.completed, r.results[1].status], [false, 'unobservable']);
  }
});
