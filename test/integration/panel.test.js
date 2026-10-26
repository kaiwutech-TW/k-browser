// @ts-check
// In Chrome for Testing with the real extension: the activity panel (panel.html, opened as a tab here: the side
// panel needs a user's click) with a Kav-style raw CDP client and an SDK client at once; revoking from the panel;
// a stuck panel and a stuck disk writer never holding up CDP replies; CDP round trips with the panel closed vs open.
// Run: npm run test:chrome

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Activity } from '../../src/activity.js';
import * as auth from '../../src/auth.js';
import * as model from '../../src/model.js';
import { Browser } from '../../src/sdk/index.js';
import { CATEGORIES } from '../../src/sites.js';
import { startBridge } from '../../src/server.js';
import { FakeCdp, sleep, until } from '../fakes.js';
import { findChrome, launchChrome } from './cft.js';
import { eventually } from './mcp-harness.js';

const CHROME = findChrome();
const skip = CHROME ? false : 'Chrome for Testing not found (set KBROWSER_TEST_CHROME)';
const SECRET = 'FAKEpanelSecret0123456789zz';

/** @type {Awaited<ReturnType<typeof startBridge>>} */ let bridge;
/** @type {Awaited<ReturnType<typeof launchChrome>>} */ let chrome;
/** @type {http.Server} */ let server;
/** @type {string} */ let base;
/** @type {string} */ let diskDir;
/** a gate the disk writer waits on, when set @type {Promise<void> | null} */ let diskGate = null;
/** the extension's messages in the language Chrome picked for it (the system's on macOS; --lang has no effect there)
 * @type {Record<string, { message: string }>} */ let messages = {};
