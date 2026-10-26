// @ts-check
// The bridge under the real launchd, with the real extension in Chrome for Testing.
// A throwaway label, port, KBROWSER_HOME and plist directory: the user's own LaunchAgent, port 9444 and ~/.k-browser
// are never touched. Each test leaves no job behind (after() boots it out). macOS only.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as auth from '../../src/auth.js';
import { CLI_PATH } from '../../src/install.js';
import { execFileSync } from 'node:child_process';
import { plistFor, probePort, ServiceError, serviceInstall, serviceRestart, serviceStatus, serviceUninstall } from '../../src/launchd.js';
import { CdpClient } from '../../src/sdk/cdp.js';
import { startBridge } from '../../src/server.js';
import { sleep } from '../fakes.js';
import { findChrome, fixtures, launchChrome } from './cft.js';

const CHROME = findChrome();
const skip = process.platform !== 'darwin' ? 'launchd is macOS only' : CHROME ? false : 'Chrome for Testing not found (set KBROWSER_TEST_CHROME)';

/** A port nobody listens on right now. */
async function freePort() {
  const s = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const { port } = /** @type {import('node:net').AddressInfo} */ (s.address());
  await new Promise((r) => s.close(r));
  return port;
}

/** @param {() => Promise<boolean>} pred @param {number} [ms] */
async function untilAsync(pred, ms = 20000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await pred()) return true;
  return pred();
}

const LABEL = `com.k-browser.test.${process.pid}`;
/** @type {string} */ let agentsDir;
/** @type {number} */ let port;
/** @type {string} */ let token;
/** @type {Awaited<ReturnType<typeof launchChrome>>} */ let chrome;
/** @type {Awaited<ReturnType<typeof fixtures>>} */ let site;
/** @type {string[]} */ const said = [];
const where = () => ({ label: LABEL, port, agentsDir, say: (/** @type {string} */ s) => said.push(s) });

/** /health of the launchd bridge, or null. */
async function health() {
  const p = await probePort(port);
  return p.kind === 'bridge' ? p.health : null;
}

before(async () => {
  if (skip) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-launchd-int-'));
  process.env.KBROWSER_HOME = path.join(root, 'home'); // goes into the plist's EnvironmentVariables
  agentsDir = path.join(root, 'LaunchAgents');
  port = await freePort();
  token = auth.addClient('kav');
  site = await fixtures();
  chrome = await launchChrome({ chrome: /** @type {string} */ (CHROME) });
});

after(async () => {
  if (skip) return;
  await serviceUninstall(where());
  await chrome?.close();
  await site?.close();
});

test('installed as a LaunchAgent: launchd starts it in its own bare environment, the extension pairs, install again changes nothing', { skip }, async () => {
  const r = await serviceInstall(where());
  assert.equal(r.changed, true, said.join('\n'));
  const st = serviceStatus(where());
  assert.ok(st.loaded && st.pid !== null && st.plist);
  assert.equal((await health())?.pid, st.pid, 'what answers on the port is the launchd job');
  await chrome.pair(/** @type {string} */ (auth.pairKey({ create: true })), port);
  assert.ok(await untilAsync(async () => (await health())?.extension === true), 'the extension connected to the launchd bridge');
  const again = await serviceInstall(where());
  assert.equal(again.changed, false);
  assert.equal(serviceStatus(where()).pid, st.pid, 'not restarted');
});

test('a bridge started by hand, or another program, on the port: install stops and stops nothing', { skip }, async () => {
  const other = await freePort();
  const manual = await startBridge({ port: other, log: () => {} });
  try {
    await assert.rejects(serviceInstall({ ...where(), label: `${LABEL}.manual`, port: other }),
      (e) => e instanceof ServiceError && /started yourself/.test(e.message));
    assert.equal((await probePort(other)).kind, 'bridge', 'the hand-started bridge still runs');
  } finally {
    await manual.close();
  }
  const squat = net.createServer().listen(other, '127.0.0.1');
  await new Promise((r) => squat.once('listening', r));
  try {
    await assert.rejects(serviceInstall({ ...where(), label: `${LABEL}.squat`, port: other }),
      (e) => e instanceof ServiceError && new RegExp(`in use by .*pid ${process.pid}`).test(e.message));
  } finally {
    squat.close();
  }
  assert.ok(!serviceStatus({ label: `${LABEL}.manual` }).loaded && !serviceStatus({ label: `${LABEL}.squat` }).loaded);
});

