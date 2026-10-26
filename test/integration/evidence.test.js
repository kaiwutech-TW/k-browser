// @ts-check
// In Chrome for Testing: the bridge's observation log and the SDK's evidence contract on local fixtures: a
// booking form whose API echoes the input, a slow API, a redirect chain, a service worker. Run: npm run test:chrome

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as auth from '../../src/auth.js';
import { Browser } from '../../src/sdk/index.js';
import { startBridge } from '../../src/server.js';
import { sleep, until } from '../fakes.js';
import { findChrome, fixtures, launchChrome } from './cft.js';

const CHROME = findChrome();
const skip = CHROME ? false : 'Chrome for Testing not found (set KBROWSER_TEST_CHROME)';

/** @type {Awaited<ReturnType<typeof startBridge>>} */ let bridge;
/** @type {Awaited<ReturnType<typeof launchChrome>>} */ let chrome;
/** @type {Awaited<ReturnType<typeof fixtures>>} */ let site;
/** @type {Browser} */ let browser;

before(async () => {
  if (skip) return;
  process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-evidence-'));
  const token = auth.addClient('evidence');
  site = await fixtures();
  chrome = await launchChrome({ chrome: /** @type {string} */ (CHROME) });
  bridge = await startBridge({ port: 0, log: () => {} });
  await chrome.pair(/** @type {string} */ (auth.pairKey({ create: true })), bridge.port);
  assert.ok(await until(() => bridge.relay.ext !== null, 15000), 'the extension connected');
  browser = await Browser.connect(`${bridge.base}/c/${token}`);
});

after(async () => {
  if (skip) return;
  browser?.close();
  await bridge?.close();
  await chrome?.close();
  await site?.close();
});

/** @param {string} p */
async function tabAt(p) {
  const tab = await browser.newTab(site.url(p));
  await sleep(200);
  await tab.settled();
  return tab;
}

/** @param {{ refs: { ref: string, name: string }[] }} snap @param {string} name */
function refOf(snap, name) {
  const r = snap.refs.find((x) => x.name === name);
  assert.ok(r, `a ref for "${name}"`);
  return r.ref;
}

const BOOK = (/** @type {string} */ train) => /** @type {const} */ ({ kind: 'business', urlGlob: '*/api/book', method: 'POST',
  success: { path: 'status', equals: 'OK' }, match: { train }, limits: 'the fixture API echoes the input; a real site may still cancel later' });

test('a form sent: the network shows "site replied"; the business contract with matching data shows "business confirmed"', { skip }, async () => {
  const tab = await tabAt('/book');
  try {
    const snap = await tab.snapshot();
    const { actionId } = await tab.mark('book train 123');
    await tab.type(refOf(snap, 'train'), '123');
    await tab.type(refOf(snap, 'date'), '2026-11-01');
    await tab.click(refOf(snap, 'book'));
    const net = await tab.waitFor([{ kind: 'network', urlGlob: '*/api/book', method: 'POST' }], { sinceActionId: actionId });
    assert.deepEqual([net.completed, net.level], [true, 'site_replied']);
    const biz = await tab.waitFor([BOOK('123'), { kind: 'text', includes: 'booked 123' }], { sinceActionId: actionId });
    assert.deepEqual([biz.completed, biz.level, biz.results.map((r) => r.level)], [true, 'business_confirmed', ['business_confirmed', 'screen_changed']]);
    const q = await browser.client.call('KBrowser.queryNetwork', { targetId: tab.targetId, sinceActionId: actionId, urlGlob: '*/api/book', includeBody: true });
    assert.equal(JSON.parse(q.entries[0].body.text).train, '123', 'the record keeps the body the bridge saw');
  } finally {
    await tab.close();
  }
});

test('a request sent before the mark, answered after it, does not count', { skip }, async () => {
  const tab = await tabAt('/book');
  try {
    const snap = await tab.snapshot();
    await tab.click(refOf(snap, 'slow')); // the request is under way (the API answers in 0.8 s)
    const { actionId } = await tab.mark('after the slow request was sent');
    const r = await tab.waitFor([{ kind: 'network', urlGlob: '*/api/slow' }], { sinceActionId: actionId, timeoutMs: 2000 });
    assert.deepEqual([r.completed, r.verdict], [false, 'not_proven']);
    const all = await browser.client.call('KBrowser.queryNetwork', { targetId: tab.targetId, urlGlob: '*/api/slow' });
    assert.equal(all.entries[0]?.status, 200, 'it was answered (after the mark): it is just not "after the action"');
  } finally {
    await tab.close();
  }
});

test('another request to the same URL with other data after the action does not prove this operation', { skip }, async () => {
  const tab = await tabAt('/book');
  try {
    const snap = await tab.snapshot();
    const { actionId } = await tab.mark('book train 123');
    await tab.click(refOf(snap, 'book other')); // the page books 999 instead
    const r = await tab.waitFor([BOOK('123')], { sinceActionId: actionId, timeoutMs: 1500 });
    assert.deepEqual([r.completed, r.verdict], [false, 'not_proven']);
    assert.match(String(r.results[0].note), /train is "999"/);
  } finally {
    await tab.close();
  }
});

