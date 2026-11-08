// @ts-check
// In Chrome for Testing with WebMCP on: the webmcp tool through a real `k-browser mcp` process, the bridge and the
// extension (chrome.debugger). Tools of the top page and of a cross-site child frame with the same name, a call that
// waits for a person, a tool that throws, a call whose page navigates away, a hidden frame's tool, and Chrome
// without WebMCP. Run: npm run test:chrome

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as auth from '../../src/auth.js';
import { Browser, SdkError } from '../../src/sdk/index.js';
import { startBridge } from '../../src/server.js';
import { until } from '../fakes.js';
import { findChrome, fixtures, launchChrome } from './cft.js';
import { mcp, refIn, writeClient } from './mcp-harness.js';

const CHROME = findChrome();
const skip = CHROME ? false : 'Chrome for Testing not found (set KBROWSER_TEST_CHROME)';
const TOKEN = 'kbTESTwebmcpTOKEN0123456789abcdefAB';

/** @type {Awaited<ReturnType<typeof startBridge>>} */ let bridge;
/** @type {Awaited<ReturnType<typeof launchChrome>>} */ let chrome;
/** @type {Awaited<ReturnType<typeof fixtures>>} */ let site;
/** @type {string} */ let home;

before(async () => {
  if (skip) return;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-webmcp-'));
  process.env.KBROWSER_HOME = home;
  site = await fixtures();
  chrome = await launchChrome({ chrome: /** @type {string} */ (CHROME), features: ['WebMCPTesting', 'DevToolsWebMCPSupport'] });
  bridge = await startBridge({ port: 0, log: () => {} });
  await chrome.pair(/** @type {string} */ (auth.pairKey({ create: true })), bridge.port);
  assert.ok(await until(() => bridge.relay.ext !== null, 15000), 'the extension connected');
});

after(async () => {
  if (skip) return;
  await bridge?.close();
  await chrome?.close();
  await site?.close();
});

/** @param {Record<string, any>} rec */
async function session(rec = {}) {
  writeClient(home, { token: TOKEN, principal: 'p-webmcp', ...rec });
  const m = await mcp(home, bridge.port);
  const opened = await m.call('tabs', { action: 'open', url: site.url('/webmcp') });
  assert.equal(opened.isError, false, opened.text);
  return { m, tab: String(opened.head.tab) };
}

/** The handle of the tool named `name` whose description is `desc` (list page). @param {string | null} page @param {string} name @param {string} [desc] */
function handleOf(page, name, desc) {
  const tools = JSON.parse(String(page).replace(/^<untrusted-page-content>\n?|\n?<\/untrusted-page-content>$/g, ''));
  const t = tools.find((/** @type {any} */ x) => x.name === name && (desc === undefined || x.description === desc));
  assert.ok(t, `tool ${name} in ${page}`);
  return t.tool;
}

