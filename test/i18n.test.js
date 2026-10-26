// @ts-check
// The extension's two languages (_locales/en, _locales/zh_TW): the same keys and the same {n} values in both, no "$" that
// Chrome would read as a substitution, every key the code asks for exists; the side panel rendered in English (in a VM,
// as test/activity.test.js does) has no Chinese of its own; the JEV agreement has an English text of the same shape.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import * as model from '../src/model.js';

const ext = (/** @type {string} */ f) => new URL(`../extension/${f}`, import.meta.url);
/** @param {string} loc @returns {Record<string, { message: string }>} */
const load = (loc) => JSON.parse(fs.readFileSync(ext(`_locales/${loc}/messages.json`), 'utf8'));
const en = load('en');
const zh = load('zh_TW');
const holes = (/** @type {string} */ m) => [...m.matchAll(/\{(\d)\}/g)].map((x) => x[1]).sort().join(',');

test('en and zh_TW have the same keys and the same {n} values; no "$"', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const k of Object.keys(en)) {
    assert.equal(holes(en[k].message), holes(zh[k].message), k);
    assert.ok(!en[k].message.includes('$') && !zh[k].message.includes('$'), `${k}: "$" is a Chrome substitution`);
    assert.ok(en[k].message.trim() && zh[k].message.trim(), `${k} is empty`);
  }
  assert.equal(en.lang.message, 'en');
  assert.equal(zh.lang.message, 'zh-TW');
});

test('every key the extension asks for exists', () => {
  const code = ['popup.js', 'panel.js', 'background.js', 'popup.html', 'panel.html', 'manifest.json'].map((f) => fs.readFileSync(ext(f), 'utf8')).join('\n');
  const used = new Set([
    ...[...code.matchAll(/\bmsg\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]),
    ...[...code.matchAll(/\bmsg\([^)]*\?\s*'([A-Za-z0-9_]+)'\s*:\s*'([A-Za-z0-9_]+)'/g)].flatMap((m) => [m[1], m[2]]),
    ...[...code.matchAll(/getMessage\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]),
    ...[...code.matchAll(/data-i18n="([A-Za-z0-9_]+)"/g)].map((m) => m[1]),
    ...[...code.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((m) => m[1]),
  ]);
  assert.ok(used.size > 60, `found ${used.size} keys`);
  for (const k of used) assert.ok(en[k], `${k} is missing`);
  for (const id of ['banking', 'payments', 'email', 'government', 'crypto', 'passwords']) assert.ok(en[`cat_${id}`], `cat_${id}`);
  assert.equal(code.match(/[一-鿿]/), null, 'no Chinese left in the extension\'s code');
});

test('the side panel in English: no Chinese of its own; the English agreement; category labels by id', () => {
  /** @type {any[]} */ const made = [];
  const node = (/** @type {string} */ tag) => {
    const n = { tag, textContent: '', className: '', hidden: false, children: /** @type {any[]} */ ([]), ariaPressed: '',
      /** @type {(() => void) | null} */ onclick: null,
      append(/** @type {any[]} */ ...c) { this.children.push(...c); }, replaceChildren() { this.children = []; },
      addEventListener(/** @type {string} */ _type, /** @type {() => void} */ f) { this.onclick = f; } };
    made.push(n);
    return n;
  };
  /** @type {Record<string, any>} */ const byId = {};
  for (const id of ['status', 'gap', 'clients', 'about', 'configured', 'modelBox', 'model', 'decisionsBox', 'decisions']) byId[id] = node('div');
  /** @type {(m: any) => void} */ let deliver = () => {};
  const chrome = { runtime: { connect: () => ({ onMessage: { addListener: (/** @type {any} */ f) => { deliver = f; } }, onDisconnect: { addListener() {} }, postMessage() {} }) },
    i18n: { getMessage: (/** @type {string} */ k) => en[k]?.message ?? '' } };
  const document = { getElementById: (/** @type {string} */ id) => byId[id], createElement: node, body: { dataset: {} } };
  const context = vm.createContext({ chrome, document, Date, setTimeout, String, Math, Map, Set, Number, Array, JSON });
  for (const f of ['i18n.js', 'panel.js']) vm.runInContext(fs.readFileSync(ext(f), 'utf8'), context);
  const now = Date.now();
  deliver({ type: 'push', batch: { seq: 1, gap: false, updates: [{ type: 'snapshot',
    state: { clients: [{ principal: 'p1', name: 'claude-code', connections: 2, lastActive: now }],
      tabs: [{ principal: 'p1', targetId: 'T', title: 'Shop', url: 'https://x.test/', background: true }],
      handoffs: [{ handoffId: 'h1', principal: 'p1', targetId: 'T', reason: 'log in please', since: now }],
      about: { version: '0.4.0', extension: '0.4.0', launchd: true, decisionLog: false, categories: [{ id: 'banking', label: '網路銀行' }],
        model: { ...model.panelView(), backend: 'kev', consentText: model.CONSENT_TEXT, consentTextEn: model.CONSENT_TEXT_EN } },
      configured: [{ name: 'claude-code', principal: 'p1', connected: true, blocked: 3, screenshot: true, eval: false, sites: { on: ['banking'], part: [], other: 0 } }] },
    activity: [{ principal: 'p1', entries: [{ id: 1, principal: 'p1', kind: 'call', t: now, method: 'Page.navigate', outcome: 'refused' }] }] }] } });
  const texts = () => made.map((n) => n.textContent).join('\n');
  assert.equal(texts().match(/[一-鿿]/), null, texts());
  for (const s of ['Waiting for you: log in please', 'Tabs (1)', '(background tab)', 'Revoke this program', '(refused by policy)', 'Now: local Kev',
    'K-Browser 0.4.0 · extension 0.4.0 · starts at login (launchd) · decision dataset off', 'eval off']) assert.ok(texts().includes(s), `${s} in\n${texts()}`);
  // a client's settings and the JEV agreement open on click: press the buttons rendered last
  const press = (/** @type {string} */ label) => {
    const b = made.filter((n) => n.tag === 'button' && n.textContent === label).at(-1);
    assert.ok(b?.onclick, label);
    b.onclick();
  };
  press('Settings…');
  assert.ok(texts().includes('✓ Online banking'), 'the category label comes from the extension, by id');
  press('Use cloud JEV…');
  assert.ok(texts().includes(model.CONSENT_TEXT_EN[0]) && !texts().includes(model.CONSENT_TEXT[0]), 'the English agreement');
  assert.equal(texts().match(/[\u4e00-\u9fff]/), null, texts());
});

test('the JEV agreement: English and Chinese texts of the same shape', () => {
  assert.equal(model.CONSENT_TEXT_EN.length, model.CONSENT_TEXT.length);
  assert.equal(model.CONSENT_TEXT_EN.join('\n').match(/[一-鿿]/), null);
  assert.deepEqual(model.panelView().consentTextEn, model.CONSENT_TEXT_EN);
});