/** what the panel shows for a key, filled as the extension's i18n.js does @param {string} key @param {...unknown} values */
const M = (key, ...values) => messages[key].message.replace(/\{(\d)\}/g, (_, i) => String(values[Number(i)] ?? ''));
const esc = (/** @type {string} */ t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

before(async () => {
  if (skip) return;
  process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-panel-'));
  server = http.createServer((req, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(req.url?.startsWith('/titled?') ? `<!doctype html><title>${decodeURIComponent(String(req.url).slice(8)).replace(/</g, '&lt;')}</title>`
      : '<!doctype html><title>page &lt;b&gt;bold&lt;/b&gt;</title><style>body{margin:0}</style>'
      + '<button style="position:absolute;left:20px;top:20px;width:120px;height:30px">go</button>'
      + '<input aria-label="field" style="position:absolute;left:20px;top:80px;width:200px;height:30px">'));
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  diskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-panel-disk-'));
  const activity = new Activity({ limits: { fileQueue: 100 }, disk: { dir: diskDir, write: async (file, text) => {
    if (diskGate) await diskGate;
    await fs.promises.appendFile(file, text, { mode: 0o600 });
  } } });
  chrome = await launchChrome({ chrome: /** @type {string} */ (CHROME) });
  bridge = await startBridge({ port: 0, log: () => {}, activity, revokePollMs: 100 });
  await chrome.pair(/** @type {string} */ (auth.pairKey({ create: true })), bridge.port);
  assert.ok(await until(() => bridge.relay.ext !== null, 15000), 'the extension connected');
  const probe = await chrome.extensionPage('panel.html');
  const lang = await probe.eval("chrome.i18n.getMessage('lang')"); // not <html lang>: i18n.js may not have run yet
  await probe.close();
  messages = JSON.parse(fs.readFileSync(new URL(`../../extension/_locales/${lang === 'zh-TW' ? 'zh_TW' : 'en'}/messages.json`, import.meta.url), 'utf8'));
});

after(async () => {
  if (skip) return;
  await bridge?.close();
  await chrome?.close();
  await new Promise((r) => server?.close(r));
});

/** The panel page's visible text. @param {{ eval: (e: string) => Promise<any> }} p */
const panelText = (p) => p.eval('document.body.innerText');

test('two programs at once (raw CDP and the SDK): the panel groups them, shows the SDK\'s labels, never what was typed', { skip }, async () => {
  const kav = await new FakeCdp(bridge.base, auth.addClient('kav')).connect();
  const browser = await Browser.connect(`${bridge.base}/c/${auth.addClient('agent')}`);
  const panel = await chrome.extensionPage('panel.html');
  try {
    const { targetId } = await kav.call('Target.createTarget', { url: `${base}/kav?session=${SECRET}`, background: true });
    const { sessionId } = await kav.call('Target.attachToTarget', { targetId, flatten: true });
    await kav.call('Runtime.evaluate', { expression: `"${SECRET}"` }, sessionId);
    await kav.call('Input.insertText', { text: SECRET }, sessionId);
    const tab = await browser.newTab(`${base}/agent`);
    const snap = await tab.snapshot();
    const field = /** @type {any} */ (snap.refs.find((r) => r.name === 'field')).ref;
    await tab.type(field, SECRET, { fast: true });
    await tab.click(/** @type {any} */ (snap.refs.find((r) => r.name === 'go')).ref, { fast: true });
    assert.ok(await eventually(async () => {
      const t = await panelText(panel);
      return t.includes('kav') && t.includes('agent') && t.includes('click button "go"') && t.includes('Input.insertText');
    }, 8000), await panelText(panel));
    const text = await panelText(panel);
    assert.equal(text.split(SECRET).length - 1, 0, 'nothing typed or evaluated, no URL secret');
    assert.match(text, new RegExp(`type into textbox "field" \\(${SECRET.length} chars\\)`), 'the length only');
    assert.ok(text.includes(M('tagClient')), text);
    assert.match(text, /page <b>bold<\/b>/, 'a title with markup is plain text');
    assert.equal(await panel.eval('document.querySelectorAll("b").length'), 0);
  } finally {
    await panel.close();
    browser.close();
    await kav.close();
  }
});

// what the page and the client write — titles, hand-off reasons — is masked like the rest
test('a title and a hand-off reason carrying credentials and a session value: the panel and the popup list show them masked', { skip }, async () => {
  const token = auth.addClient('leaky');
  const pair = /** @type {string} */ (auth.pairKey());
  const session = 'FAKEsessionInReason4242';
  const kav = await new FakeCdp(bridge.base, token).connect();
  const panel = await chrome.extensionPage('panel.html');
  try {
    const { targetId } = await kav.call('Target.createTarget', { url: `${base}/titled?${encodeURIComponent(`t ${token} p ${pair}`)}`, background: true });
    await sleep(500);
    await kav.call('KBrowser.handoff', { targetId, reason: `see https://bank.test/x?session=${session} please` });
    assert.ok(await eventually(async () => /see https:\/\/bank\.test\/x\?session=\[redacted\]/.test(await panelText(panel)), 8000), await panelText(panel));
    const text = await panelText(panel);
    for (const secret of [token, pair, session]) assert.equal(text.split(secret).length - 1, 0, `${secret.slice(0, 6)}… in the panel`);
    assert.match(text, /\[redacted:credential\]/, 'the title is there, masked');
    const popupList = JSON.stringify((await chrome.handoffView()).items);
    for (const secret of [token, pair, session]) assert.equal(popupList.split(secret).length - 1, 0, `${secret.slice(0, 6)}… in the popup list`);
  } finally {
    await panel.close();
    await kav.close();
  }
});

test('revoke from the panel (two clicks): that program is disconnected at once and its token stops working', { skip }, async () => {
  const token = auth.addClient('victim');
  const victim = await new FakeCdp(bridge.base, token).connect();
  await victim.call('Target.createTarget', { url: `${base}/victim`, background: true });
  const panel = await chrome.extensionPage('panel.html');
  try {
    assert.ok(await eventually(async () => (await panelText(panel)).includes('victim'), 8000));
    const click = `(() => { const box = [...document.querySelectorAll('.client')].find((b) => b.querySelector('strong')?.textContent === 'victim');
      const btn = [...box.querySelectorAll('button')].find((b) => [${JSON.stringify(M('revoke'))}, ${JSON.stringify(M('revokeConfirm'))}].includes(b.textContent)); btn.click(); return btn.textContent; })()`;
    await panel.eval(click);
    assert.equal(auth.clientRecord('victim') !== null, true, 'one click does nothing');
    await panel.eval(click);
    assert.ok(await until(() => auth.clientRecord('victim') === null, 5000), 'removed');
    assert.ok(await until(() => victim.closed, 5000), 'disconnected');
    await assert.rejects(new FakeCdp(bridge.base, token).connect(), 'the old token no longer connects');
  } finally {
    await panel.close();
  }
});

test('Kav\'s model from the panel: kev and off at one click; JEV only after reading the agreement, with a key from the terminal and the current agreement version', { skip }, async () => {
  const configFile = path.join(/** @type {string} */ (process.env.KBROWSER_HOME), 'config.json');
  const backend = () => { try { return JSON.parse(fs.readFileSync(configFile, 'utf8')).model?.backend; } catch { return undefined; } };
  const click = (/** @type {string} */ label) => `(() => { const b = [...document.querySelectorAll('#model button')].find((x) => x.textContent === ${JSON.stringify(label)});
    if (b) b.click(); return Boolean(b); })()`;
  const KEY = 'jev-panel-key-0123456789abcdef';
  const panel = await chrome.extensionPage('panel.html');
  try {
    assert.ok(await eventually(async () => (await panelText(panel)).includes(M('current', M('backendKev'))), 8000), await panelText(panel));
    assert.equal(await panel.eval(click(M('modelOff'))), true);
    assert.ok(await until(() => backend() === 'off', 5000), 'off at one click');
    assert.ok(await eventually(async () => (await panelText(panel)).includes(M('current', M('backendOff'))), 5000));

    // no key yet: the agreement shows, but there is nothing to agree with; a forged command is refused by the bridge
    assert.equal(await panel.eval(click(M('useJev'))), true);
    let text = await panelText(panel);
    assert.ok(text.includes((M('lang') === 'zh-TW' ? model.CONSENT_TEXT : model.CONSENT_TEXT_EN)[0]) && text.includes(M('noJevKey')), text);
    assert.equal(await panel.eval(click(M('agreeJev'))), false);
    await panel.eval(`send({ op: 'model', backend: 'jev', consentVersion: ${model.CONSENT_VERSION} }), true`);
    assert.ok(await eventually(async () => (await panelText(panel)).includes(M('cmdNotDone', 'model', 'no JEV key')), 5000), await panelText(panel));
    await panel.eval(`send({ op: 'model', backend: 'cloud' }), true`);
    await sleep(300);
    assert.equal(backend(), 'off');

    // a key imported in the terminal; an agreement of another version (not the text shown) is refused
    model.saveJevKey(KEY);
    await panel.eval(`send({ op: 'model', backend: 'jev', consentVersion: ${model.CONSENT_VERSION - 1} }), true`);
    assert.ok(await eventually(async () => (await panelText(panel)).includes('not the current one'), 5000), await panelText(panel));
    assert.equal(backend(), 'off');
    assert.equal(await panel.eval(click(M('agreeJev'))), true);
    assert.ok(await until(() => backend() === 'jev', 5000), 'JEV after agreeing');
    const m = JSON.parse(fs.readFileSync(configFile, 'utf8')).model;
    assert.equal(m.consent.version, model.CONSENT_VERSION);
    assert.ok(await eventually(async () => (await panelText(panel)).includes(M('current', M('backendJev'))), 5000));
    text = await panelText(panel);
    assert.equal(text.includes(KEY), false, 'never the key');

    assert.equal(await panel.eval(click(M('useKev'))), true);
    assert.ok(await until(() => backend() === 'kev', 5000));
    assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).model.consent, undefined, 'leaving JEV withdraws the agreement');
  } finally {
    await panel.close();
    model.forgetJevKey();
  }
});

