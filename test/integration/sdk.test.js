// @ts-check
// In Chrome for Testing: the SDK through the real bridge and the real extension (chrome.debugger), on local
// fixtures with a same-origin iframe, an OOPIF and a nested OOPIF. Run: npm run test:chrome

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as auth from '../../src/auth.js';
import { Browser, SdkError, Tab } from '../../src/sdk/index.js';
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
  process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-sdk-'));
  const token = auth.addClient('sdk');
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

/** @param {() => Promise<boolean> | boolean} pred @param {number} [ms] */
async function eventually(pred, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(100);
  }
  return pred();
}

/** @param {{ refs: { ref: string, name: string }[] }} snap @param {string} name */
function refOf(snap, name) {
  const r = snap.refs.find((x) => x.name === name);
  assert.ok(r, `a ref for "${name}"`);
  return r.ref;
}

/** @param {Promise<unknown>} p */
async function stale(p) {
  await assert.rejects(p, (e) => e instanceof SdkError && e.code === 'stale_ref');
}

/** A frames page with every frame attached and known. */
async function framesTab() {
  const tab = await browser.newTab(site.url('/frames'));
  assert.ok(await eventually(async () => {
    await tab.settled();
    return tab.frames().filter((f) => f.owned).length === 4;
  }), `four frames (main, same-origin, OOPIF, nested OOPIF): ${JSON.stringify(tab.frames())}`);
  return tab;
}

test('same-origin iframe, OOPIF and nested OOPIF nodes are all in the snapshot, with working refs', { skip }, async () => {
  const tab = await framesTab();
  assert.equal(tab.frames().filter((f) => f.oopif).length, 2, 'two frames live in other processes');
  const snap = await tab.snapshot();
  console.log(`[snapshot] ${JSON.stringify(snap.stats)}\n${snap.text}`);
  for (const [name, text] of [['top button', 'top button'], ['same button', 'same button'], ['oop button', 'oop button'], ['inner link', 'inner link']]) {
    assert.equal((await tab.read(refOf(snap, name))).text, text, `read through the ref of "${name}"`);
  }
  // nesting follows the frame tree: the inner link is indented under the OOPIF's frame line
  const lines = snap.text.split('\n');
  const indent = (/** @type {string} */ s) => (lines.find((l) => l.includes(s)) ?? '').search(/\S/);
  assert.ok(indent('inner link') > indent('oop button') && indent('oop button') > indent('top button'), snap.text);
  // and each frame sits where its iframe element is: before the button that follows the iframes
  const at = (/** @type {string} */ s) => lines.findIndex((l) => l.includes(s));
  assert.ok(at('inner link') < at('bottom button') && at('same button') < at('oop button'), snap.text);
  await tab.close();
});

test('Tab.attach to a tab that is already loaded (its OOPIFs already running) finds every frame, with working refs', { skip }, async () => {
  const { targetId } = await browser.client.call('Target.createTarget', { url: site.url('/frames'), background: true });
  await sleep(1500); // loaded, iframes and all, before anyone attaches
  const tab = await Tab.attach(browser.client, targetId);
  try {
    assert.ok(await eventually(async () => {
      await tab.settled();
      return tab.frames().filter((f) => f.owned).length === 4;
    }), `four frames: ${JSON.stringify(tab.frames())}`);
    const snap = await tab.snapshot();
    for (const name of ['top button', 'same button', 'oop button', 'inner link']) assert.equal((await tab.read(refOf(snap, name))).text, name);
    await tab.click(refOf(snap, 'oop button'));
  } finally {
    await tab.close();
  }
});

test('a child frame navigating makes only its own old refs stale', { skip }, async () => {
  const tab = await framesTab();
  const snap = await tab.snapshot();
  const sameRef = refOf(snap, 'same button');
  const topRef = refOf(snap, 'top button');
  const oopRef = refOf(snap, 'oop button');
  await tab.evaluate(() => { /** @type {HTMLIFrameElement} */ (document.getElementById('same')).src = '/same2'; });
  assert.ok(await eventually(() => tab.frames().some((f) => f.url.endsWith('/same2'))), 'the child navigated');
  await stale(tab.read(sameRef));
  assert.equal((await tab.read(topRef)).text, 'top button', 'refs of other frames still work');
  assert.equal((await tab.read(oopRef)).text, 'oop button');
  assert.equal((await tab.read(refOf(await tab.snapshot(), 'same2 button'))).text, 'same2 button');
  await tab.close();
});

test('nodes without backendDOMNodeId (CSS-generated text) are shown without a ref', { skip }, async () => {
  const tab = await framesTab();
  const snap = await tab.snapshot({ full: true });
  const gen = snap.text.split('\n').filter((l) => /StaticText "gen"/.test(l));
  assert.ok(gen.length > 0, `the generated text is shown:\n${snap.text}`);
  for (const l of gen) assert.doesNotMatch(l, /\[s\d+\.\d+\]/);
  assert.match(snap.text, /StaticText "para" \[s\d+\.\d+\]/, 'real text nodes do get refs in a full snapshot');
  await tab.close();
});

test('a same-origin iframe swapped to another site: old refs stale, new snapshot refs work', { skip }, async () => {
  const tab = await framesTab();
  const sameId = tab.frames().find((f) => f.url.endsWith('/same'))?.frameId;
  const ref = refOf(await tab.snapshot(), 'same button');
  const cross = `http://localhost:${site.portB}/cross`;
  await tab.evaluate((/** @type {string} */ u) => { /** @type {HTMLIFrameElement} */ (document.getElementById('same')).src = u; }, [cross]);
  assert.ok(await eventually(async () => {
    await tab.settled();
    return tab.frames().some((f) => f.frameId === sameId && f.oopif && f.owned && f.url === cross);
  }), `the frame moved to its own process, same frameId: ${JSON.stringify(tab.frames())}`);
  await stale(tab.read(ref));
  assert.equal((await tab.read(refOf(await tab.snapshot(), 'cross button'))).text, 'cross button');
  await tab.close();
});

test('document.open() makes the frame refs stale (its old world would still answer)', { skip }, async () => {
  const tab = await framesTab();
  const snap = await tab.snapshot();
  const ref = refOf(snap, 'same button');
  const topRef = refOf(snap, 'top button');
  await tab.evaluate(() => {
    const d = /** @type {Document} */ (/** @type {HTMLIFrameElement} */ (document.getElementById('same')).contentDocument);
    d.open(); d.write('<button>rewritten</button>'); d.close();
  });
  assert.ok(await eventually(() => { try { tab.entry(ref); return false; } catch { return true; } }), 'Page.documentOpened arrived');
  await stale(tab.read(ref));
  assert.equal((await tab.read(topRef)).text, 'top button');
  assert.equal((await tab.read(refOf(await tab.snapshot(), 'rewritten'))).text, 'rewritten');
  await tab.close();
});

test('screenshot, and the footprint: no Runtime.enable was ever sent', { skip }, async () => {
  const tab = await framesTab();
  const png = await tab.screenshot();
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  await tab.snapshot();
  await tab.read();
  assert.equal(browser.client.sent.get('Runtime.enable') ?? 0, 0, 'Runtime.enable never sent (counted at the SDK CDP layer)');
  assert.ok((browser.client.sent.get('Page.createIsolatedWorld') ?? 0) > 0);
  await tab.close();
});