test('list and call: same-name tools in the top page and a child frame each answer for themselves; a tool that waits for a person; a throwing tool', { skip }, async () => {
  const { m, tab } = await session();
  try {
    const list = await m.call('webmcp', { tab, action: 'list' });
    assert.equal(list.isError, false, list.text);
    assert.equal(list.head.tools.length, 7, list.text);
    assert.match(String(list.page), /"amount": \{\s*"type": "integer"\s*\}/);

    const draft = await m.call('webmcp', { tab, action: 'call', tool: handleOf(list.page, 'draft_expense'), args: { amount: 528 } });
    assert.deepEqual([draft.isError, draft.head.status], [false, 'Completed'], draft.text);
    assert.match(String(draft.page), /draft 528/);
    assert.ok(draft.head.actionId, 'an actionId, as for act');

    const top = await m.call('webmcp', { tab, action: 'call', tool: handleOf(list.page, 'same_name', 'top') });
    const child = await m.call('webmcp', { tab, action: 'call', tool: handleOf(list.page, 'same_name', 'child') });
    assert.match(String(top.page), /from top/);
    assert.match(String(child.page), /from child/);

    const broken = await m.call('webmcp', { tab, action: 'call', tool: handleOf(list.page, 'broken') });
    assert.deepEqual([broken.isError, broken.head.status], [true, 'Error'], broken.text);

    // waits for the approve button: "waiting", then a person clicks (here: act), then wait collects it
    const submit = await m.call('webmcp', { tab, action: 'call', tool: handleOf(list.page, 'submit_expense_draft'), timeoutMs: 500 });
    assert.equal(submit.head.status, 'waiting', submit.text);
    assert.match(String(submit.head.note), /do not call the tool again/);
    const snap = await m.call('snapshot', { tab });
    await m.call('act', { tab, steps: [{ do: 'click', ref: refIn(String(snap.page), /button "approve"/) }] });
    const done = await m.call('webmcp', { tab, action: 'wait', invocationId: submit.head.invocationId, timeoutMs: 5000 });
    assert.deepEqual([done.head.status, /submitted/.test(String(done.page))], ['Completed', true], done.text);

    // review ①: the page swaps the tool behind a handle (removed, another registered under the same name): stale
    const before = handleOf(list.page, 'save_invoice');
    const snap2 = await m.call('snapshot', { tab });
    await m.call('act', { tab, steps: [{ do: 'click', ref: refIn(String(snap2.page), /button "switch invoice"/) }] });
    const swapped = await m.call('webmcp', { tab, action: 'call', tool: before });
    assert.equal(swapped.head.error, 'stale_ref', swapped.text);
    const relisted = await m.call('webmcp', { tab, action: 'list' });
    assert.match(String((await m.call('webmcp', { tab, action: 'call', tool: handleOf(relisted.page, 'save_invoice') })).page), /saved B/);

    // review round 2 (medium): the same page loaded again registers the same names with no toolsRemoved: all listed again
    await m.call('navigate', { tab, url: site.url('/webmcp') });
    const reloaded = await m.call('webmcp', { tab, action: 'list' });
    assert.equal(reloaded.head.tools.length, 7, reloaded.text);

    // a call whose page navigates away before it answers: unknown, never "not done"
    const again = await m.call('webmcp', { tab, action: 'list' });
    const pending = await m.call('webmcp', { tab, action: 'call', tool: handleOf(again.page, 'submit_expense_draft'), timeoutMs: 300 });
    assert.equal(pending.head.status, 'waiting');
    await m.call('navigate', { tab, url: site.url('/page') });
    const lost = await m.call('webmcp', { tab, action: 'wait', invocationId: pending.head.invocationId, timeoutMs: 3000 });
    assert.equal(lost.head.error, 'result_unknown', lost.text);
    // a handle from before the navigation is stale; the new page offers nothing
    const stale = await m.call('webmcp', { tab, action: 'call', tool: handleOf(again.page, 'draft_expense'), args: { amount: 1 } });
    assert.equal(stale.head.error, 'stale_ref', stale.text);
    const none = await m.call('webmcp', { tab, action: 'list' });
    assert.deepEqual(none.head.tools, []);
  } finally {
    await m.close();
  }
});

test('site policy: the tool of a blocked child frame is not listed, and its handle cannot be used', { skip }, async () => {
  const { m, tab } = await session({ blockedOrigins: [`http://localhost:${site.portB}`] });
  try {
    const list = await m.call('webmcp', { tab, action: 'list' });
    assert.equal(list.head.tools.length, 6, list.text);
    assert.ok(!/"description":"child"/.test(String(list.page)), 'the child frame\'s tool is hidden');
  } finally {
    await m.close();
  }
});

