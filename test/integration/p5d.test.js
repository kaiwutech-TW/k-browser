// @ts-check
// In Chrome for Testing through the real `k-browser mcp`: eval is off unless the client
// turns it on; it runs in the isolated world (the page's own variables are not there); it is refused while a frame of
// the page is hidden by the policy (allowed A → blocked B → A); the result is dropped when the page changes meanwhile;
// and — a known limit, not a protection — it can reach the page's scripts by adding one.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startBridge } from '../../src/server.js';
import { until } from '../fakes.js';
import { findChrome, launchChrome } from './cft.js';
import { mcp, writeClient } from './mcp-harness.js';

const CHROME = findChrome();
const skip = CHROME ? false : 'Chrome for Testing not found (set KBROWSER_TEST_CHROME)';
const TOKEN = 'kbP5Dtoken0123456789abcdefABCDEFgh';
const PAIR = 'kbP5DpairKEY9876543210zyxwvuZYXWVut';

/** @type {Awaited<ReturnType<typeof startBridge>>} */ let bridge;
/** @type {Awaited<ReturnType<typeof launchChrome>>} */ let chrome;
/** @type {Awaited<ReturnType<typeof mcp>>} */ let on;
/** @type {Awaited<ReturnType<typeof mcp>>} */ let off;
/** @type {http.Server[]} */ const servers = [];
/** @type {string} */ let A;
/** @type {string} */ let B;

/** @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} h */
async function serve(h) {
  const s = http.createServer(h);
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', () => r(undefined)));
  return /** @type {import('node:net').AddressInfo} */ (s.address()).port;
}

before(async () => {
  if (skip) return;
  /** @type {number} */ let portA = 0;
  const portB = await serve((req, res) => res.writeHead(200, { 'Content-Type': 'text/html' })
    .end(`<!doctype html><title>B</title><iframe src="http://127.0.0.1:${portA}/inner"></iframe>`));
  B = `http://localhost:${portB}`;
  portA = await serve((req, res) => {
    const route = (req.url ?? '').split('?')[0];
    const html = (/** @type {string} */ body) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8">${body}`);
    if (route === '/nested') return void html(`<title>nested</title><iframe src="${B}/"></iframe>`);
    if (route === '/inner') return void html('<title>inner</title><p id="s">INNER_BELOW_BLOCKED</p>');
    if (route === '/grow') return void html(`<title>grow</title><script>setTimeout(() => { const f = document.createElement('iframe'); f.src = '${B}/'; document.body.append(f); }, 300)</script>`);
    if (route === '/later') return void html('<title>later</title><script>setTimeout(() => { location.href = "/plain"; }, 300)</script>');
    html('<title>plain</title><p id="p">hello</p><script>window.pageSecret = "MAIN_WORLD_VALUE";</script>');
  });
  A = `http://127.0.0.1:${portA}`;
  for (const [name, evalOn] of /** @type {const} */ ([['on', true], ['off', false]])) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `kb-p5d-${name}-`));
    fs.writeFileSync(path.join(home, 'pair.key'), PAIR, { mode: 0o600 });
    writeClient(home, { token: TOKEN, principal: 'p-p5d-test', blockedOrigins: [B], eval: evalOn });
    if (name === 'on') {
      process.env.KBROWSER_HOME = home;
      chrome = await launchChrome({ chrome: /** @type {string} */ (CHROME) });
      bridge = await startBridge({ port: 0, log: () => {} });
      await chrome.pair(PAIR, bridge.port);
      assert.ok(await until(() => bridge.relay.ext !== null, 15000));
      on = await mcp(home, bridge.port);
    } else {
      off = await mcp(home, bridge.port);
    }
  }
});

after(async () => {
  if (skip) return;
  await on?.close();
  await off?.close();
  await bridge?.close();
  await chrome?.close();
  for (const s of servers) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
});

/** @param {Awaited<ReturnType<typeof mcp>>} m @param {string} url */
async function tab(m, url) {
  const r = await m.call('tabs', { action: 'open', url });
  assert.equal(r.isError, false, r.text);
  return /** @type {string} */ (r.head.tab);
}

test('eval is not listed and refused unless the client turns it on', { skip }, async () => {
  assert.ok(!(await off.client.listTools()).tools.some((t) => t.name === 'eval'));
  assert.ok((await on.client.listTools()).tools.some((t) => t.name === 'eval'));
  const t = await tab(off, `${A}/`);
  const r = await off.call('eval', { tab: t, expression: '1 + 1' });
  assert.equal(r.isError, true);
  assert.match(r.text, /unknown_tool|disabled/);
});

