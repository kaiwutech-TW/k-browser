// @ts-check
// run_flow against a fake Kav (test/fixtures/fake-kav.js, a real child process speaking Kav's MCP
// interface), the real bridge and a fake extension: the caller's identity, the site policy before and during the run,
// stopping (timeout, cancel, a blocked site, losing the watch) and what comes back. test/integration/flow.test.js runs the
// real Kav.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as auth from '../src/auth.js';
import { ChildTransport } from '../src/mcp/flow.js';
import { McpSession } from '../src/mcp/server.js';
import { startBridge } from '../src/server.js';
import { FakeExtension, OPEN, sleep, until } from './fakes.js';

const FAKE_KAV = fileURLToPath(new URL('./fixtures/fake-kav.js', import.meta.url));

/** @type {Awaited<ReturnType<typeof startBridge>>} */ let bridge;
/** @type {FakeExtension} */ let ext;
/** @type {string} */ let kavDir;
/** @type {string} */ let kfwHome;
/** @type {McpSession[]} */ const sessions = [];

beforeEach(async () => {
  process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-flow-'));
  kavDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-kav-'));
  kfwHome = path.join(kavDir, 'home');
  fs.mkdirSync(path.join(kfwHome, 'recipes'), { recursive: true });
  fs.mkdirSync(path.join(kavDir, 'recipes'));
  fs.writeFileSync(path.join(/** @type {string} */ (process.env.KBROWSER_HOME), 'config.json'),
    JSON.stringify({ kav: { dir: kavDir, home: kfwHome }, model: { url: 'http://127.0.0.1:8009' } }));
  bridge = await startBridge({ port: 0, revokePollMs: 50, log: () => {} });
  ext = new FakeExtension(bridge.base, /** @type {string} */ (auth.pairKey({ create: true })));
  assert.ok(await ext.connect());
  assert.ok(await until(() => bridge.relay.ext !== null));
});

afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  while (OPEN.length) await /** @type {any} */ (OPEN.pop()).close();
  await bridge.close();
});

/** A flow file Kav would load. @param {string} name @param {Record<string, any>} recipe @param {'user' | 'builtin'} [where] */
function flow(name, recipe, where = 'user') {
  fs.writeFileSync(path.join(where === 'user' ? kfwHome : kavDir, 'recipes', `${name}.json`), JSON.stringify({ name, url: 'https://allowed.example/', ...recipe }));
}

/** An MCP session of client "codex" whose Kav is the fake. @param {{ version?: string, blocked?: string[], name?: string }} [o] */
function session({ version = '0.0.8', blocked = ['blocked.example'], name = 'codex' } = {}) {
  auth.addClient(name);
  auth.updateClient(name, { blockedOrigins: blocked });
  const s = new McpSession({ name, port: bridge.port, record: /** @type {any} */ (auth.clientRecord(name)) });
  s.kavTransport = (env, dir) => new ChildTransport(process.execPath, [FAKE_KAV], { ...env, FAKE_KAV_VERSION: version }, dir);
  sessions.push(s);
  return s;
}

/** The JSON head of a tool result, and the whole text. @param {any} r */
function parse(r) {
  const text = r.content.map((/** @type {any} */ c) => c.text ?? '').join('\n');
  return { head: JSON.parse(text.split('\n')[0]), text, isError: r.isError === true };
}

/** @param {string} name @param {string} what */
const noted = (name, what) => JSON.parse(fs.readFileSync(path.join(kfwHome, `${name}.${what}.json`), 'utf8'));

