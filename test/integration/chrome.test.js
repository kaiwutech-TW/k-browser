// @ts-check
// The real extension in Chrome for Testing, driven through the real bridge by a CDP client shaped like Kav.
// Order: the minimal Kav path (and that scripts / bindings really go
// away on detach), tab lifecycle and ownership, OOPIF child sessions, then bridge restart and extension reload.
// Skipped when no Chrome for Testing is installed. Run: npm run test:chrome

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as auth from '../../src/auth.js';
import { startBridge } from '../../src/server.js';
import { FakeCdp, sleep, until } from '../fakes.js';
import { findChrome, fixtures, launchChrome } from './cft.js';

const CHROME = findChrome();
const skip = CHROME ? false : 'Chrome for Testing not found (set KBROWSER_TEST_CHROME)';

/** @type {Awaited<ReturnType<typeof startBridge>>} */ let bridge;
/** @type {Awaited<ReturnType<typeof launchChrome>>} */ let chrome;
/** @type {Awaited<ReturnType<typeof fixtures>>} */ let site;
/** @type {string} */ let token;
/** @type {string[]} */ const logs = [];

/** until() for async predicates. @param {() => Promise<boolean>} pred @param {number} [ms] */
async function untilAsync(pred, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(100);
  }
  return pred();
}

/** @param {FakeCdp} cdp @param {string} method @param {(e: any) => boolean} [pred] @param {number} [ms] */
async function event(cdp, method, pred = () => true, ms = 10000) {
  assert.ok(await until(() => cdp.named(method).some(pred), ms), `no ${method}`);
  return cdp.named(method).find(pred);
}