test('settings from the panel: a client\'s site categories (its own sites kept), screenshots, eval only off, the decision dataset', { skip }, async () => {
  const token = auth.addClient('tuner');
  auth.updateClient('tuner', { blockedOrigins: ['https://mine.example'], eval: true });
  const { principal } = /** @type {Record<string, any>} */ (auth.clientRecord('tuner'));
  const rec = () => /** @type {Record<string, any>} */ (auth.clientRecord('tuner'));
  const configFile = path.join(/** @type {string} */ (process.env.KBROWSER_HOME), 'config.json');
  const decisionLog = () => { try { return JSON.parse(fs.readFileSync(configFile, 'utf8')).decisionLog; } catch { return undefined; } };
  const inRow = (/** @type {string} */ js) => `(() => { const row = [...document.querySelectorAll('#configured .cfg')].find((r) => r.firstChild?.textContent === 'tuner');
    if (!row) return null; ${js} })()`;
  const click = (/** @type {string} */ label, /** @type {string} */ where = 'row') => {
    const find = `const b = [...${where}.querySelectorAll('button')].find((x) => x.textContent === ${JSON.stringify(label)}); if (b) b.click(); return Boolean(b);`;
    return where === 'row' ? inRow(find) : `(() => { ${find} })()`;
  };
  const rowText = async () => String(await panel.eval(inRow('return row.innerText;')));
  const bank = { ...CATEGORIES.banking, label: M('cat_banking') }; // the extension shows its own label for the category
  const panel = await chrome.extensionPage('panel.html');
  try {
    assert.ok(await eventually(async () => (await panelText(panel)).includes('tuner'), 8000), await panelText(panel));
    assert.equal(await panel.eval(click(M('settingsOpen'))), true);
    let text = await rowText();
    for (const s of [bank.label, M('otherSites', 1), M('evalOnLabel').trim(), M('anyBlockNoJev'), M('settingsApply')]) assert.ok(text.includes(s), `${s} in ${text}`);
    assert.ok(!text.includes('mine.example'), 'no site names');

    assert.equal(await panel.eval(click(bank.label)), true);
    assert.ok(await until(() => bank.hosts.every((h) => rec().blockedOrigins.includes(h)), 5000), 'the category is blocked');
    assert.ok(await eventually(async () => (await rowText()).includes(`✓ ${bank.label}`), 5000), await rowText());
    assert.equal(await panel.eval(click(`✓ ${bank.label}`)), true);
    assert.ok(await until(() => rec().blockedOrigins.length === 1, 5000));
    assert.deepEqual(rec().blockedOrigins, ['https://mine.example'], 'its own site stays');

    assert.ok(await eventually(async () => (await panel.eval(click(M('screenshotOff')))) === true, 5000));
    assert.ok(await until(() => rec().screenshot === false, 5000));
    assert.ok(await eventually(async () => (await rowText()).includes(M('screenshotLabel', M('off')).trim()), 5000));

    assert.equal(await panel.eval(click(M('evalOff'))), true);
    assert.ok(await until(() => rec().eval === false, 5000));
    assert.ok(await eventually(async () => (await rowText()).includes('k-browser client set tuner --eval on'), 5000), await rowText());
    text = await rowText();
    assert.ok(!text.includes('Turn eval on') && !text.includes('開啟 eval'), 'no way to turn eval on here');
    // a forged "eval on" is dropped by the extension (and the bridge refuses it too)
    await panel.eval(`send({ op: 'eval', name: 'tuner', principal: ${JSON.stringify(principal)}, on: true }), true`);
    await sleep(300);
    assert.equal(rec().eval, false);

    assert.equal(await panel.eval(click(M('decisionsOn'), "document.querySelector('#decisions')")), true);
    assert.ok(await until(() => decisionLog() === 'on', 5000));
    assert.ok(await eventually(async () => (await panelText(panel)).includes(M('about', '', '', '', M('on')).split(' · ').at(-1)), 5000));
    assert.ok((await panelText(panel)).includes('k-browser decisions purge'));
    assert.equal(await panel.eval(click(M('decisionsOff'), "document.querySelector('#decisions')")), true);
    assert.ok(await until(() => decisionLog() === 'off', 5000));
    assert.deepEqual([rec().token, rec().principal], [token, principal], 'token and principal unchanged');
  } finally {
    await panel.close();
    auth.removeClient('tuner');
  }
});

