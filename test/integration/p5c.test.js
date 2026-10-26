// @ts-check
// In Chrome for Testing through the real `k-browser mcp`: fetch and files download send
// nothing to another origin — not even through a redirect from the tab's own origin (the other server counts 0
// requests); files stay in the client's file area; upload takes only a plain file of that area, and raw CDP clients
// still cannot hand Chrome a local path.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startBridge } from '../../src/server.js';
import { FakeCdp, until } from '../fakes.js';
import { findChrome, launchChrome } from './cft.js';
import { mcp, refIn, writeClient } from './mcp-harness.js';

const CHROME = findChrome();
const skip = CHROME ? false : 'Chrome for Testing not found (set KBROWSER_TEST_CHROME)';
const TOKEN = 'kbP5Ctoken0123456789abcdefABCDEFgh';
const PAIR = 'kbP5CpairKEY9876543210zyxwvuZYXWVut';
const BIN = randomBytes(3 * 1024 * 1024 + 17);

/** @type {Awaited<ReturnType<typeof startBridge>>} */ let bridge;
/** @type {Awaited<ReturnType<typeof launchChrome>>} */ let chrome;
/** @type {Awaited<ReturnType<typeof mcp>>} */ let m;
/** @type {http.Server[]} */ const servers = [];
/** @type {string} */ let home;
/** @type {string} */ let A;
/** @type {string} */ let B;
let hitsOnB = 0;

/** @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} h */
async function serve(h) {
  const s = http.createServer(h);
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', () => r(undefined)));
  return /** @type {import('node:net').AddressInfo} */ (s.address()).port;
}

before(async () => {
  if (skip) return;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-p5c-'));
  process.env.KBROWSER_HOME = home;
  // B: another origin, allowed by the policy — and still never to receive a request
  const portB = await serve((req, res) => { hitsOnB++; res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }).end('{"from":"B"}'); });
  B = `http://localhost:${portB}`;
  const portA = await serve((req, res) => {
    const route = (req.url ?? '').split('?')[0];
    if (route === '/api/me') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
    if (route === '/to-b') return void res.writeHead(302, { Location: `${B}/api/data` }).end();
    if (route === '/to-me') return void res.writeHead(302, { Location: '/api/me' }).end();
    if (route === '/file.bin') return void res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(BIN);
    if (route === '/endless.txt' || route === '/endless.bin') {
      // never ends: only a reader that stops past its limit returns
      res.writeHead(200, { 'Content-Type': route.endsWith('.txt') ? 'text/plain' : 'application/octet-stream' });
      const piece = Buffer.alloc(256 * 1024, 120);
      const timer = setInterval(() => res.write(piece), 2);
      return void res.on('close', () => clearInterval(timer));
    }
    if (route === '/big.bin') return void res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(Buffer.alloc(26 * 1024 * 1024));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'pref=dark; Path=/' }).end(`<!doctype html><meta charset="utf-8"><title>p5c</title>
      <label for="f">附件</label><input type="file" id="f">
      <p id="out"></p>
      <script>document.getElementById('f').addEventListener('change', async (e) => {
        const f = e.target.files[0]; document.getElementById('out').textContent = 'got ' + f.name + ' ' + f.size + ' ' + (await f.text()).slice(0, 20); });</script>`);
  });
  A = `http://127.0.0.1:${portA}`;
  fs.writeFileSync(path.join(home, 'pair.key'), PAIR, { mode: 0o600 });
  writeClient(home, { token: TOKEN, principal: 'p-p5c-test', blockedOrigins: [] });
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

async function tab() {
  const r = await m.call('tabs', { action: 'open', url: `${A}/` });
  assert.equal(r.isError, false, r.text);
  return /** @type {string} */ (r.head.tab);
}

test('fetch: the tab\'s own origin with its cookies; the body is page content; HEAD; only GET / HEAD and two headers', { skip }, async () => {
  const t = await tab();
  const r = await m.call('fetch', { tab: t, url: '/api/me', headers: { Accept: 'application/json' } });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual([r.head.status, r.head.truncated], [200, false]);
  // the cookie went with it (the page echoes it back) and, being a cookie, comes back redacted
  assert.match(r.text, /<untrusted-page-content>[\s\S]*"cookie":"\[redacted\]"/);
  assert.equal((await m.call('fetch', { tab: t, url: `${A}/api/me`, method: 'HEAD' })).head.status, 200);
  assert.equal((await m.call('fetch', { tab: t, url: '/api/me', method: 'POST' })).head.error, 'bad_argument');
  assert.equal((await m.call('fetch', { tab: t, url: '/api/me', headers: { Cookie: 'x=1' } })).head.error, 'bad_argument');
  // every redirect is refused, a same-origin one too (redirect: "error", not only the same-origin mode)
  assert.equal((await m.call('fetch', { tab: t, url: '/to-me' })).head.error, 'fetch_failed');
  const html = await m.call('fetch', { tab: t, url: '/' });
  assert.match(html.head.body, /html_not_returned/);
  assert.ok(!html.text.includes('<untrusted'));
  const bin = await m.call('fetch', { tab: t, url: '/file.bin' });
  assert.match(bin.head.body, /binary_not_returned/, 'a binary type is not decoded as text');
  assert.ok(!bin.text.includes('<untrusted'));
});