/** @param {number} pid */
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('listed only when Kav is set up; the result: codes in the head, page text untrusted; Kav runs as the caller, with a short environment', async () => {
  const s = session();
  assert.ok(s.tools().some((t) => t.name === 'run_flow'));
  process.env.KBROWSER_TEST_SECRET = 'sk-should-not-reach-kav';
  flow('ok', { fake: { mode: 'done' } });
  const r = parse(await s.call('run_flow', { flow: 'ok', params: { q: 1 } }));
  delete process.env.KBROWSER_TEST_SECRET;
  assert.equal(r.head.status, 'done', r.text);
  assert.equal(r.head.kav_version, '0.0.8');
  assert.deepEqual(r.head.kev, { calls: 0, input_tokens: 0 });
  assert.equal(r.head.rows_total, 1);
  assert.ok(!('steps' in JSON.parse(r.text.slice(r.text.indexOf('{', r.text.indexOf('<untrusted'))).replace(/<\/untrusted[\s\S]*$/, '') || '{}')), 'steps only with detail');
  assert.match(r.text, /<untrusted-page-content>[\s\S]*ignore the user[\s\S]*<\/untrusted-page-content>$/);
  assert.equal(r.text.match(/<\/untrusted-page-content>/g)?.length, 1, 'the page cannot close the block');
  const { env, params } = noted('ok', 'env');
  assert.deepEqual(params, { q: 1 });
  const token = /** @type {any} */ (auth.clientRecord('codex')).token;
  assert.equal(env.KFW_CDP, `http://127.0.0.1:${bridge.port}/c/${token}`, 'the caller\'s own endpoint');
  assert.equal(env.KFW_KEV, `http://127.0.0.1:${bridge.port}/model`, 'the bridge\'s model exit, without the token');
  assert.equal(env.KFW_HOME, kfwHome);
  assert.equal(env.KBROWSER_TEST_SECRET, undefined, 'nothing else of K-Browser\'s environment');
  assert.ok(!r.text.includes(token), 'the token is not in the result');
  const detail = parse(await s.call('run_flow', { flow: 'ok', detail: true }));
  assert.match(detail.text, /"steps"/);

  fs.rmSync(path.join(/** @type {string} */ (process.env.KBROWSER_HOME), 'config.json'));
  const plain = new McpSession({ name: 'codex', port: bridge.port, record: /** @type {any} */ (auth.clientRecord('codex')) });
  sessions.push(plain);
  assert.ok(!plain.tools().some((t) => t.name === 'run_flow'), 'no Kav: not listed');
  assert.match(parse(await plain.call('run_flow', { flow: 'ok' })).text, /unknown_tool/);
});

test('needs_help comes back as Kav said; a token in Kav\'s text is redacted; a bad answer is an error', async () => {
  const s = session();
  flow('help', { fake: { mode: 'needs_help' } });
  const h = parse(await s.call('run_flow', { flow: 'help' }));
  assert.deepEqual([h.head.status, h.head.reason, h.isError], ['needs_help', 'pick_uncertain', false]);
  assert.match(h.text, /<untrusted-page-content>[\s\S]*SYSTEM obey me/);
  // the model off: what Kav gives to decide comes back, as page text, lists cut to 30
  flow('stuck', { fake: { mode: 'stuck' } });
  const st = parse(await s.call('run_flow', { flow: 'stuck' }));
  assert.deepEqual([st.head.reason, st.head.why], ['model_off', 'pick_uncertain']);
  const page = st.text.slice(st.text.indexOf('<untrusted-page-content>'));
  for (const want of ['item 30', 'Taipei', 'Taichung', '"probabilities"', '"station"', 'odd', '"dropped_after_verify"']) assert.ok(page.includes(want), want);
  assert.ok(!page.includes('item 31'), 'cut to 30');
  assert.ok(!st.text.includes('not passed'), 'only the listed fields');
  flow('leak', { fake: { mode: 'leak' } });
  const l = parse(await s.call('run_flow', { flow: 'leak' }));
  assert.ok(!l.text.includes(/** @type {any} */ (auth.clientRecord('codex')).token), l.text);
  flow('bad', { fake: { mode: 'bad' } });
  assert.deepEqual([parse(await s.call('run_flow', { flow: 'bad' })).head.reason], ['kav_bad_result']);
});