test('backpressure: a stuck panel and a stuck disk writer never hold up CDP replies; both later show a gap', { skip }, async () => {
  const kav = await new FakeCdp(bridge.base, auth.addClient('load')).connect();
  const { targetId } = await kav.call('Target.createTarget', { url: `${base}/load`, background: true });
  const { sessionId } = await kav.call('Target.attachToTarget', { targetId, flatten: true });
  const panel = await chrome.extensionPage('panel.html');
  try {
    await sleep(500);
    await chrome.inWorker('globalThis.kbPanelGate = new Promise((r) => { globalThis.kbPanelRelease = r; }), true');
    /** @type {() => void} */ let releaseDisk = () => {};
    diskGate = new Promise((r) => { releaseDisk = () => r(undefined); });
    const t0 = Date.now();
    for (let i = 0; i < 600; i++) await kav.call(i % 2 ? 'Runtime.evaluate' : 'Page.getLayoutMetrics', i % 2 ? { expression: '1' } : {}, sessionId);
    const ms = Date.now() - t0;
    const a = bridge.relay.activity;
    assert.ok(/** @type {any} */ (a.panel).queue.size <= a.limits.queue, 'panel queue bounded');
    assert.ok(/** @type {any} */ (a.file).queue.size <= a.limits.fileQueue, 'disk queue bounded');
    assert.ok(ms < 30_000, `600 commands answered in ${ms} ms while both consumers were stuck`);
    await chrome.inWorker('globalThis.kbPanelGate = null, globalThis.kbPanelRelease(), true');
    diskGate = null;
    releaseDisk();
    assert.ok(await eventually(async () => (await panelText(panel)).includes(M('gap', '').split('(')[0].trim()), 8000), 'the panel shows the gap');
    assert.ok(await eventually(async () => fs.readdirSync(diskDir).some((f) => fs.readFileSync(path.join(diskDir, f), 'utf8').includes('"type":"gap"')), 5000), 'the file marks the gap');
    for (const f of fs.readdirSync(diskDir)) {
      assert.equal(fs.statSync(path.join(diskDir, f)).mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(path.join(diskDir, f), 'utf8').split(SECRET).length - 1, 0, 'no secret on disk');
    }
  } finally {
    await panel.close();
    await kav.close();
  }
});