test('review ②: a new MCP worker (a client setting changed) never hands out a tool handle the old one gave', { skip }, async () => {
  const { m, tab } = await session();
  try {
    const first = await m.call('webmcp', { tab, action: 'list' });
    const old = handleOf(first.page, 'draft_expense');
    writeClient(home, { token: TOKEN, principal: 'p-webmcp', screenshot: false }); // the shim starts a new worker
    assert.equal((await m.call('status', {})).head.screenshot, false, 'the new worker is in use');
    const second = await m.call('webmcp', { tab, action: 'list' });
    assert.ok(second.head.tools.every((/** @type {string} */ h) => !first.head.tools.includes(h)), `${first.head.tools} / ${second.head.tools}`);
    const stale = await m.call('webmcp', { tab, action: 'call', tool: old, args: { amount: 1 } });
    assert.equal(stale.head.error, 'stale_ref', stale.text);
  } finally {
    await m.close();
  }
});

test('a tool the site marks consequential: nothing is called until the user allows it in the panel; denied: never called', { skip }, async () => {
  const { m, tab } = await session();
  try {
    const list = await m.call('webmcp', { tab, action: 'list' });
    const pay = handleOf(list.page, 'pay_invoice');
    assert.match(String(list.page), /"consequential": true/);
    const paid = () => m.call('read', { tab, selector: 'body', fields: { paid: '@data-paid' } }).then((r) => String(r.page));

    const asked = await m.call('webmcp', { tab, action: 'call', tool: pay, args: { amount: 70 }, timeoutMs: 300 });
    assert.equal(asked.head.status, 'awaiting_approval', asked.text);
    const id = String(asked.head.approvalId);
    const shown = bridge.relay.panelState().approvals;
    assert.equal(shown.length, 1);
    assert.match(shown[0].title, /^pay_invoice @ http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(shown[0].detail, /"amount": 70/);
    assert.ok(!/"paid": "[^"]*:70"/.test(await paid()), 'not called while it waits');
    // the same approval cannot carry other arguments
    const other = await m.call('webmcp', { tab, action: 'call', tool: pay, args: { amount: 9999 }, approvalId: id, timeoutMs: 300 });
    assert.equal(other.head.error, 'bad_argument', other.text);

    assert.equal(bridge.relay.approvals.decide(shown[0].principal, id, true), true); // the panel's 允許
    const done = await m.call('webmcp', { tab, action: 'call', tool: pay, args: { amount: 70 }, approvalId: id });
    assert.deepEqual([done.head.status, /paid 70/.test(String(done.page))], ['Completed', true], done.text);
    assert.match(await paid(), /"paid": "127\.0\.0\.1:\d+:70"/, 'the read used for "not called" does see a call');
    const again = await m.call('webmcp', { tab, action: 'call', tool: pay, args: { amount: 70 }, approvalId: id, timeoutMs: 300 });
    assert.equal(again.head.error, 'bad_argument', 'an approval allows one call');

    const second = await m.call('webmcp', { tab, action: 'call', tool: pay, args: { amount: 5 }, timeoutMs: 300 });
    bridge.relay.approvals.decide(bridge.relay.panelState().approvals[0].principal, String(second.head.approvalId), false); // 拒絕
    const denied = await m.call('webmcp', { tab, action: 'call', tool: pay, args: { amount: 5 }, approvalId: second.head.approvalId });
    assert.equal(denied.head.error, 'denied', denied.text);
    assert.ok(!/"paid": "[^"]*:5"/.test(await paid()), 'never called');
    assert.equal(bridge.relay.panelState().approvals.length, 0);
  } finally {
    await m.close();
  }
});

test('raw CDP cannot skip the Allow; an approval allows exactly the call it was asked for, once', { skip }, async () => {
  writeClient(home, { token: TOKEN, principal: 'p-webmcp' });
  const browser = await Browser.connect(`${bridge.base}/c/${TOKEN}`);
  const tab = await browser.newTab(site.url('/webmcp'));
  try {
    await tab.settled();
    const tools = await tab.webmcp().list();
    const pay = /** @type {any} */ (tools.find((x) => x.name === 'pay_invoice'));
    const paid = () => tab.evaluate(() => document.body.dataset.paid ?? null);
    const refused = (/** @type {any} */ e) => e instanceof SdkError && e.code === 'unsupported' && /nothing was called/.test(e.message) ? true : assert.fail(String(e));
    await assert.rejects(() => tab.webmcp().call(pay.handle, { amount: 70 }, { timeoutMs: 1000 }), refused);
    // straight to Chrome's command, with no approval: refused by the bridge too
    await assert.rejects(() => tab.client.call('WebMCP.invokeTool', { frameId: pay.frameId, toolName: 'pay_invoice', input: { amount: 70 } }, tab.sessionId), /nothing was called/);
    assert.equal(await paid(), null);

    const { approvalId } = await tab.client.call('KBrowser.requestApproval', { targetId: tab.targetId, frameId: pay.frameId, toolName: 'pay_invoice', input: { amount: 1 } });
    bridge.relay.approvals.decide(bridge.relay.panelState().approvals[0].principal, approvalId, true);
    await assert.rejects(() => tab.webmcp().call(pay.handle, { amount: 2 }, { timeoutMs: 1000, approvalId }), refused); // other args
    assert.equal(await paid(), null);
    assert.equal((await tab.webmcp().call(pay.handle, { amount: 1 }, { timeoutMs: 5000, approvalId })).status, 'Completed');
    assert.match(String(await paid()), /:1$/);
    await assert.rejects(() => tab.webmcp().call(pay.handle, { amount: 1 }, { timeoutMs: 1000, approvalId }), refused); // once
    // an unmarked tool needs no approval
    assert.equal((await tab.webmcp().call(/** @type {any} */ (tools.find((x) => x.name === 'draft_expense')).handle, { amount: 3 }, { timeoutMs: 5000 })).status, 'Completed');
  } finally {
    await tab.close();
    browser.close();
  }
});

test('an Allow is bound to one registration: not usable after the page swaps the tool or the tab goes to another site', { skip }, async () => {
  writeClient(home, { token: TOKEN, principal: 'p-webmcp' });
  const browser = await Browser.connect(`${bridge.base}/c/${TOKEN}`);
  const tab = await browser.newTab(site.url('/webmcp'));
  const allowFor = async (/** @type {any} */ t) => {
    const { approvalId } = await tab.client.call('KBrowser.requestApproval', { targetId: tab.targetId, frameId: t.frameId, toolName: 'pay_invoice', input: { amount: 70 } });
    bridge.relay.approvals.decide(bridge.relay.panelState().approvals[0].principal, approvalId, true);
    return approvalId;
  };
  const payTool = async () => /** @type {any} */ ((await tab.webmcp().list()).find((x) => x.name === 'pay_invoice'));
  const refused = (/** @type {any} */ e) => e instanceof SdkError && e.code === 'unsupported' && /nothing was called/.test(e.message) ? true : assert.fail(String(e));
  try {
    await tab.settled();
    // the page removes the tool and registers another under the same name (a click on the page)
    let approvalId = await allowFor(await payTool());
    const snap = await tab.snapshot();
    await tab.click(/** @type {any} */ (snap.refs.find((r) => r.name === 'switch pay')).ref);
    let t = await payTool();
    assert.match(t.description, /^Pay B/);
    await assert.rejects(() => tab.webmcp().call(t.handle, { amount: 70 }, { timeoutMs: 1000, approvalId }), refused);
    assert.equal(await tab.evaluate(() => document.body.dataset.paid ?? null), null);

    // allowed on one site, then the tab goes to another site with a tool of the same name in the same frame
    approvalId = await allowFor(t);
    await tab.goto(`http://localhost:${site.portB}/webmcp`);
    t = await payTool();
    assert.match(t.description, /^Pay localhost/);
    await assert.rejects(() => tab.webmcp().call(t.handle, { amount: 70 }, { timeoutMs: 1000, approvalId }), refused);
    assert.equal(await tab.evaluate(() => document.body.dataset.paid ?? null), null);
  } finally {
    await tab.close();
    browser.close();
  }
});