test('a redirect chain: each hop is its own record', { skip }, async () => {
  const tab = await tabAt('/book');
  try {
    const snap = await tab.snapshot();
    const { actionId } = await tab.mark('redirect');
    await tab.click(refOf(snap, 'redirect'));
    const r = await tab.waitFor([{ kind: 'network', urlGlob: '*/final' }], { sinceActionId: actionId });
    assert.equal(r.completed, true);
    const q = await browser.client.call('KBrowser.queryNetwork', { targetId: tab.targetId, sinceActionId: actionId });
    const hops = q.entries.filter((/** @type {any} */ e) => /\/(r1|r2|final)$/.test(e.url)).map((/** @type {any} */ e) => [e.url.replace(/.*\//, ''), e.hop, e.status]);
    assert.deepEqual(hops, [['r1', 0, 302], ['r2', 1, 301], ['final', 2, 200]]);
    assert.equal(new Set(q.entries.filter((/** @type {any} */ e) => /\/(r1|r2|final)$/.test(e.url)).map((/** @type {any} */ e) => e.requestId)).size, 1, 'one requestId across the chain');
  } finally {
    await tab.close();
  }
});

test('a service worker answer is marked as such', { skip }, async () => {
  const tab = await tabAt('/sw');
  try {
    let controlled = false;
    for (let i = 0; i < 50 && !controlled; i++) {
      controlled = await tab.evaluate(() => !!navigator.serviceWorker.controller);
      if (!controlled) await sleep(100);
    }
    assert.ok(controlled, 'the service worker controls the page');
    const snap = await tab.snapshot();
    const { actionId } = await tab.mark('sw fetch');
    await tab.click(refOf(snap, 'sw fetch'));
    const r = await tab.waitFor([{ kind: 'network', urlGlob: '*/sw-data', bodyIncludes: '"sw"' }], { sinceActionId: actionId });
    assert.equal(r.completed, true);
    assert.equal(r.results[0].evidence?.fromServiceWorker, true);
  } finally {
    await tab.close();
  }
});

test('after Network.disable the window is unobservable and nothing is completed', { skip }, async () => {
  const tab = await tabAt('/book');
  try {
    const snap = await tab.snapshot();
    const { actionId } = await tab.mark('then the network is switched off');
    await browser.client.call('Network.disable', {}, tab.sessionId);
    await tab.click(refOf(snap, 'book'));
    const r = await tab.waitFor([{ kind: 'network', urlGlob: '*/api/book' }, { kind: 'text', includes: 'booked' }], { sinceActionId: actionId, timeoutMs: 2000 });
    assert.deepEqual([r.completed, r.verdict, r.results[0].status], [false, 'unobservable', 'unobservable']);
    assert.match(String(r.results[0].note), /Network\.disable/);
  } finally {
    await tab.close();
  }
});

test('an old request redirected after the mark is still the old request', { skip }, async () => {
  const tab = await tabAt('/book');
  try {
    const snap = await tab.snapshot();
    await tab.click(refOf(snap, 'slow redirect')); // reaches the server now; its 302 comes 0.8 s later
    await sleep(200);
    const { actionId } = await tab.mark('after the old request started');
    const r = await tab.waitFor([{ ...BOOK('123'), urlGlob: '*/api/booked', method: 'GET' }], { sinceActionId: actionId, timeoutMs: 2500 });
    assert.deepEqual([r.completed, r.verdict], [false, 'not_proven']);
    const all = await browser.client.call('KBrowser.queryNetwork', { targetId: tab.targetId, urlGlob: '*/api/booked' });
    assert.equal(all.entries[0]?.hop, 1, 'it did arrive, as the second hop of the old request');
  } finally {
    await tab.close();
  }
});

test('an OOPIF switching its network off makes the window partial, and quiet unprovable', { skip }, async () => {
  const tab = await tabAt('/frames');
  try {
    for (let i = 0; i < 50 && tab.frames().filter((f) => f.oopif).length < 2; i++) await sleep(100);
    const child = tab.frames().find((f) => f.oopif);
    const sid = child && tab.tree.stamp(child.frameId)?.sessionId;
    assert.ok(sid, 'an OOPIF session');
    const { actionId } = await tab.mark('then the OOPIF network goes off and on');
    await browser.client.call('Network.disable', {}, sid);
    await browser.client.call('Network.enable', {}, sid);
    const q = await browser.client.call('KBrowser.queryNetwork', { targetId: tab.targetId, sinceActionId: actionId });
    assert.deepEqual([q.unobservable, q.partial], [false, true]);
    const r = await tab.waitFor([{ kind: 'url', glob: '*/frames' }, { kind: 'quiet', ms: 100 }], { sinceActionId: actionId, timeoutMs: 1000 });
    assert.deepEqual([r.completed, r.results[1].status], [false, 'unobservable']);
  } finally {
    await tab.close();
  }
});
