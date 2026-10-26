// @ts-check
// run_flow with the real Kav (Kav >= 0.0.2, its own venv) in Chrome for Testing, through the real bridge:
// a hand-written flow runs as the caller, again with other parameters and no model call; a redirect to a blocked site
// stops Kav and keeps what it read from coming back. With the local Kev (127.0.0.1:8009; skipped when it is not
// running) a pick by meaning lands in the decision dataset, a refusal too, and an invalid answer (from a stand-in Kev). Kav's flows live in a throwaway KFW_HOME; the user's
// ~/.kav-fastweb and ~/.k-browser are not used. Skipped without Chrome for Testing or Kav
// (kavCheckout in ../fakes.js).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as auth from '../../src/auth.js';
import * as decisions from '../../src/decisions.js';
import { KAV_MIN_VERSION } from '../../src/mcp/flow.js';
import { McpSession } from '../../src/mcp/server.js';
import { startBridge } from '../../src/server.js';
import { kavCheckout, until } from '../fakes.js';
import { findChrome, fixtures, launchChrome } from './cft.js';

const CHROME = findChrome();
const KAV = kavCheckout();
const skip = !CHROME ? 'Chrome for Testing not found' : !fs.existsSync(path.join(KAV, '.venv', 'bin', 'python')) ? `no Kav venv in ${KAV}` : false;

/** @type {Awaited<ReturnType<typeof startBridge>>} */ let bridge;
/** @type {Awaited<ReturnType<typeof launchChrome>>} */ let chrome;
/** @type {Awaited<ReturnType<typeof fixtures>>} */ let site;
/** @type {string} */ let kfwHome;
/** @type {McpSession[]} */ const sessions = [];

/** A hand-written detail_extract flow in the throwaway KFW_HOME. @param {string} name @param {string} url */
function flow(name, url) {
  fs.writeFileSync(path.join(kfwHome, 'recipes', `${name}.json`), JSON.stringify({
    name, type: 'detail_extract', description: 'test rates', domains: ['127.0.0.1'], intents: ['test'],
    url, params: { cur: { description: 'currency', example: 'USD', pattern: '[A-Z]{3}' } },
    rows: { pattern: '\\([A-Z]{3}\\)', min_rows: 1 },
  }));
}

/** @param {string} name @param {string[]} [blocked] */
function session(name, blocked = []) {
  auth.addClient(name);
  auth.updateClient(name, { blockedOrigins: blocked });
  const s = new McpSession({ name, port: bridge.port, record: /** @type {any} */ (auth.clientRecord(name)) });
  sessions.push(s);
  return s;
}

/** @param {any} r */
function parse(r) {
  const text = r.content.map((/** @type {any} */ c) => c.text ?? '').join('\n');
  return { head: JSON.parse(text.split('\n')[0]), text };
}

before(async () => {
  if (skip) return;
  process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-flow-int-'));
  kfwHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-kfw-'));
  fs.mkdirSync(path.join(kfwHome, 'recipes'));
  fs.writeFileSync(path.join(process.env.KBROWSER_HOME, 'config.json'), JSON.stringify({ kav: { dir: KAV, home: kfwHome } }));
  site = await fixtures();
  chrome = await launchChrome({ chrome: /** @type {string} */ (CHROME) });
  bridge = await startBridge({ port: 0, log: () => {} });
  await chrome.pair(/** @type {string} */ (auth.pairKey({ create: true })), bridge.port);
  assert.ok(await until(() => bridge.relay.ext !== null, 15000));
});

after(async () => {
  if (skip) return;
  for (const s of sessions) s.close();
  await bridge?.close();
  await chrome?.close();
  await site?.close();
});

test('a hand-written flow runs as the caller; again with other parameters, with no model call', { skip }, async () => {
  flow('rates', site.url('/rates?cur={cur}'));
  const s = session('codex');
  for (const cur of ['USD', 'JPY']) {
    const r = parse(await s.call('run_flow', { flow: 'rates', params: { cur } }));
    assert.equal(r.head.status, 'done', r.text);
    // the user's Kav checkout moves on: at least the version K-Browser requires
    assert.ok(String(r.head.kav_version).localeCompare(KAV_MIN_VERSION, undefined, { numeric: true }) >= 0, r.head.kav_version);
    assert.equal(r.head.kev?.calls ?? 0, 0, 'no model call');
    assert.ok(r.head.rows_total >= 1);
    assert.match(r.text, new RegExp(`<untrusted-page-content>[\\s\\S]*\\(${cur}\\)`), `rows for ${cur}, as untrusted page content`);
    assert.deepEqual(r.head.tabs, [], 'Kav closed its tab');
  }
});