// the panel page itself stuck (not the extension's worker)
test('a busy panel page: CDP replies stay fast, the bridge queue stays bounded, and the panel shows the gap once it runs again', { skip }, async () => {
  const kav = await new FakeCdp(bridge.base, auth.addClient('busy')).connect();
  const { targetId } = await kav.call('Target.createTarget', { url: `${base}/busy`, background: true });
  const { sessionId } = await kav.call('Target.attachToTarget', { targetId, flatten: true });
  const panel = await chrome.extensionPage('panel.html');
  try {
    assert.ok(await eventually(async () => (await panelText(panel)).includes('busy'), 8000));
    // stuck for longer than two ack periods, while updates come in three waves
    void panel.eval('(() => { const end = Date.now() + 14000; while (Date.now() < end) {} return true; })()').catch(() => {}); // the page's thread is busy
    await sleep(200);
    let ms = 0;
    for (let wave = 0; wave < 3; wave++) {
      const t0 = Date.now();
      for (let i = 0; i < 200; i++) await kav.call(i % 2 ? 'Runtime.evaluate' : 'Page.getLayoutMetrics', i % 2 ? { expression: '1' } : {}, sessionId);
      ms = Math.max(ms, Date.now() - t0);
      if (wave < 2) await sleep(5500);
    }
    assert.ok(ms < 15_000, `a wave of 200 took ${ms} ms`);
    assert.ok((bridge.relay.activity.panel?.queue.size ?? 0) <= bridge.relay.activity.limits.queue, 'bounded (or no subscriber left: the stuck panel was let go)');
    assert.ok(await eventually(async () => (await panelText(panel)).includes(M('gap', '').split('(')[0].trim()), 30_000), 'the panel shows the gap');
    // the stuck panel was let go: the backlog did not pile up for it; it reconnected and resynced from a snapshot
    assert.ok(await eventually(async () => (await panelText(panel)).includes('busy') && (await panelText(panel)).includes(M('panelConnected')), 10_000));
    const got = Number(await panel.eval('document.body.dataset.updates'));
    assert.ok(got < 600, `the panel received ${got} updates, not the whole backlog`);
  } finally {
    await panel.close();
    await kav.close();
  }
});

test('two panels, one stuck: the other keeps getting updates; the stuck one is let go and catches up from a snapshot', { skip }, async () => {
  const kav = await new FakeCdp(bridge.base, auth.addClient('twopanels')).connect();
  const healthy = await chrome.extensionPage('panel.html');
  const stuck = await chrome.extensionPage('panel.html');
  try {
    await kav.call('Target.createTarget', { url: `${base}/titled?first-title`, background: true });
    for (const p of [healthy, stuck]) assert.ok(await eventually(async () => (await panelText(p)).includes('first-title'), 8000));
    void stuck.eval('(() => { const end = Date.now() + 9000; while (Date.now() < end) {} return true; })()').catch(() => {});
    await sleep(200);
    await kav.call('Target.createTarget', { url: `${base}/titled?while-stuck`, background: true });
    // the stuck one is let go after one ack period. Pages of one extension share a renderer's main thread, so a page busy
    // like this also holds up the healthy one's drawing: it shows the update once the busy page lets go (measured ~10 s)
    const t0 = Date.now();
    assert.ok(await eventually(async () => (await panelText(healthy)).includes('while-stuck'), 15_000), await panelText(healthy));
    const healthyMs = Date.now() - t0;
    await kav.call('Target.createTarget', { url: `${base}/titled?after-let-go`, background: true });
    assert.ok(await eventually(async () => (await panelText(healthy)).includes('after-let-go'), 8000), 'the healthy panel is not left behind');
    for (const t of ['while-stuck', 'after-let-go']) {
      assert.ok(await eventually(async () => (await panelText(stuck)).includes(t), 20_000), `the stuck panel catches up: ${t}`);
    }
    console.log(`[two panels] the healthy panel showed the update after ${healthyMs} ms`);
  } finally {
    await healthy.close();
    await stuck.close();
    await kav.close();
  }
});