test('fetch and download stop reading past their limit: an endless body comes back truncated / too_big, not after it ends', { skip }, async () => {
  const t = await tab();
  const t0 = Date.now();
  const text = await m.call('fetch', { tab: t, url: '/endless.txt' });
  assert.deepEqual([text.head.status, text.head.truncated, text.head.bytes], [200, true, null], text.text);
  const dl = await m.call('files', { action: 'download', tab: t, url: '/endless.bin' });
  assert.equal(dl.head.error, 'too_big', dl.text);
  assert.ok(Date.now() - t0 < 20000, `${Date.now() - t0} ms`);
  assert.deepEqual((await m.call('files', { action: 'list' })).head.files.filter((/** @type {any} */ f) => /endless/.test(f.name)), []);
});

test('fetch and download: another origin, directly or through a redirect from the tab\'s own origin, receives 0 requests', { skip }, async () => {
  const t = await tab();
  hitsOnB = 0;
  const direct = await m.call('fetch', { tab: t, url: `${B}/api/data` });
  assert.equal(direct.head.error, 'cross_origin', direct.text);
  const redirected = await m.call('fetch', { tab: t, url: '/to-b' });
  assert.equal(redirected.head.error, 'fetch_failed', redirected.text);
  const dl = await m.call('files', { action: 'download', tab: t, url: '/to-b' });
  assert.equal(dl.head.error, 'fetch_failed', dl.text);
  const dlDirect = await m.call('files', { action: 'download', tab: t, url: `${B}/x.bin` });
  assert.equal(dlDirect.head.error, 'cross_origin');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(hitsOnB, 0, 'the other origin never received a request');
  assert.deepEqual((await m.call('files', { action: 'list' })).head.files, [], 'no half-written file');
});

test('files download: into the client\'s area, byte for byte, 0600; too big refused with nothing left; by ref unsupported', { skip }, async () => {
  const t = await tab();
  const r = await m.call('files', { action: 'download', tab: t, url: '/file.bin', name: '../../報表 2026.bin' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.head.name, /^[0-9a-f]{8}-.*報表 2026\.bin$/);
  assert.ok(!r.head.name.includes('/'));
  const file = path.join(home, 'files', 'p-p5c-test', r.head.name);
  assert.ok(fs.readFileSync(file).equals(BIN), 'byte for byte');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.ok((await m.call('files', { action: 'list' })).head.files.some((/** @type {any} */ f) => f.name === r.head.name && f.size === BIN.length));
  const big = await m.call('files', { action: 'download', tab: t, url: '/big.bin' });
  assert.equal(big.head.error, 'too_big');
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1);
  assert.equal((await m.call('files', { action: 'download', tab: t, ref: 's1.1' })).head.error, 'unsupported');
});

test('files upload: a plain file of the area into a file input; names with paths, dot files, links refused', { skip }, async () => {
  const dir = path.join(home, 'files', 'p-p5c-test');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello from the area', { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'outside.txt'), 'outside');
  fs.symlinkSync(path.join(home, 'outside.txt'), path.join(dir, 'link.txt'));
  fs.linkSync(path.join(home, 'outside.txt'), path.join(dir, 'hard.txt'));
  fs.symlinkSync(path.join(dir, 'hello.txt'), path.join(dir, 'inlink.txt')); // a link, even to a file of the area
  const t = await tab();
  const snap = await m.call('snapshot', { tab: t });
  const ref = refIn(String(snap.page), /附件/);
  const up = await m.call('files', { action: 'upload', tab: t, ref, name: 'hello.txt' });
  assert.equal(up.isError, false, up.text);
  /** @type {string} */ let out = '';
  for (let i = 0; i < 25 && !/got hello\.txt 19 hello from the area/.test(out); i++) {
    out = (await m.call('read', { tab: t, selector: '#out' })).text;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.match(out, /got hello\.txt 19 hello from the area/);
  for (const name of ['../outside.txt', '/etc/passwd', '.hidden', 'link.txt', 'inlink.txt', 'hard.txt', 'nope.txt']) {
    const r = await m.call('files', { action: 'upload', tab: t, ref, name });
    assert.equal(r.isError, true, name);
  }
});

test('raw CDP clients: DOM.setFileInputFiles stays refused; KBrowser.setFileInput takes only a plain name of the caller\'s own area', { skip }, async () => {
  const cdp = await new FakeCdp(bridge.base, TOKEN).connect();
  const { targetId } = await cdp.call('Target.createTarget', { url: `${A}/`, background: true });
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
  for (let i = 0; i < 50 && (await cdp.call('Runtime.evaluate', { expression: 'document.readyState' }, sessionId)).result.value !== 'complete'; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const { result } = await cdp.call('Runtime.evaluate', { expression: "document.getElementById('f')" }, sessionId);
  const { node } = await cdp.call('DOM.describeNode', { objectId: result.objectId }, sessionId);
  await assert.rejects(cdp.call('DOM.setFileInputFiles', { files: ['/etc/passwd'], backendNodeId: node.backendNodeId }, sessionId), /not allowed/);
  await assert.rejects(cdp.call('KBrowser.setFileInput', { name: '../../outside.txt', backendNodeId: node.backendNodeId }, sessionId), /plain file name/);
  await cdp.call('KBrowser.setFileInput', { name: 'hello.txt', backendNodeId: node.backendNodeId }, sessionId);
  await cdp.close();
});