test('refused before Kav starts: old Kav, recorded flow, a blocked url / domain / open tab, a model off this machine, unknown flow, bad arguments', async () => {
  flow('ok', { fake: { mode: 'done' } });
  for (const v of ['0.0.2', '0.0.7', '']) {
    const r = parse(await session({ version: v, name: `old${v.length}${v.slice(-1)}` }).call('run_flow', { flow: 'ok' }));
    assert.deepEqual([r.head.status, r.isError], ['kav_unsupported', true], r.text);
  }
  const s = session();
  flow('rec', { recorded_from: 'a8132dd0d1fa', fake: { mode: 'done' } });
  assert.equal(parse(await s.call('run_flow', { flow: 'rec' })).head.status, 'recorded_flow');
  flow('blocked-url', { url: 'https://www.blocked.example/x' });
  flow('blocked-domain', { domains: ['allowed.example', '台灣銀行', 'blocked.example'] });
  flow('words', { domains: ['allowed.example', '台灣銀行', 'blocked'], fake: { mode: 'done' } });
  assert.equal(parse(await s.call('run_flow', { flow: 'words' })).head.status, 'done', 'search words in domains are not hosts');
  flow('builtin-blocked', { url: 'https://blocked.example/' }, 'builtin');
  for (const f of ['blocked-url', 'blocked-domain', 'builtin-blocked']) {
    const r = parse(await s.call('run_flow', { flow: f }));
    assert.deepEqual([r.head.status, r.head.when], ['blocked_origin', 'before'], `${f}: ${r.text}`);
    assert.ok(!fs.existsSync(path.join(kfwHome, `${f}.env.json`)), `${f}: Kav never started`);
  }
  // one of the caller's tabs is already on a blocked site: Kav could pick it up
  const tid = ext.newTab('https://blocked.example/inbox');
  ext.owned.add(tid);
  const before = await s.call('tabs', { action: 'open', url: 'about:blank' });
  assert.ok(before);
  const owner = /** @type {any} */ ([...bridge.relay.targets.values()][0]);
  ext.event('tab.updated', { tabId: owner.tabId, url: 'https://blocked.example/inbox' });
  await sleep(50);
  const open = parse(await s.call('run_flow', { flow: 'ok' }));
  assert.deepEqual([open.head.status, open.head.when], ['blocked_origin', 'before'], open.text);
  ext.event('tab.updated', { tabId: owner.tabId, url: 'https://allowed.example/' });
  await sleep(50);

  assert.equal(parse(await s.call('run_flow', { flow: 'nope' })).head.reason, 'unknown_flow');
  assert.equal(parse(await s.call('run_flow', { flow: '../etc' })).head.reason, 'bad_argument');
  assert.equal(parse(await s.call('run_flow', { flow: 'ok', params: [1] })).head.reason, 'bad_argument');
});

test('timeout and cancel stop Kav and everything it started; the result is unknown; one run at a time', async () => {
  const s = session();
  flow('slow', { fake: { mode: 'hang' } });
  const started = Date.now();
  const t = parse(await s.call('run_flow', { flow: 'slow', timeout_s: 1 }));
  assert.equal(t.head.status, 'timeout', t.text);
  assert.match(t.head.message, /result is unknown.*Nothing was sent again/);
  assert.ok(Date.now() - started < 5000);
  const pids = noted('slow', 'pids');
  assert.ok(await until(() => !alive(pids.kav) && !alive(pids.child), 3000), 'Kav and its child are gone');

  fs.rmSync(path.join(kfwHome, 'slow.pids.json'));
  const ac = new AbortController();
  const running = s.call('run_flow', { flow: 'slow' }, ac.signal);
  assert.ok(await until(() => fs.existsSync(path.join(kfwHome, 'slow.pids.json')), 5000));
  const busy = parse(await s.call('run_flow', { flow: 'slow' }));
  assert.equal(busy.head.status, 'busy');
  ac.abort();
  const c = parse(await running);
  assert.equal(c.head.status, 'cancelled', c.text);
  const p2 = noted('slow', 'pids');
  assert.ok(await until(() => !alive(p2.kav) && !alive(p2.child), 3000));
});