test('the panel marks a background tab, and stops when the tab is the one its window shows', { skip }, async () => {
  const kav = await new FakeCdp(bridge.base, auth.addClient('bgtabs')).connect();
  const panel = await chrome.extensionPage('panel.html');
  try {
    const { targetId: shown } = await kav.call('Target.createTarget', { url: `${base}/titled?front-tab` });
    await kav.call('Target.createTarget', { url: `${base}/titled?back-tab`, background: true });
    const line = async (/** @type {string} */ t) => (await panelText(panel)).split('\n').find((/** @type {string} */ l) => l.includes(t)) ?? '';
    assert.ok(await eventually(async () => (await line('back-tab')).includes(M('backgroundTab').trim()), 8000), await panelText(panel));
    assert.ok(!(await line('front-tab')).includes(M('backgroundTab').trim()), await panelText(panel));
    await kav.call('Target.activateTarget', { targetId: shown });
    const { targetInfos } = await kav.call('Target.getTargets');
    const back = targetInfos.find((/** @type {any} */ x) => x.url.includes('back-tab'));
    await kav.call('Target.activateTarget', { targetId: back.targetId });
    assert.ok(await eventually(async () => !(await line('back-tab')).includes(M('backgroundTab').trim()) && (await line('front-tab')).includes(M('backgroundTab').trim()), 8000), await panelText(panel));
  } finally {
    await panel.close();
    await kav.close();
  }
});

test('latency: CDP round trips with the panel closed vs open (recorded side by side)', { skip }, async () => {
  const kav = await new FakeCdp(bridge.base, auth.addClient('timing')).connect();
  const { targetId } = await kav.call('Target.createTarget', { url: `${base}/timing`, background: true });
  const { sessionId } = await kav.call('Target.attachToTarget', { targetId, flatten: true });
  const first = await kav.call('Runtime.evaluate', { expression: '6 * 7', returnByValue: true }, sessionId);
  assert.equal(first.result?.value, 42, 'the command really runs in the page');
  const measure = async () => {
    /** @type {number[]} */ const rtt = [];
    for (let i = 0; i < 300; i++) {
      const t = process.hrtime.bigint();
      await kav.call('Runtime.evaluate', { expression: String(i) }, sessionId);
      rtt.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    rtt.sort((x, y) => x - y);
    return { median: +rtt[150].toFixed(2), p95: +rtt[285].toFixed(2) };
  };
  try {
    await sleep(300);
    const closed = await measure();
    const panel = await chrome.extensionPage('panel.html');
    await sleep(800);
    const open = await measure();
    await panel.close();
    console.log(`LATENCY panel closed ${JSON.stringify(closed)} / open ${JSON.stringify(open)} (ms, 300 Runtime.evaluate each)`);
    assert.ok(open.p95 < closed.p95 * 3 + 20, `open ${open.p95} ms vs closed ${closed.p95} ms`);
  } finally {
    await kav.close();
  }
});

test('nothing connected: the panel still lists every configured client (idle), its settings as counts, the versions; no token, no site name', { skip }, async () => {
  const token = auth.addClient('idle-one');
  auth.updateClient('idle-one', { blockedOrigins: ['bank.example', 'mail.example'], eval: true });
  const panel = await chrome.extensionPage('panel.html');
  try {
    assert.ok(await eventually(async () => /idle-one/.test(await panelText(panel)), 10000), await panelText(panel));
    const text = await panelText(panel);
    assert.ok(text.includes(M('panelConfiguredHeading')), text);
    assert.match(text, new RegExp(`idle-one\\s*${esc(M('idle'))}[\\s\\S]*${esc([M('blockedN', 2), M('screenshotState', M('on')), M('evalState', M('on'))].join(' · '))}`));
    const version = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
    assert.ok(text.includes(M('about', version, version, M('startedManual'), M('off'))), text);
    assert.ok(!text.includes(token) && !text.includes('bank.example'), 'counts only: no token, no blocked site names');
  } finally {
    await panel.close();
    auth.removeClient('idle-one');
  }
});