test('a redirect to a blocked site: Kav is stopped or its answer dropped; the tab is the caller\'s, not another client\'s', { skip }, async () => {
  flow('away', site.url('/to-other'));
  const s = session('claude-code', [`http://localhost:${site.portB}`]);
  const other = session('gemini-cli');
  const r = parse(await s.call('run_flow', { flow: 'away', params: { cur: 'USD' } }));
  assert.equal(r.head.status, 'blocked_origin', r.text);
  assert.equal(r.head.origin, `http://localhost:${site.portB}`);
  assert.ok(!r.text.includes('(EUR)'), 'nothing read on the blocked site comes back');
  const theirs = parse(await other.call('tabs', { action: 'list' }));
  assert.deepEqual(theirs.head.tabs, []);
  for (const t of r.head.tabs ?? []) await s.call('tabs', { action: 'close', tab: t });
});

const kevUp = await fetch('http://127.0.0.1:8009/', { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
const skipKev = skip || (kevUp ? false : 'the local Kev is not running on 127.0.0.1:8009');

/** A steps flow that picks a row of /picks by meaning and opens it. @param {string} name @param {string} want @param {Record<string, any>} [params] */
function pickFlow(name, want, params) {
  fs.writeFileSync(path.join(kfwHome, 'recipes', `${name}.json`), JSON.stringify({
    name, type: 'steps', description: 'test pick', url: site.url('/picks'), ...(params ? { params } : {}),
    steps: [{ pick: { rows: { pattern: 'NT\\$' }, want, click: '查看' } }], result: { expect_text: ['詳情:'] },
  }));
}

/** @param {Record<string, any>} [extra] */
const config = (extra = {}) => fs.writeFileSync(path.join(/** @type {string} */ (process.env.KBROWSER_HOME), 'config.json'),
  JSON.stringify({ kav: { dir: KAV, home: kfwHome }, decisionLog: 'on', ...extra }));

const records = () => fs.readdirSync(decisions.dir()).filter((f) => f.endsWith('.jsonl'))
  .flatMap((f) => fs.readFileSync(path.join(decisions.dir(), f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));

test('the local Kev: a pick by meaning, and a refusal, each a dataset record; an invalid answer from a stand-in Kev too', { skip: skipKev }, async () => {
  config();
  const s = session('pick-client');
  pickFlow('refund', '我要申請退款');
  const ok = parse(await s.call('run_flow', { flow: 'refund' }));
  assert.equal(ok.head.status, 'done', ok.text);
  assert.ok(ok.head.kev.calls >= 1, 'Kev was asked');
  const got = records().filter((x) => x.run_id === ok.head.decisions.run_id);
  assert.equal(got.length, ok.head.decisions.recorded);
  const d = got.find((x) => x.answer.chosen);
  assert.ok(d, JSON.stringify(got));
  assert.equal(d.question.options.find((/** @type {any} */ o) => o.id === d.answer.chosen)?.text.includes('退費申請表'), true);
  assert.deepEqual([d.delivered?.verify?.ok, d.task.status, d.confirmed, d.source.site_origin], [true, 'done', null, new URL(site.url('/')).origin]);

  pickFlow('pizza', '我要訂一個披薩');
  const no = parse(await s.call('run_flow', { flow: 'pizza' }));
  assert.equal(no.head.status, 'needs_help', no.text);
  const r = records().find((x) => x.run_id === no.head.decisions.run_id);
  assert.ok(r && r.answer.chosen === null && r.answer.refusal, JSON.stringify(r));

  // a backend that answers out of range: Kav (C9) refuses, nothing is clicked, the record says why. It also echoes the
  // question back as its model name and version
  const bad = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const qs = JSON.parse(body).questions;
      const echo = String(Object.values(qs)[0]?.instructions ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ model: echo, model_version: echo, answers: Object.fromEntries(Object.keys(qs).map((k) => [k, { noul: 1.5 }])), usage: {} }));
    });
  });
  await new Promise((resolve) => bad.listen(0, '127.0.0.1', () => resolve(undefined)));
  config({ model: { url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (bad.address()).port}` } });
  try {
    const inv = parse(await s.call('run_flow', { flow: 'refund' }));
    assert.deepEqual([inv.head.status, inv.head.reason], ['needs_help', 'model_answer_invalid'], inv.text);
    const v = records().find((x) => x.run_id === inv.head.decisions.run_id);
    assert.ok(v && v.answer.chosen === null && v.answer.validation?.ok === false, JSON.stringify(v));
    // with a parameter in the question: nothing of it in the record, though the backend echoed it as its name
    pickFlow('asks', '請處理{request}類的申請', { request: { description: 'what', example: '退款', pattern: '.+' } });
    const p = parse(await s.call('run_flow', { flow: 'asks', params: { request: 'PRIVATE_METADATA_REQUEST' } }));
    assert.equal(p.head.reason, 'model_answer_invalid', p.text);
    const pr = records().filter((x) => x.run_id === p.head.decisions.run_id);
    assert.ok(pr.length >= 1 && pr.every((x) => x.source.textless === true && x.versions.model === null));
    assert.ok(!JSON.stringify(pr).includes('PRIVATE_METADATA_REQUEST'), JSON.stringify(pr));
  } finally {
    bad.close();
    config({ decisionLog: 'off' });
  }
});
