// @ts-check
// The extension popup in Chrome for Testing with the real extension and bridge: the pairing field shows itself only
// while pairing is what is missing (not paired yet, or the bridge refused the code) and folds away once connected,
// behind "重新配對…", so the code cannot be pasted over by mistake. Run: npm run test:chrome

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as auth from '../../src/auth.js';
import { startBridge } from '../../src/server.js';
import { eventually } from './mcp-harness.js';
import { findChrome, launchChrome } from './cft.js';

const CHROME = findChrome();
const skip = CHROME ? false : 'Chrome for Testing not found (set KBROWSER_TEST_CHROME)';

/** @type {Awaited<ReturnType<typeof startBridge>>} */ let bridge;
/** @type {Awaited<ReturnType<typeof launchChrome>>} */ let chrome;

before(async () => {
  if (skip) return;
  process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-popup-'));
  chrome = await launchChrome({ chrome: /** @type {string} */ (CHROME) });
  bridge = await startBridge({ port: 0, log: () => {} });
});

after(async () => {
  if (skip) return;
  await bridge?.close();
  await chrome?.close();
});

/** What the popup shows: its state line, and whether the pairing field and the "重新配對…" link are visible. The tab
 * can be there before its document is parsed: nothing to show yet then.
 * @param {{ eval: (e: string) => Promise<any> }} p */
const view = (p) => p.eval(`document.getElementById('repair') ? { state: document.getElementById('state').className,
  pairing: !document.getElementById('pairing').hidden, repair: !document.getElementById('repair').hidden } : { state: '' }`);

test('the pairing field: shown while unpaired, folded once connected (one click unfolds it), back by itself when the bridge refuses the code', { skip }, async () => {
  let popup = await chrome.extensionPage('popup.html');
  try {
    assert.ok(await eventually(async () => (await view(popup)).state.includes('unpaired'), 10000), JSON.stringify(await view(popup)));
    assert.deepEqual(await view(popup), { state: 'state unpaired', pairing: true, repair: false });

    await chrome.pair(/** @type {string} */ (auth.pairKey({ create: true })), bridge.port);
    assert.ok(await eventually(async () => (await view(popup)).state.includes('online'), 15000), JSON.stringify(await view(popup)));
    assert.deepEqual(await view(popup), { state: 'state online', pairing: false, repair: true }, 'connected: folded away');

    await popup.eval(`document.getElementById('repair').click(), true`);
    assert.ok(await eventually(async () => (await view(popup)).pairing, 2000));
    assert.equal((await view(popup)).repair, false);
  } finally {
    await popup.close();
  }

  // a wrong code: the bridge refuses it, and a freshly opened popup shows the field without any click
  await chrome.pair('kbWrongPairingCode0123456789abcdefXYZ', bridge.port);
  popup = await chrome.extensionPage('popup.html');
  try {
    assert.ok(await eventually(async () => (await view(popup)).state.includes('error'), 15000), JSON.stringify(await view(popup)));
    assert.deepEqual(await view(popup), { state: 'state error', pairing: true, repair: false });
  } finally {
    await popup.close();
  }
});