/** @param {FakeCdp} cdp @param {string} sid @param {string} expression */
async function evaluate(cdp, sid, expression) {
  const r = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

/** Navigate and wait for a new load event of THIS session. @param {FakeCdp} cdp @param {string} sid @param {string} url */
async function navigate(cdp, sid, url) {
  const loads = () => cdp.named('Page.loadEventFired').filter((e) => e.sessionId === sid).length;
  const before = loads();
  await cdp.call('Page.navigate', { url }, sid);
  assert.ok(await until(() => loads() > before, 10000), `load of ${url}`);
}

/** A real click at an element's centre. @param {FakeCdp} cdp @param {string} sid @param {string} selector */
async function click(cdp, sid, selector) {
  const { x, y } = await evaluate(cdp, sid, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.call('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 }, sid);
  }
}

async function startAndPair(port = 0) {
  bridge = await startBridge({ port, revokePollMs: 200, log: (l) => logs.push(l) });
  await chrome.pair(/** @type {string} */ (auth.pairKey({ create: true })), bridge.port);
  assert.ok(await until(() => bridge.relay.ext !== null, 15000), 'the extension connected and reconciled');
}

/** @param {FakeCdp} cdp @param {string} [url] */
async function openSession(cdp, url = site.url('/page')) {
  const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank', background: true });
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
  await cdp.call('Page.enable', {}, sessionId);
  await cdp.call('Runtime.enable', {}, sessionId);
  await navigate(cdp, sessionId, url);
  return { targetId, sessionId };
}

before(async () => {
  if (skip) return;
  process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-int-'));
  token = auth.addClient('kav');
  site = await fixtures();
  chrome = await launchChrome({ chrome: /** @type {string} */ (CHROME) });
  await startAndPair();
});

after(async () => {
  if (skip) return;
  await bridge?.close();
  await chrome?.close();
  await site?.close();
});

test('the Kav path: create, attach, navigate, evaluate, network events, screenshot', { skip }, async () => {
  const cdp = await new FakeCdp(bridge.base, token).connect();
  const { sessionId } = await openSession(cdp, 'about:blank');
  await cdp.call('Network.enable', {}, sessionId);
  await navigate(cdp, sessionId, site.url('/page'));
  assert.equal(await evaluate(cdp, sessionId, 'document.title'), 'fixture');
  await event(cdp, 'Network.requestWillBeSent', (e) => e.sessionId === sessionId && e.params.request.url.endsWith('/page'));
  await event(cdp, 'Runtime.executionContextCreated', (e) => e.sessionId === sessionId);
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png' }, sessionId);
  assert.ok(shot.data.length > 1000, 'a real screenshot');
  await cdp.close();
});

test('CDP input reaches the page as trusted events', { skip }, async () => {
  const cdp = await new FakeCdp(bridge.base, token).connect();
  const { sessionId } = await openSession(cdp);
  await click(cdp, sessionId, '#b');
  assert.equal(await evaluate(cdp, sessionId, 'window.__clicked'), true);
  await cdp.close();
});

test('bindings and new-document scripts work, and are gone after detach', { skip }, async () => {
  const cdp = await new FakeCdp(bridge.base, token).connect();
  const { targetId, sessionId } = await openSession(cdp);
  await cdp.call('Runtime.addBinding', { name: '__kb' }, sessionId);
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__kbScript = 1' }, sessionId);
  await navigate(cdp, sessionId, site.url('/page'));
  assert.equal(await evaluate(cdp, sessionId, 'window.__kbScript'), 1);
  await evaluate(cdp, sessionId, "__kb('hello'), true");
  const called = await event(cdp, 'Runtime.bindingCalled', (e) => e.sessionId === sessionId);
  assert.equal(called.params.payload, 'hello');

  await cdp.call('Target.detachFromTarget', { sessionId });
  const again = (await cdp.call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await cdp.call('Page.enable', {}, again);
  await navigate(cdp, again, site.url('/page'));
  assert.equal(await evaluate(cdp, again, 'typeof window.__kbScript'), 'undefined', 'the script ended with its session');
  assert.equal(await evaluate(cdp, again, 'typeof window.__kb'), 'undefined', 'the binding ended with its session');
  await cdp.close();
});

test('a popup from an owned tab is adopted; a tab the user opened is invisible', { skip }, async () => {
  const cdp = await new FakeCdp(bridge.base, token).connect();
  await cdp.call('Target.setDiscoverTargets', { discover: true });
  const { targetId, sessionId } = await openSession(cdp, site.url('/opener'));
  await click(cdp, sessionId, '#b');
  const popup = await event(cdp, 'Target.targetCreated', (e) => e.params.targetInfo.openerId === targetId);
  const users = await chrome.userTab(site.url('/page'));
  await sleep(300);
  const ids = (await cdp.call('Target.getTargets')).targetInfos.map((/** @type {any} */ t) => t.targetId);
  assert.ok(ids.includes(popup.params.targetInfo.targetId), 'popup adopted');
  assert.ok(!ids.includes(users), "the user's tab is not visible");
  const r = await cdp.raw('Target.attachToTarget', { targetId: users, flatten: true });
  assert.match(r.error?.message ?? '', /No target/);
  await cdp.close();
});

test('a popup that closes the instant it opens leaves nothing registered', { skip }, async () => {
  const cdp = await new FakeCdp(bridge.base, token).connect();
  await cdp.call('Target.setDiscoverTargets', { discover: true });
  const { targetId, sessionId } = await openSession(cdp, site.url('/flash'));
  const adoptionsBefore = bridge.relay.stats.adoptionsStarted;
  for (let i = 0; i < 5; i++) await click(cdp, sessionId, '#b');
  assert.equal(await evaluate(cdp, sessionId, 'window.__opened'), 5, 'the page really opened five popups');
  assert.ok(await until(() => bridge.relay.stats.adoptionsStarted > adoptionsBefore, 3000), 'K-Browser saw them and started adopting');
  await sleep(1500);
  const ids = (await cdp.call('Target.getTargets')).targetInfos.map((/** @type {any} */ t) => t.targetId);
  assert.ok(ids.includes(targetId));
  // Invariant: everything the bridge has registered exists in Chrome right now.
  const { targetInfos } = await chrome.control.call('Target.getTargets');
  const inChrome = new Set(targetInfos.map((/** @type {any} */ t) => t.targetId));
  for (const id of bridge.relay.targets.keys()) assert.ok(inChrome.has(id), `registered target ${id} is gone from Chrome`);
  await cdp.close();
});

test('input to a page hidden behind its own popup: hangs without focus emulation, works with it (characterization)', { skip }, async () => {
  // Kav enables Emulation.setFocusEmulationEnabled on every tab (kfw/page.py). Pin down what
  // that changes for a hidden page in this Chrome, so the window strategy is decided on evidence.
  const cdp = await new FakeCdp(bridge.base, token).connect();
  const { targetId, sessionId } = await openSession(cdp, site.url('/opener'));
  await click(cdp, sessionId, '#b'); // opens a popup in the same window: the opener becomes hidden
  await event(cdp, 'Target.targetCreated', (e) => e.params.targetInfo.openerId === targetId).catch(() => {});
  // The bridge turns focus emulation on at attach; switch it off to see Chrome's own behaviour.
  await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: false }, sessionId);
  await sleep(300);
  assert.equal(await evaluate(cdp, sessionId, 'document.visibilityState'), 'hidden');
  const without = await cdp.raw('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }, sessionId, 3000).catch(() => ({ error: { message: 'timed out' } }));
  await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
  await sleep(100);
  const visibleWith = await evaluate(cdp, sessionId, 'document.visibilityState');
  const started = Date.now();
  const withIt = await cdp.raw('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 6, y: 6 }, sessionId, 3000).catch(() => ({ error: { message: 'timed out' } }));
  console.log(`[characterization] hidden opener: without focus emulation -> ${without.error ? 'no answer' : 'ok'}; `
    + `with it -> visibility=${visibleWith}, input ${withIt.error ? 'no answer' : `ok in ${Date.now() - started} ms`}`);
  assert.ok(without.error, 'without focus emulation the input is not processed');
  assert.ok(!withIt.error, 'with focus emulation the input is processed');
  await cdp.close();
});

test('four tabs in the one K-Browser window all take trusted input concurrently', { skip }, async () => {
  const cdp = await new FakeCdp(bridge.base, token).connect();
  const pages = [];
  for (let i = 0; i < 4; i++) pages.push(await openSession(cdp)); // all but the window's active tab are background tabs
  const windows = new Set();
  for (const p of pages) windows.add((await chrome.control.call('Browser.getWindowForTarget', { targetId: p.targetId })).windowId);
  assert.equal(windows.size, 1, 'one K-Browser window');
  const hidden = await Promise.all(pages.map((p) => evaluate(cdp, p.sessionId, 'document.visibilityState')));
  await Promise.all(pages.map((p) => click(cdp, p.sessionId, '#b')));
  const clicked = await Promise.all(pages.map((p) => evaluate(cdp, p.sessionId, 'window.__clicked')));
  assert.deepEqual(clicked, [true, true, true, true], `visibility seen: ${hidden.join(',')}`);
  await cdp.close();
});

test('two first tabs created at once open one K-Browser window, not two', { skip }, async () => {
  const one = await new FakeCdp(bridge.base, token).connect();
  const two = await new FakeCdp(bridge.base, auth.addClient('second')).connect();
  bridge.relay.windowId = null; // as if the K-Browser window were gone: the next creates must open exactly one
  const [a, b] = await Promise.all([one.call('Target.createTarget', { url: site.url('/page') }), two.call('Target.createTarget', { url: site.url('/page') })]);
  const wa = (await chrome.control.call('Browser.getWindowForTarget', { targetId: a.targetId })).windowId;
  const wb = (await chrome.control.call('Browser.getWindowForTarget', { targetId: b.targetId })).windowId;
  assert.equal(wa, wb);
  await one.close();
  await two.close();
});

test('a minimized K-Browser window is restored before a screenshot of an existing tab', { skip }, async () => {
  const cdp = await new FakeCdp(bridge.base, token).connect();
  const { targetId, sessionId } = await openSession(cdp);
  const { windowId } = await chrome.control.call('Browser.getWindowForTarget', { targetId });
  await chrome.control.call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  const { bounds } = await chrome.control.call('Browser.getWindowBounds', { windowId });
  if (bounds.windowState !== 'minimized') {
    console.log(`[note] this Chrome does not minimize windows (state=${bounds.windowState}); restore path not exercised here`);
  }
  const shot = await cdp.raw('Page.captureScreenshot', { format: 'png' }, sessionId, 8000);
  assert.ok(shot.result?.data, 'screenshot works');
  assert.notEqual((await chrome.control.call('Browser.getWindowBounds', { windowId })).bounds.windowState, 'minimized');
  await cdp.close();
});

test('cross-site methods are refused before they reach Chrome', { skip }, async () => {
  const cdp = await new FakeCdp(bridge.base, token).connect();
  const { sessionId } = await openSession(cdp);
  for (const [method, params] of /** @type {[string, any][]} */ ([['Network.getAllCookies', {}], ['Storage.getCookies', {}],
    ['Page.navigate', { url: `file://${os.homedir()}` }]])) {
    assert.ok((await cdp.raw(method, params, sessionId)).error, method);
  }
  await cdp.close();
});

test('an out-of-process iframe gets a child session through session-level auto-attach', { skip }, async () => {
  const cdp = await new FakeCdp(bridge.base, token).connect();
  const { sessionId } = await openSession(cdp, site.url('/frame-host'));
  await cdp.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  const att = await event(cdp, 'Target.attachedToTarget', (e) => e.sessionId === sessionId && e.params.targetInfo.type === 'iframe');
  const child = att.params.sessionId;
  assert.equal(await evaluate(cdp, child, 'location.host'), `localhost:${site.portB}`);
  await cdp.close();
});

test('a service-worker restart keeps the same lifetime: targets survive and can be attached again', { skip }, async () => {
  const cdp = await new FakeCdp(bridge.base, token).connect();
  const { targetId } = await openSession(cdp);
  const boot = bridge.relay.bootId;
  await chrome.stopWorker();
  assert.ok(await until(() => bridge.relay.ext === null, 10000), 'the link dropped with the worker');
  // Nothing pokes the worker: it comes back on its own (alarm every 30 s) and reconnects under the same bootId.
  assert.ok(await until(() => bridge.relay.ext !== null, 45000), 'the worker came back and reconnected');
  assert.equal(bridge.relay.bootId, boot, 'storage.session survived: same extension lifetime');
  const ids = (await cdp.call('Target.getTargets')).targetInfos.map((/** @type {any} */ t) => t.targetId);
  assert.ok(ids.includes(targetId), 'the tab is still ours (earlier tests own others too)');
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
  assert.equal(await evaluate(cdp, sessionId, 'document.title'), 'fixture');
  await cdp.close();
});

test('a bridge restart forgets every tab and leaves no debugger attached', { skip }, async () => {
  const cdp = await new FakeCdp(bridge.base, token).connect();
  const { targetId } = await openSession(cdp);
  assert.equal(await chrome.attached(targetId), true);
  const port = bridge.port;
  await bridge.close();
  await startAndPair(port); // same port and home: the extension reconnects by itself (retry within seconds)
  assert.ok(await untilAsync(async () => (await chrome.attached(targetId)) === false),
    'own.sync detached what the old bridge had attached');
  const fresh = await new FakeCdp(bridge.base, token).connect();
  assert.deepEqual((await fresh.call('Target.getTargets')).targetInfos, []);
  await fresh.close();
});

test('a Chrome restart is a new lifetime: old targets are destroyed, nothing is inherited', { skip }, async () => {
  // (chrome.runtime.reload() would be the cheaper lifetime change, but in Chrome for Testing an extension loaded with
  // --load-extension does not come back after it.)
  const cdp = await new FakeCdp(bridge.base, token).connect();
  await cdp.call('Target.setDiscoverTargets', { discover: true });
  const { targetId } = await openSession(cdp);
  const oldBoot = bridge.relay.bootId;
  await chrome.quit();
  chrome = await launchChrome({ chrome: /** @type {string} */ (CHROME), profile: chrome.profile }); // same profile: still paired
  assert.ok(await until(() => bridge.relay.ext !== null && bridge.relay.bootId !== oldBoot, 20000), 'reconnected under a new bootId');
  await event(cdp, 'Target.targetDestroyed', (e) => e.params.targetId === targetId);
  assert.deepEqual((await cdp.call('Target.getTargets')).targetInfos, []);
  // and the new lifetime works
  const again = await openSession(cdp);
  assert.equal(await evaluate(cdp, again.sessionId, 'document.title'), 'fixture');
  await cdp.close();
});