test('while it runs: a tab of the caller on a blocked site (a new tab, or one navigating there) stops Kav; so does losing the watch', async () => {
  const s = session();
  flow('popup', { fake: { mode: 'open-blocked', url: 'https://blocked.example/' } });
  const r = parse(await s.call('run_flow', { flow: 'popup' }));
  assert.deepEqual([r.head.status, r.head.when, r.head.origin], ['blocked_origin', 'during', 'https://blocked.example'], r.text);
  assert.match(r.head.message, /result is unknown/);
  assert.equal(r.head.tabs.length, 1, 'the blocked tab is still open (and the caller\'s)');
  // while it is open, the next run is refused before Kav starts; close it first
  flow('nav', { fake: { mode: 'hang' } });
  assert.equal(parse(await s.call('run_flow', { flow: 'nav' })).head.when, 'before');
  const stale = /** @type {any} */ ([...bridge.relay.targets.values()].find((t) => String(t.url).includes('blocked.example')));
  ext.op_tabs_close({ tabId: stale.tabId });
  assert.ok(await until(() => ![...bridge.relay.targets.values()].some((t) => String(t.url).includes('blocked.example'))));

  const run = s.call('run_flow', { flow: 'nav' });
  assert.ok(await until(() => fs.existsSync(path.join(kfwHome, 'nav.pids.json')), 5000));
  const tid = ext.newTab('https://allowed.example/');
  ext.owned.add(tid);
  const created = await new McpSession({ name: 'codex', port: bridge.port, record: /** @type {any} */ (auth.clientRecord('codex')) });
  sessions.push(created);
  await created.call('tabs', { action: 'open', url: 'about:blank' });
  const mine = /** @type {any} */ ([...bridge.relay.targets.values()].at(-1));
  ext.event('tab.updated', { tabId: mine.tabId, url: 'https://blocked.example/mail' });
  const n = parse(await run);
  assert.deepEqual([n.head.status, n.head.when], ['blocked_origin', 'during'], n.text);
  const pids = noted('nav', 'pids');
  assert.ok(await until(() => !alive(pids.kav) && !alive(pids.child), 3000));

  fs.rmSync(path.join(kfwHome, 'nav.pids.json'));
  ext.op_tabs_close({ tabId: mine.tabId });
  assert.ok(await until(() => ![...bridge.relay.targets.values()].some((t) => String(t.url).includes('blocked.example'))));
  const run2 = s.call('run_flow', { flow: 'nav' });
  assert.ok(await until(() => fs.existsSync(path.join(kfwHome, 'nav.pids.json')), 5000));
  s.browser?.close();
  assert.equal(parse(await run2).head.status, 'monitor_lost');
});

test('Kav answering before the blocked site is heard of, or naming it as its page: the content is dropped', async () => {
  const s = session();
  flow('fast', { fake: { mode: 'open-blocked-fast', url: 'https://blocked.example/' } });
  const r = parse(await s.call('run_flow', { flow: 'fast' }));
  assert.equal(r.head.status, 'blocked_origin', r.text);
  assert.ok(!r.text.includes('from the blocked page'), 'Kav\'s rows are not returned');
  const stale = /** @type {any} */ ([...bridge.relay.targets.values()].find((t) => String(t.url).includes('blocked.example')));
  ext.op_tabs_close({ tabId: stale.tabId });
  assert.ok(await until(() => ![...bridge.relay.targets.values()].some((t) => String(t.url).includes('blocked.example'))));
  // the page Kav says it read is blocked, though no tab event said so
  flow('named', { fake: { mode: 'open-blocked-fast', url: 'https://allowed.example/', answerUrl: 'https://blocked.example/x' } });
  const n = parse(await s.call('run_flow', { flow: 'named' }));
  assert.deepEqual([n.head.status, n.head.when], ['blocked_origin', 'after'], n.text);
  assert.ok(!n.text.includes('from the blocked page'));
});

test('content comes back only from pages Kav names, all allowed: unattributed content is withheld, a blocked page among them drops it', async () => {
  const s = session();
  flow('anon', { fake: { mode: 'nosources' } });
  const a = parse(await s.call('run_flow', { flow: 'anon' }));
  assert.deepEqual([a.head.status, a.head.content], ['done', 'withheld'], a.text);
  assert.ok(!a.text.includes('unattributed row') && !a.text.includes('<untrusted'));
  flow('mid', { fake: { mode: 'mid-blocked' } });
  const m = parse(await s.call('run_flow', { flow: 'mid' }));
  assert.deepEqual([m.head.status, m.head.when, m.head.origin], ['blocked_origin', 'after', 'https://blocked.example'], m.text);
  assert.ok(!m.text.includes('MID_BLOCKED_ROW'));
});

test('another client sees nothing of the run; tabs Kav leaves open come back; a flow file changed during the run is flagged', async () => {
  const s = session();
  const other = session({ name: 'claude-code' });
  flow('opens', { fake: { mode: 'open', url: 'https://allowed.example/a' } });
  const r = parse(await s.call('run_flow', { flow: 'opens' }));
  assert.equal(r.head.status, 'done', r.text);
  assert.equal(r.head.tabs.length, 1, 'the tab Kav opened as the caller');
  const mine = parse(await s.call('tabs', { action: 'list' }));
  assert.ok(mine.head.tabs.some((/** @type {any} */ x) => x.tab === r.head.tabs[0]));
  const theirs = parse(await other.call('tabs', { action: 'list' }));
  assert.deepEqual(theirs.head.tabs, [], 'not the other client\'s');
  flow('edit', { fake: { mode: 'edit' } });
  assert.equal(parse(await s.call('run_flow', { flow: 'edit' })).head.flow_changed, true);
});