test('eval runs in the isolated world: the DOM is there, the page\'s own variables are not; the result is page content', { skip }, async () => {
  const t = await tab(on, `${A}/`);
  const r = await on.call('eval', { tab: t, expression: '({ text: document.getElementById("p").textContent, pageVar: typeof window.pageSecret })' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^<untrusted-page-content>/m);
  assert.match(r.text, /"text": "hello"/);
  assert.match(r.text, /"pageVar": "undefined"/, 'the page\'s own variable is not in the isolated world');
  const bad = await on.call('eval', { tab: t, expression: 'throw new Error("boom")' });
  assert.deepEqual([bad.isError, bad.head.error], [true, 'script_error']);
  const slow = await on.call('eval', { tab: t, expression: 'new Promise(() => {})' });
  assert.equal(slow.isError, true, 'a promise that never settles ends with an error, not a hang');
  const t0 = Date.now();
  const late = await on.call('eval', { tab: t, expression: 'new Promise((ok) => setTimeout(() => ok("LATE_VALUE"), 6000))' });
  assert.deepEqual([late.isError, late.head.error], [true, 'script_error'], late.text);
  assert.ok(!late.text.includes('LATE_VALUE') && Date.now() - t0 < 5900, `the 5 s limit holds for a promise too: ${Date.now() - t0} ms`);
  const quick = await on.call('eval', { tab: t, expression: 'new Promise((ok) => setTimeout(() => ok({ n: 1 }), 50))' });
  assert.match(quick.text, /"n": 1/, quick.text);
  assert.equal((await on.call('eval', { tab: t, expression: '"x".repeat(70000)' })).head.error, 'too_big');
});

test('eval is refused while a frame is hidden (allowed A → blocked B → A): the content below the blocked frame is not read', { skip }, async () => {
  const t = await tab(on, `${A}/nested`);
  const r = await on.call('eval', { tab: t, expression: 'frames[0]?.frames[0]?.document?.body?.innerText ?? "none"' });
  assert.equal(r.head.status, 'hidden_frames', r.text);
  assert.ok(!r.text.includes('INNER_BELOW_BLOCKED'));
});

test('the page navigating while eval runs: the result is dropped', { skip }, async () => {
  const t = await tab(on, `${A}/later`);
  const r = await on.call('eval', { tab: t, expression: 'new Promise((ok) => setTimeout(() => ok(document.title), 1500))' });
  assert.equal(r.isError, true, r.text);
  assert.ok(!r.text.includes('"later"'));
});

test('a blocked frame appearing while eval runs (same document): the result is dropped', { skip }, async () => {
  const t = await tab(on, `${A}/grow`);
  const r = await on.call('eval', { tab: t, expression: 'new Promise((ok) => setTimeout(() => ok("DONE_VALUE"), 1500))' });
  assert.equal(r.head.status, 'page_changed', r.text);
  assert.ok(!r.text.includes('DONE_VALUE'));
});

test('a blocked frame appearing while eval runs: an error carrying what was read below it is dropped too', { skip }, async () => {
  const t = await tab(on, `${A}/grow`);
  const r = await on.call('eval', { tab: t, expression: `new Promise((_, no) => setTimeout(() => {
    no(new Error(frames[0].frames[0].document.getElementById('s').textContent)); }, 1500))` });
  assert.equal(r.head.status, 'page_changed', r.text);
  assert.ok(!r.text.includes('INNER_BELOW_BLOCKED'), r.text);
});

test('closing a space while a hand-off starts on one of its tabs: either the hand-off is refused or the tab stays', { skip }, async () => {
  for (let i = 0; i < 8; i++) {
    const t = (await on.call('tabs', { action: 'open', url: `${A}/`, space: `race${i}` })).head.tab;
    const [closed, h] = await Promise.all([
      on.call('tabs', { action: 'close', space: `race${i}` }),
      on.call('needs_human', { action: 'start', tab: t, reason: 'please sign in' }),
    ]);
    if (h.isError) {
      assert.deepEqual(closed.head.closed, [t], `round ${i}: the hand-off refused, the tab closed`);
    } else {
      assert.deepEqual([closed.head.closed, closed.head.kept_handed_off], [[], [t]], `round ${i}: the hand-off waiting, the tab kept`);
      const s = await on.call('needs_human', { action: 'status', handoff: h.head.handoffId });
      assert.equal(s.head.state, 'waiting', s.text);
      await on.call('needs_human', { action: 'cancel', handoff: h.head.handoffId });
      await on.call('tabs', { action: 'close', tab: t });
    }
  }
});

test('a known limit, shown on purpose: eval can add a script to the page and so reach its variables (not a sandbox, no zero-footprint promise)', { skip }, async () => {
  const t = await tab(on, `${A}/`);
  const r = await on.call('eval', { tab: t, expression: `(() => { const s = document.createElement('script');
    s.textContent = 'document.documentElement.dataset.leak = window.pageSecret'; document.documentElement.append(s);
    return document.documentElement.dataset.leak ?? null; })()` });
  assert.match(r.text, /MAIN_WORLD_VALUE/, 'documented: eval is not a sandbox');
});

test('spaces: open into one, list it, close it whole; a tab handed to the user stays; another session\'s same-named space is its own', { skip }, async () => {
  const a1 = (await on.call('tabs', { action: 'open', url: `${A}/`, space: 'research' })).head.tab;
  const a2 = (await on.call('tabs', { action: 'open', url: `${A}/`, space: 'research' })).head.tab;
  const b1 = (await on.call('tabs', { action: 'open', url: `${A}/`, space: 'other' })).head.tab;
  const theirs = (await off.call('tabs', { action: 'open', url: `${A}/`, space: 'research' })).head.tab;
  const listed = await on.call('tabs', { action: 'list', space: 'research' });
  assert.deepEqual(listed.head.tabs.map((/** @type {any} */ x) => x.tab).sort(), [a1, a2].sort());
  assert.ok(listed.head.tabs.every((/** @type {any} */ x) => x.space === 'research'));
  const h = await on.call('needs_human', { action: 'start', tab: a2, reason: 'please sign in' });
  assert.equal(h.isError, false, h.text);
  const closed = await on.call('tabs', { action: 'close', space: 'research' });
  assert.deepEqual([closed.head.closed, closed.head.kept_handed_off], [[a1], [a2]]);
  const all = (await on.call('tabs', { action: 'list' })).head.tabs.map((/** @type {any} */ x) => x.tab);
  assert.ok(all.includes(b1) && all.includes(a2) && !all.includes(a1));
  assert.ok((await off.call('tabs', { action: 'list', space: 'research' })).head.tabs.some((/** @type {any} */ x) => x.tab === theirs), 'the other session\'s space is untouched');
  assert.equal((await on.call('tabs', { action: 'open', url: `${A}/`, space: '../x' })).head.error, 'bad_argument');
  await on.call('needs_human', { action: 'cancel', handoff: h.head.handoffId });
});
