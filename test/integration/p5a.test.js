// @ts-check
// In Chrome for Testing through the real `k-browser mcp`: read's query mode (rows and
// fields, password values never read, selectors are data not code, a page that changes under it, a blocked page),
// navigate's reload, and status (nothing secret in it).

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
const TOKEN = 'kbP5Atoken0123456789abcdefABCDEFgh';
const PAIR = 'kbP5ApairKEY9876543210zyxwvuZYXWVut';
const PASSWORD = 'P5AsecretPassw0rd!';

/** @type {Awaited<ReturnType<typeof startBridge>>} */ let bridge;
/** @type {Awaited<ReturnType<typeof launchChrome>>} */ let chrome;
/** @type {Awaited<ReturnType<typeof mcp>>} */ let m;
/** @type {http.Server[]} */ const servers = [];
let loads = 0;
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-p5a-'));
  process.env.KBROWSER_HOME = home;
  const portB = await serve((req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>B</title><p class="item">blocked row</p>'));
  B = `http://localhost:${portB}`;
  const portA = await serve((req, res) => {
    const route = (req.url ?? '').split('?')[0];
    if (route === '/load') loads++;
    if (route === '/to-b') return void res.writeHead(302, { Location: `${B}/` }).end();
    if (route === '/xhtml') {
      return void res.writeHead(200, { 'Content-Type': 'application/xhtml+xml' }).end(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><form>
<input type="password" value="${PASSWORD}" /><input type="PassWord" value="${PASSWORD}2" /><input value="plain" />
<foo:input xmlns:foo="urn:x" type="password" value="${PASSWORD}3" /></form></body></html>`);
    }
    if (route === '/wide') {
      return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8">${`<p class="w">${'中文字'.repeat(70)}</p>`.repeat(1000)}`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>list</title>
      <ul>
        <li class="item" data-price="1490"><span class="n">0612 直達</span> <a href="/t/612">詳情</a></li>
        <li class="item" data-price="1350"><span class="n">0630 區間</span> <a href="/t/630">詳情</a></li>
        <li class="item" data-price="990"><span class="n">0702 自由座</span></li>
      </ul>
      <form><input type="password" class="pw" value="${PASSWORD}"><input class="q" value="台北"></form>
      <script>if (location.pathname === '/load') fetch('/load-count');</script>`);
  });
  A = `http://127.0.0.1:${portA}`;
  fs.writeFileSync(path.join(home, 'pair.key'), PAIR, { mode: 0o600 });
  writeClient(home, { token: TOKEN, principal: 'p-p5a-test', blockedOrigins: [B] });
  chrome = await launchChrome({ chrome: /** @type {string} */ (CHROME) });
  bridge = await startBridge({ port: 0, log: () => {} });
  await chrome.pair(PAIR, bridge.port);
  assert.ok(await until(() => bridge.relay.ext !== null, 15000));
  m = await mcp(home, bridge.port);
});

after(async () => {
  if (skip) return;
  await m?.close();
  await bridge?.close();
  await chrome?.close();
  for (const s of servers) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
});

/** A new tab on url. @param {string} url */
async function tab(url) {
  const r = await m.call('tabs', { action: 'open', url });
  assert.equal(r.isError, false, r.text);
  return /** @type {string} */ (r.head.tab);
}

test('read with a selector: rows and fields, untrusted; a password value is never read; max', { skip }, async () => {
  const t = await tab(`${A}/`);
  const r = await m.call('read', { tab: t, selector: 'li.item', fields: { name: '.n', link: 'a@href', price: '@data-price', missing: '.nope' } });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual([r.head.rows, r.head.total, r.head.truncated], [3, 3, false]);
  assert.match(r.page ?? '', /^<untrusted-page-content>/);
  const rows = JSON.parse(String(r.page).replace(/^<untrusted-page-content>\n?/, '').replace(/\n?<\/untrusted-page-content>$/, ''));
  assert.deepEqual(rows[0], { name: '0612 直達', link: '/t/612', price: '1490', missing: null });
  assert.equal(rows[2].link, null);
  const pw = await m.call('read', { tab: t, selector: 'form', fields: { pw: '.pw@value', q: '.q@value', text: '.pw' } });
  assert.ok(!pw.text.includes(PASSWORD), 'the password is not read');
  assert.match(pw.text, /台北/);
  const one = await m.call('read', { tab: t, selector: 'li.item', max: 1 });
  assert.deepEqual([one.head.rows, one.head.truncated], [1, true]);
});

test('an XHTML page: password fields are still never read, whatever the field name or the type\'s case', { skip }, async () => {
  const t = await tab(`${A}/xhtml`);
  for (const args of [{ selector: 'input', fields: { v: '@value' } }, { selector: '*|input', fields: { v: '@value' } }, { selector: 'input' }]) {
    const r = await m.call('read', { tab: t, ...args });
    assert.equal(r.isError, false, r.text);
    assert.ok(!r.text.includes(PASSWORD), `${JSON.stringify(args)}: ${r.text}`);
  }
  assert.match((await m.call('read', { tab: t, selector: 'input', fields: { v: '@value' } })).text, /plain/);
  const whole = await m.call('read', { tab: t });
  assert.ok(!whole.text.includes(PASSWORD));
});

test('the bytes limit counts UTF-8 bytes', { skip }, async () => {
  const t = await tab(`${A}/wide`);
  const r = await m.call('read', { tab: t, selector: 'p.w', max: 500 });
  assert.equal(r.head.truncated, true);
  assert.ok(Buffer.byteLength(String(r.page), 'utf8') <= 101_000, `${Buffer.byteLength(String(r.page), 'utf8')} bytes`);
});

test('selectors are data, not code: a hostile string is a bad selector, the page is untouched', { skip }, async () => {
  const t = await tab(`${A}/`);
  for (const sel of ['"),document.title="pwned",("', ' document.title="pwned"', "'];document.title='pwned';//", '</script><script>document.title="pwned"</script>']) {
    const r = await m.call('read', { tab: t, selector: sel });
    assert.equal(r.isError, true, sel);
    assert.equal(r.head.error, 'bad_argument', r.text);
  }
  const fields = await m.call('read', { tab: t, selector: 'li', fields: { x: '"),document.title="pwned",("@href' } });
  assert.equal(fields.isError, false, fields.text);
  const title = await m.call('read', { tab: t, selector: 'title' });
  assert.match(title.text, /list/);
  assert.ok(!title.text.includes('pwned'));
});

test('a page now on a blocked site: read with a selector gives only the summary', { skip }, async () => {
  const t = await tab(`${A}/`);
  const nav = await m.call('navigate', { tab: t, url: `${A}/to-b` });
  assert.equal(nav.head.status, 'blocked_origin', nav.text);
  const r = await m.call('read', { tab: t, selector: '.item' });
  assert.equal(r.head.status, 'blocked_origin', r.text);
  assert.ok(!r.text.includes('blocked row'));
});

test('navigate reload: loads the page again, reports where it landed; url is not needed', { skip }, async () => {
  const t = await tab(`${A}/load`);
  assert.ok(await until(() => loads >= 1, 5000));
  const before = loads;
  const r = await m.call('navigate', { tab: t, reload: true });
  assert.equal(r.isError, false, r.text);
  assert.match(r.head.actionId, /\S/);
  assert.match(r.page ?? '', /\/load/);
  assert.ok(await until(() => loads === before + 1, 5000), 'loaded once more');
  const bad = await m.call('navigate', { tab: t });
  assert.equal(bad.head.error, 'bad_argument', 'without reload, url is still required');
});

test('status: versions, the extension, tabs and hand-offs, which tools, how many sites blocked; nothing secret', { skip }, async () => {
  const r = await m.call('status', {});
  assert.equal(r.isError, false, r.text);
  const h = r.head;
  assert.equal(h.k_browser, h.bridge);
  assert.equal(h.extension, h.k_browser, 'the extension reports the same version');
  assert.equal(h.client, 'agent');
  assert.ok(h.tabs >= 1);
  assert.deepEqual([h.handoffs, h.run_flow, h.screenshot, h.policy], [0, false, true, { blocked: 1, allow_list: false }]);
  for (const s of [TOKEN, PAIR, B, process.env.KBROWSER_HOME]) assert.ok(!r.text.includes(String(s)), `no ${s} in status`);
});