test('a job under our label that runs something else (/bin/sleep; a Program key behind our arguments): left running', { skip }, async () => {
  const uid = /** @type {number} */ (process.getuid?.());
  const sleeper = path.join(agentsDir, 'sleeper.sh');
  fs.writeFileSync(sleeper, '#!/bin/sh\nexec /bin/sleep 600\n', { mode: 0o755 });
  const fake = await freePort();
  const wrap = (/** @type {string} */ label, /** @type {string} */ body) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string>${body}<key>RunAtLoad</key><true/></dict></plist>
`;
  for (const [i, make] of [
    (/** @type {string} */ l) => wrap(l, '<key>ProgramArguments</key><array><string>/bin/sleep</string><string>600</string></array>'),
    (/** @type {string} */ l) => wrap(l, `<key>Program</key><string>${sleeper}</string><key>ProgramArguments</key><array><string>${process.execPath}</string>`
      + `<string>${CLI_PATH}</string><string>--port</string><string>${fake}</string><string>bridge</string></array>`),
    // byte for byte what K-Browser writes, with the sleeper as "node", written by someone else (third round)
    (/** @type {string} */ l) => plistFor({ label: l, port: fake, agentsDir, node: sleeper }),
  ].entries()) {
    const label = `${LABEL}.foreign${i}`;
    const file = path.join(agentsDir, `${label}.plist`);
    const text = make(label);
    fs.writeFileSync(file, text);
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, file]);
    try {
      const o = { ...where(), label, port: fake };
      assert.ok(await untilAsync(async () => serviceStatus(o).pid !== null, 5000), 'the job is running');
      const pid = /** @type {number} */ (serviceStatus(o).pid);
      await assert.rejects(serviceInstall(o), (e) => e instanceof ServiceError && /left alone/.test(e.message));
      await assert.rejects(serviceUninstall(o), ServiceError);
      assert.throws(() => serviceRestart(o), ServiceError);
      assert.equal(serviceStatus(o).pid, pid, 'the same process is still running');
      process.kill(pid, 0);
      assert.equal(fs.readFileSync(file, 'utf8'), text, 'its plist is untouched');
    } finally {
      execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`]);
    }
  }
});

test('kill SIGTERM: launchd starts it again, the extension reconnects; the action in flight is "unknown", not replayed, old tabs not reclaimed', { skip }, async () => {
  const before = /** @type {number} */ (serviceStatus(where()).pid);
  const cdp = await CdpClient.connect(`http://127.0.0.1:${port}/c/${token}`);
  const { targetId } = await cdp.call('Target.createTarget', { url: site.url('/page'), background: true });
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
  await cdp.call('Runtime.evaluate', { expression: 'new Promise((r) => document.readyState === "complete" ? r(1) : addEventListener("load", r))', awaitPromise: true }, sessionId);
  // the page reports each run of this expression to the fixture server
  const slow = cdp.call('Runtime.evaluate', { expression: `fetch('/report', { method: 'POST', body: JSON.stringify({ launchdRun: 1 }) })
    .then(() => new Promise((r) => setTimeout(() => r(1), 8000)))`, awaitPromise: true, returnByValue: true }, sessionId);
  await sleep(500);
  serviceRestart(where());
  await assert.rejects(slow, (e) => /** @type {any} */ (e).code === 'disconnected' && /unknown/.test(/** @type {Error} */ (e).message));
  assert.ok(await untilAsync(async () => { const h = await health(); return h !== null && h.pid !== before && h.extension === true; }, 30000),
    'launchd restarted the bridge and the extension reconnected');
  assert.equal((await health())?.pid, serviceStatus(where()).pid);
  const fresh = await CdpClient.connect(`http://127.0.0.1:${port}/c/${token}`);
  assert.deepEqual((await fresh.call('Target.getTargets')).targetInfos, [], 'the old bridge\'s tab is not handed to anyone');
  // the page ran the expression once: nothing was sent again after the restart
  await sleep(2000);
  assert.equal(site.reports.filter((x) => x.launchdRun).length, 1);
  fresh.close();
  cdp.close();
});

test('uninstall: the job and its plist are gone, nothing answers on the port', { skip }, async () => {
  const { plist, pid } = serviceStatus(where());
  await serviceUninstall(where());
  const st = serviceStatus(where());
  assert.ok(!st.loaded && st.plist === null && plist && !fs.existsSync(plist));
  assert.ok(await untilAsync(async () => (await probePort(port)).kind === 'free'), 'the bridge stopped');
  assert.throws(() => process.kill(/** @type {number} */ (pid), 0), 'its process is gone');
  const logs = path.join(/** @type {string} */ (process.env.KBROWSER_HOME), 'logs');
  for (const f of fs.readdirSync(logs)) {
    const text = fs.readFileSync(path.join(logs, f), 'utf8');
    assert.ok(!text.includes(token) && !text.includes(/** @type {string} */ (auth.pairKey())), `${f}: no token, no pairing key`);
  }
});
