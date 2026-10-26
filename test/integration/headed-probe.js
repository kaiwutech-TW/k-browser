// @ts-check
// Characterization, not a pass/fail test: in a HEADED Chrome for Testing, when can a K-Browser page take CDP input?
// Decides the window strategy (CDP input to a hidden background tab can hang). Opens visible windows on screen.
// Run: node test/integration/headed-probe.js

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as auth from '../../src/auth.js';
import { startBridge } from '../../src/server.js';
import { FakeCdp, sleep, until } from '../fakes.js';
import { findChrome, fixtures, launchChrome } from './cft.js';

process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-headed-'));
const token = auth.addClient('probe');
const site = await fixtures();
const chrome = await launchChrome({ chrome: /** @type {string} */ (findChrome()), headless: false });
const bridge = await startBridge({ port: 0, log: () => {} });
/** @type {Record<string, any>[]} */
const rows = [];
try {
  await chrome.pair(/** @type {string} */ (auth.pairKey({ create: true })), bridge.port);
  if (!await until(() => bridge.relay.ext !== null, 15000)) throw new Error('extension did not connect');
  const cdp = await new FakeCdp(bridge.base, token).connect();
  const ctl = chrome.control;

  /** @param {string} sid @param {string} expression */
  const evaluate = async (sid, expression) => {
    const r = await cdp.raw('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid, 5000).catch(() => null);
    return r?.result?.result?.value ?? (r ? `error:${r.error?.message}` : 'no answer');
  };
  /** ok / CDP error / no answer within the deadline, kept apart. @param {string} sid @param {string} method @param {any} params @param {number} ms */
  const attempt = async (sid, method, params, ms) => {
    const t = Date.now();
    const r = await cdp.raw(method, params, sid, ms).catch(() => null);
    if (!r) return `no answer in ${ms}ms`;
    if (r.error) return `error: ${r.error.message}`;
    return `ok ${Date.now() - t}ms`;
  };
  /** @param {string} sid */
  const tryInput = (sid) => attempt(sid, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }, 3000);
  /** @param {string} sid */
  const tryShot = (sid) => attempt(sid, 'Page.captureScreenshot', { format: 'png' }, 4000);
  /** setTimeout(100) actual delay: throttled pages stretch it to ~1000 ms. @param {string} sid */
  const timer = (sid) => evaluate(sid, 'new Promise(r => { const t = performance.now(); setTimeout(() => r(Math.round(performance.now() - t)), 100); })');

  /** @param {string} scenario @param {string} sid */
  async function measure(scenario, sid) {
    for (const focusEmulation of [false, true]) {
      // Set explicitly each time: the bridge turns it on at attach.
      await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: focusEmulation }, sid);
      await sleep(400);
      rows.push({ scenario, focusEmulation, visibility: await evaluate(sid, 'document.visibilityState'),
        hasFocus: await evaluate(sid, 'document.hasFocus()'), input: await tryInput(sid), screenshot: await tryShot(sid),
        'setTimeout(100)': await timer(sid) });
    }
  }

  /** a fresh K-Browser page with its own session */
  async function page(url = site.url('/page')) {
    const { targetId } = await cdp.call('Target.createTarget', { url, background: true });
    const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
    await cdp.call('Page.enable', {}, sessionId);
    await sleep(800);
    return { targetId, sessionId };
  }

  // ① own window, unfocused
  const a = await page();
  await measure('① own window, unfocused', a.sessionId);

  // ② opener behind its own popup (a background tab in the same window)
  const b = await page(site.url('/opener'));
  const { x, y } = await evaluate(b.sessionId, "(() => { const r = document.querySelector('#b').getBoundingClientRect(); return { x: r.left + 5, y: r.top + 5 }; })()");
  await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true }, b.sessionId); // to be able to click at all
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, b.sessionId);
  await sleep(800);
  await measure('② opener behind its popup', b.sessionId);

  // ③ window fully covered by another window
  const c = await page();
  const { windowId, bounds } = await ctl.call('Browser.getWindowForTarget', { targetId: c.targetId });
  const cover = await ctl.call('Target.createTarget', { url: 'about:blank', newWindow: true, background: false });
  const coverWin = await ctl.call('Browser.getWindowForTarget', { targetId: cover.targetId });
  await ctl.call('Browser.setWindowBounds', { windowId: coverWin.windowId,
    bounds: { left: bounds.left - 40, top: Math.max(0, bounds.top - 40), width: bounds.width + 80, height: bounds.height + 80 } });
  await ctl.call('Target.activateTarget', { targetId: cover.targetId });
  await sleep(1500);
  await measure('③ window covered by another', c.sessionId);

  // ④ window minimized
  await ctl.call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  await sleep(1500);
  // The extension now restores a minimized window before input or screenshots (window review ②): this row shows the
  // effect of that, not of minimizing itself. Re-measure ④ only with that behaviour in mind.
  await measure('④ window minimized (then restored by K-Browser before render commands)', c.sessionId);

  await cdp.close();
} finally {
  console.table(rows);
  const { execSync } = await import('node:child_process');
  const commit = (() => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
  fs.writeFileSync(path.join(os.tmpdir(), 'kb-headed-probe.json'), JSON.stringify({ commit, chrome: bridge.relay.ext?.hello?.product, rows }, null, 2));
  console.log(`commit ${commit}`);
  await bridge.close();
  await chrome.close();
  await site.close();
}
