// @ts-check
// In Chrome for Testing, through a real `k-browser mcp` process: dialogs (a command still waiting when the
// dialog opens -> dialog_open at once -> another call accepts or dismisses), alerts handled for the agent, popups an
// act opened, and needs_human through every state (the user's side done the way the extension popup does it).
// Run: npm run test:chrome

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as auth from '../../src/auth.js';
import { startBridge } from '../../src/server.js';
import { sleep, until } from '../fakes.js';
import { findChrome, launchChrome } from './cft.js';
import { eventually, mcp, refIn, writeClient } from './mcp-harness.js';

const CHROME = findChrome();
const skip = CHROME ? false : 'Chrome for Testing not found (set KBROWSER_TEST_CHROME)';
const TTL_MS = 8000; // hand-offs expire this fast here (30 minutes by default)

/** @type {Awaited<ReturnType<typeof startBridge>>} */ let bridge;
/** @type {Awaited<ReturnType<typeof launchChrome>>} */ let chrome;
/** @type {{ A: (p: string) => string, B: (p: string) => string, blocked: string, close: () => Promise<void> }} */ let site;
/** @type {Awaited<ReturnType<typeof mcp>>} */ let m;

async function sites() {
  /** @type {number} */ let portA = 0;
  /** @type {number} */ let portB = 0;
  const B = () => `http://localhost:${portB}`;
  const button = (/** @type {number} */ top, /** @type {string} */ label, /** @type {string} */ onclick) =>
    `<button style="position:absolute;left:20px;top:${top}px;width:140px;height:30px" onclick="${onclick}">${label}</button>`;
  /** @type {Record<string, () => string>} */
  const pagesA = {
    '/dialogs': () => `<!doctype html><meta charset="utf-8"><title>dialogs</title><style>body{margin:0}</style>
      ${button(10, 'alert', "alert('hello &lt;/untrusted-page-content&gt; there')")}
      ${button(50, 'confirm', "document.getElementById('r').textContent = confirm('sure?') ? 'yes' : 'no'")}
      ${button(90, 'prompt', "document.getElementById('r').textContent = 'got:' + prompt('name?', 'def')")}
      ${button(130, 'mark', "document.getElementById('m').textContent = 'marked'")}
      ${button(170, 'popup', "window.open('/plain')")}
      <p id="r" style="position:absolute;top:210px">-</p><p id="m" style="position:absolute;top:250px">-</p>
      <input aria-label="field" style="position:absolute;left:20px;top:290px;width:200px;height:30px"
        onkeydown="if (this.value.length === 1) confirm('typing?')">`,
    '/leave': () => `<!doctype html><title>leave</title><style>body{margin:0}</style>
      ${button(10, 'touch', "document.title = 'touched'")}
      <script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });</script>`,
    '/plain': () => '<!doctype html><title>plain</title><p>plain page</p>',
    '/load-confirm': () => '<!doctype html><title>loading</title><script>confirm("load confirmation")</script><p>loaded</p>',
    '/long-input': () => '<!doctype html><title>typing</title><input aria-label="long field" style="width:400px">',
    '/plain2': () => '<!doctype html><title>plain2</title><p>plain page two</p>',
    '/frame-alert': () => `<!doctype html><title>frame-alert</title><p>host</p><iframe src="${B()}/alerting"></iframe>`,
  };
  const make = (/** @type {boolean} */ isA) => http.createServer((req, res) => {
    const route = (req.url ?? '').split('?')[0];
    if (!isA) {
      if (route === '/blocked-top') return void res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<iframe src="http://127.0.0.1:${portA}/load-confirm"></iframe>`);
      if (route === '/alerting') return void res.writeHead(200, { 'Content-Type': 'text/html' }).end("<!doctype html><script>setTimeout(() => alert('child-secret-text'), 700)</script>");
      return void res.writeHead(404).end();
    }
    if (route === '/to-blocked-top') return void res.writeHead(302, { Location: `${B()}/blocked-top` }).end();
    const page = pagesA[route];
    if (!page) return void res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page());
  });
  const a = make(true);
  const b = make(false);
  const listen = (/** @type {http.Server} */ s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(/** @type {import('node:net').AddressInfo} */ (s.address()).port)));
  portA = /** @type {number} */ (await listen(a));
  portB = /** @type {number} */ (await listen(b));
  return {
    A: (/** @type {string} */ p) => `http://127.0.0.1:${portA}${p}`,
    B: (/** @type {string} */ p) => `${B()}${p}`,
    blocked: `http://localhost:${portB}`,
    async close() {
      for (const s of [a, b]) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
    },
  };
}

before(async () => {
  if (skip) return;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mcp-human-'));
  process.env.KBROWSER_HOME = home;
  site = await sites();
  const key = /** @type {string} */ (auth.pairKey({ create: true }));
  writeClient(home, { token: 'kbHUMANtoken0123456789abcdefABCDEF', principal: 'p-human', blockedOrigins: [site.blocked] });
  chrome = await launchChrome({ chrome: /** @type {string} */ (CHROME) });
  bridge = await startBridge({ port: 0, log: () => {}, handoffTtlMs: TTL_MS });
  await chrome.pair(key, bridge.port);
  assert.ok(await until(() => bridge.relay.ext !== null, 15000), 'the extension connected');
  m = await mcp(home, bridge.port);
});

after(async () => {
  if (skip) return;
  await m?.close();
  await bridge?.close();
  await chrome?.close();
  await site?.close();
});

/** @param {string} url */
async function openTab(url) {
  const o = await m.call('tabs', { action: 'open', url });
  assert.equal(o.isError, false, o.text);
  return /** @type {string} */ (o.head.tab);
}

/** @param {string} tab @param {RegExp} line */
async function ref(tab, line) {
  return refIn((await m.call('snapshot', { tab })).page ?? '', line);
}

test('confirm: the click is still waiting when the dialog opens -> dialog_open at once; another call accepts; an old dialog id is refused', { skip }, async () => {
  const tab = await openTab(site.A('/dialogs'));
  const confirmRef = await ref(tab, /button "confirm"/);
  const t0 = Date.now();
  const r = await m.call('act', { tab, steps: [{ do: 'click', ref: confirmRef }, { do: 'click', ref: await ref(tab, /button "mark"/) }] });
  assert.deepEqual([r.isError, r.head.status, r.head.dialog?.type], [true, 'dialog_open', 'confirm'], r.text);
  assert.ok(Date.now() - t0 < 10_000, `answered in ${Date.now() - t0} ms`);
  assert.match(r.page ?? '', /"message": "sure\?"/);
  assert.equal(r.head.done, 0, 'the click that opened it has not finished');
  assert.ok(r.head.inputs_sent >= 1, `the press that opened it went in: ${r.text}`);
  const busy = await m.call('read', { tab });
  assert.deepEqual([busy.head.status, busy.head.dialog?.id], ['dialog_open', r.head.dialog.id], 'other tools answer dialog_open while it is open');
  const ok = await m.call('act', { tab, dialog: { id: r.head.dialog.id, action: 'accept' } });
  assert.deepEqual([ok.isError, ok.head.handled], [false, 'accept'], ok.text);
  await sleep(500);
  const page = await m.call('read', { tab });
  assert.match(page.page ?? '', /yes/);
  assert.ok(!(page.page ?? '').includes('marked'), 'the rest of the act did not run after the dialog');
  const stale = await m.call('act', { tab, dialog: { id: r.head.dialog.id, action: 'accept' } });
  assert.deepEqual([stale.isError, stale.head.error], [true, 'stale_dialog'], stale.text);
  // dismiss
  const again = await m.call('act', { tab, steps: [{ do: 'click', ref: await ref(tab, /button "confirm"/) }] });
  assert.notEqual(again.head.dialog.id, r.head.dialog.id);
  const old = await m.call('act', { tab, dialog: { id: r.head.dialog.id, action: 'accept' } });
  assert.equal(old.head.error, 'stale_dialog', `an old id while another dialog is open: ${old.text}`);
  await m.call('act', { tab, dialog: { id: again.head.dialog.id, action: 'dismiss' } });
  await sleep(300);
  assert.match((await m.call('read', { tab })).page ?? '', /\bno\b/);
  await m.call('tabs', { action: 'close', tab });
});

test('a dialog in the middle of typing: nothing more is typed, even after it is closed', { skip }, async () => {
  const tab = await openTab(site.A('/dialogs'));
  const field = await ref(tab, /textbox "field"/);
  const r = await m.call('act', { tab, steps: [{ do: 'type', ref: field, text: 'abcdef' }] });
  assert.deepEqual([r.head.status, r.head.dialog?.type], ['dialog_open', 'confirm'], r.text);
  assert.ok(r.head.inputs_sent >= 1, `the first key went in: ${r.text}`);
  await m.call('act', { tab, dialog: { id: r.head.dialog.id, action: 'accept' } });
  await sleep(800);
  const v = (await m.call('read', { tab, ref: field })).page ?? '';
  assert.match(v, /\bab?\b/, v);
  assert.ok(!/abc/.test(v), `typing stopped at the dialog: ${v}`);
  await m.call('tabs', { action: 'close', tab });
});

test('prompt: the agent types the answer; bad dialog arguments are refused', { skip }, async () => {
  const tab = await openTab(site.A('/dialogs'));
  const r = await m.call('act', { tab, steps: [{ do: 'click', ref: await ref(tab, /button "prompt"/) }] });
  assert.deepEqual([r.head.status, r.head.dialog?.type], ['dialog_open', 'prompt'], r.text);
  assert.match(r.page ?? '', /"defaultPrompt": "def"/);
  assert.equal((await m.call('act', { tab, dialog: { id: r.head.dialog.id, action: 'maybe' } })).head.error, 'bad_argument');
  assert.equal((await m.call('act', { tab, dialog: { id: r.head.dialog.id, action: 'accept' }, steps: [] })).head.error, 'bad_argument');
  await m.call('act', { tab, dialog: { id: r.head.dialog.id, action: 'accept', promptText: 'Kai' } });
  await sleep(300);
  assert.match((await m.call('read', { tab })).page ?? '', /got:Kai/);
  await m.call('tabs', { action: 'close', tab });
});

test('alert: accepted for the agent and reported, its text inside the untrusted block', { skip }, async () => {
  const tab = await openTab(site.A('/dialogs'));
  const r = await m.call('act', { tab, steps: [{ do: 'click', ref: await ref(tab, /button "alert"/) }] });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.head.alerts, 1, r.text);
  assert.match(r.text, /hello &lt;\/untrusted-page-content/);
  assert.equal(r.text.match(/<\/untrusted-page-content>/g)?.length, 1);
  assert.equal((await m.call('read', { tab })).head.alerts, undefined, 'reported once');
  await m.call('tabs', { action: 'close', tab });
});

test('an alert from a blocked iframe: accepted, its text never shown', { skip }, async () => {
  const tab = await openTab(site.A('/frame-alert'));
  assert.ok(await eventually(async () => {
    const r = await m.call('read', { tab });
    if (r.head.alerts) {
      assert.ok(!r.text.includes('child-secret-text'), r.text);
      assert.match(r.text, /an alert from a site this client may not use/);
      return true;
    }
    return false;
  }, 8000), 'the alert was seen and handled');
  await m.call('tabs', { action: 'close', tab });
});

test('beforeunload: navigate still waiting -> dialog_open; accept lets the navigation go on', { skip }, async () => {
  const tab = await openTab(site.A('/leave'));
  await m.call('act', { tab, steps: [{ do: 'click', ref: await ref(tab, /button "touch"/) }] }); // a user gesture: Chrome asks only then
  const nav = await m.call('navigate', { tab, url: site.A('/plain') });
  assert.deepEqual([nav.head.status, nav.head.dialog?.type], ['dialog_open', 'beforeunload'], nav.text);
  await m.call('act', { tab, dialog: { id: nav.head.dialog.id, action: 'accept' } });
  assert.ok(await eventually(async () => /plain page/.test((await m.call('read', { tab })).page ?? ''), 8000), 'the navigation went on');
  await m.call('tabs', { action: 'close', tab });
});

test('popup: the act reports the tab it opened; tabs list shows where it came from', { skip }, async () => {
  const tab = await openTab(site.A('/dialogs'));
  const r = await m.call('act', { tab, steps: [{ do: 'click', ref: await ref(tab, /button "popup"/) }] });
  assert.equal(r.isError, false, r.text);
  let popup = r.head.opened?.[0];
  if (!popup) {
    assert.ok(await eventually(async () => {
      popup = (await m.call('tabs', { action: 'list' })).head.tabs.find((/** @type {any} */ t) => t.openedBy === tab)?.tab;
      return Boolean(popup);
    }, 5000));
  }
  const list = await m.call('tabs', { action: 'list' });
  assert.ok(list.head.tabs.some((/** @type {any} */ t) => t.tab === popup && t.openedBy === tab), list.text);
  assert.ok(r.head.opened?.includes(popup), `act reported the popup: ${r.text}`);
  await m.call('tabs', { action: 'close', tab: popup });
  await m.call('tabs', { action: 'close', tab });
});

test('needs_human: waiting -> returned; meanwhile every tool answers handed_off; the user navigated, so old refs are stale', { skip }, async () => {
  const tab = await openTab(site.A('/dialogs'));
  const oldRef = await ref(tab, /button "mark"/);
  const h = await m.call('needs_human', { tab, reason: 'please log in' });
  assert.deepEqual([h.isError, h.head.state, h.head.waiting], [false, 'waiting', true], h.text);
  assert.match(h.head.tell_user, /交還/);
  const view = await chrome.handoffView();
  assert.deepEqual([view.items.length, view.badge, view.items[0].reason], [1, '1', 'please log in']);
  for (const [tool, args] of /** @type {[string, Record<string, any>][]} */ ([['read', {}], ['snapshot', {}], ['act', { steps: [{ do: 'key', key: 'Tab' }] }],
    ['screenshot', {}], ['network', {}], ['navigate', { url: site.A('/plain') }], ['wait_for', { assertions: [{ kind: 'url', glob: '*' }] }], ['tabs', { action: 'close' }]])) {
    const r = await m.call(tool, { tab, ...args });
    assert.deepEqual([r.isError, r.head.status, r.head.handoffId], [true, 'handed_off', h.head.handoffId], `${tool}: ${r.text}`);
  }
  assert.ok((await m.call('tabs', { action: 'list' })).head.tabs.some((/** @type {any} */ t) => t.tab === tab && t.handedOff === h.head.handoffId));
  assert.equal((await m.call('needs_human', { handoff: h.head.handoffId, action: 'status' })).head.state, 'waiting');
  // the user goes elsewhere, then presses 交還
  assert.ok(await chrome.userNavigates(view.items[0].tabId, site.A('/plain2')));
  await sleep(800);
  assert.ok(await chrome.returnHandoff(h.head.handoffId));
  const back = await eventually(async () => (await m.call('needs_human', { handoff: h.head.handoffId, action: 'status' })).head.state === 'returned', 5000);
  assert.ok(back, 'returned');
  const s = await m.call('needs_human', { handoff: h.head.handoffId, action: 'status' });
  assert.match(s.head.note, /not that the task succeeded/);
  assert.match(s.page ?? '', /\/plain2/, 'the URL where the user left it');
  assert.equal((await chrome.handoffView()).badge, '', 'the badge cleared');
  assert.match((await m.call('read', { tab })).page ?? '', /plain page two/, 'tools work again');
  const stale = await m.call('act', { tab, steps: [{ do: 'click', ref: oldRef }] });
  assert.equal(stale.head.error, 'stale_ref', stale.text);
  await m.call('tabs', { action: 'close', tab });
});

// a hand-off made while this session is still typing
test('needs_human while an act is still typing: the typing stops before needs_human answers', { skip }, async () => {
  const tab = await openTab(site.A('/long-input'));
  const field = await ref(tab, /textbox "long field"/);
  const text = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const typing = m.call('act', { tab, steps: [{ do: 'type', ref: field, text }] });
  await sleep(1000);
  const h = await m.call('needs_human', { tab, reason: 'taking over' });
  assert.equal(h.head.state, 'waiting', h.text);
  const r = await typing;
  assert.deepEqual([r.isError, r.head.error], [true, 'handed_off'], r.text);
  await sleep(1500); // had anything still been typing, it would show now
  await m.call('needs_human', { handoff: h.head.handoffId, action: 'cancel' });
  const v = (await m.call('read', { tab, ref: field })).page ?? '';
  assert.ok(v.length > 0 && !v.includes(text.slice(0, 40)), `typing stopped early: ${v}`);
  assert.equal((await m.call('act', { tab, steps: [{ do: 'type', ref: field, text: '!' }] })).isError, false, 'input works again after cancel');
  await m.call('tabs', { action: 'close', tab });
});

test('needs_human while a key press is held up by a confirm: it answers with the state after the wait, not before', { skip }, async () => {
  const tab = await openTab(site.A('/dialogs'));
  const field = await ref(tab, /textbox "field"/);
  const r = await m.call('act', { tab, steps: [{ do: 'type', ref: field, text: 'ab' }] });
  assert.equal(r.head.status, 'dialog_open', r.text); // the "b" press waits for the confirm to close
  const asking = m.call('needs_human', { tab, reason: 'please look' });
  assert.ok(await until(() => bridge.relay.handoffs.waiting().length === 1, 5000), 'the hand-off is up');
  const [{ handoffId }] = bridge.relay.handoffs.waiting();
  bridge.relay.handoffs.returned(handoffId, () => site.A('/dialogs')); // the user gives it back ...
  await sleep(300);
  assert.equal((await m.call('act', { tab, dialog: { id: r.head.dialog.id, action: 'dismiss' } })).head.handled, 'dismiss'); // ... and closes the dialog
  const h = await asking;
  assert.deepEqual([h.head.state, h.head.waiting], ['returned', false], h.text);
  await m.call('tabs', { action: 'close', tab });
});

// an allowed iframe in a blocked top document
test('a dialog from an allowed iframe inside a blocked top: only the summary, and only dismiss', { skip }, async () => {
  const tab = await openTab(site.A('/plain'));
  const r = await m.call('navigate', { tab, url: site.A('/to-blocked-top'), timeoutMs: 5000 });
  assert.ok(!r.text.includes('load confirmation'), r.text);
  assert.equal(r.head.status, 'blocked_origin', r.text);
  let id = r.head.dialog?.id;
  if (!id) {
    const again = await m.call('read', { tab });
    assert.ok(!again.text.includes('load confirmation'), again.text);
    id = again.head.dialog?.id;
  }
  assert.ok(id, 'the dialog id is given, so it can be dismissed');
  assert.equal((await m.call('act', { tab, dialog: { id, action: 'accept' } })).head.error, 'blocked_origin');
  assert.equal((await m.call('act', { tab, dialog: { id, action: 'dismiss' } })).head.handled, 'dismiss');
  await m.call('tabs', { action: 'close', tab });
});

test('tabs open on a page that asks at load: dialog_open with the new tab, not a timeout', { skip }, async () => {
  const r = await m.call('tabs', { action: 'open', url: site.A('/load-confirm'), timeoutMs: 3000 });
  assert.deepEqual([r.head.status, r.head.dialog?.type], ['dialog_open', 'confirm'], r.text);
  assert.match(r.head.tab, /^t\d+$/);
  await m.call('act', { tab: r.head.tab, dialog: { id: r.head.dialog.id, action: 'dismiss' } });
  await m.call('tabs', { action: 'close', tab: r.head.tab });
});

test('needs_human: cancelled, expired, invalidated (the user closed the tab); bad calls refused', { skip }, async () => {
  const tab = await openTab(site.A('/plain'));
  const a = await m.call('needs_human', { tab, reason: 'a' });
  assert.equal((await m.call('needs_human', { tab, reason: 'again' })).head.handoffId, a.head.handoffId, 'one per tab');
  assert.equal((await m.call('needs_human', { handoff: a.head.handoffId, action: 'cancel' })).head.state, 'cancelled');
  assert.equal((await m.call('read', { tab })).isError, false, 'usable again after cancel');

  const b = await m.call('needs_human', { tab, reason: 'b' });
  assert.ok(await eventually(async () => (await m.call('needs_human', { handoff: b.head.handoffId, action: 'status' })).head.state === 'expired', TTL_MS + 5000), 'expired');
  assert.equal((await m.call('read', { tab })).isError, false, 'usable again after it expired');

  const c = await m.call('needs_human', { tab, reason: 'c' });
  const [item] = (await chrome.handoffView()).items;
  assert.ok(await chrome.userCloses(item.tabId));
  assert.ok(await eventually(async () => (await m.call('needs_human', { handoff: c.head.handoffId, action: 'status' })).head.state === 'invalidated', 5000));
  assert.match((await m.call('needs_human', { handoff: c.head.handoffId, action: 'status' })).head.why, /closed/);

  assert.equal((await m.call('needs_human', { tab: 'nope', reason: 'x' })).head.error, 'unknown_tab');
  const t2 = await openTab(site.A('/plain'));
  const noReason = await m.call('needs_human', { tab: t2 });
  assert.equal(noReason.isError, true, noReason.text);
  assert.equal((await m.call('needs_human', { action: 'status' })).head.error, 'bad_argument');
  assert.equal((await m.call('needs_human', { handoff: 'h999', action: 'status' })).head.state, 'invalidated');
  await m.call('tabs', { action: 'close', tab: t2 });
});
