// @ts-check
// The decision dataset through run_flow with the fake Kav: off by default, the event file's life
// (0600, read in and deleted however the run ends, a crashed run's file picked up next time), the separate columns, redaction,
// the teacher's answer, keeping period and purge.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as auth from '../src/auth.js';
import * as decisions from '../src/decisions.js';
import { ChildTransport } from '../src/mcp/flow.js';
import { McpSession } from '../src/mcp/server.js';
import { startBridge } from '../src/server.js';
import { FakeExtension, OPEN, until } from './fakes.js';

const FAKE_KAV = fileURLToPath(new URL('./fixtures/fake-kav.js', import.meta.url));
/** @type {Awaited<ReturnType<typeof startBridge>>} */ let bridge;
/** @type {string} */ let kfwHome;
/** @type {McpSession[]} */ const sessions = [];
const home = () => /** @type {string} */ (process.env.KBROWSER_HOME);

/** @param {Record<string, any>} [extra] */
function config(extra = {}) {
  fs.writeFileSync(path.join(home(), 'config.json'), JSON.stringify({ kav: { dir: path.dirname(kfwHome), home: kfwHome }, ...extra }));
}

beforeEach(async () => {
  process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-dec-'));
  kfwHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-kav-')), 'home');
  fs.mkdirSync(path.join(kfwHome, 'recipes'), { recursive: true });
  fs.mkdirSync(path.join(path.dirname(kfwHome), 'recipes'));
  for (const mode of ['decide', 'decide-hang']) {
    fs.writeFileSync(path.join(kfwHome, 'recipes', `${mode}.json`), JSON.stringify({ name: mode, url: 'https://allowed.example/', fake: { mode },
      params: { request: { pattern: '.*' }, flag: { pattern: '.*' } } }));
  }
  config();
  bridge = await startBridge({ port: 0, revokePollMs: 50, log: () => {} });
  const ext = new FakeExtension(bridge.base, /** @type {string} */ (auth.pairKey({ create: true })));
  assert.ok(await ext.connect());
  assert.ok(await until(() => bridge.relay.ext !== null));
});

afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  while (OPEN.length) await /** @type {any} */ (OPEN.pop()).close();
  await bridge.close();
});

function session() {
  auth.addClient('codex');
  const s = new McpSession({ name: 'codex', port: bridge.port, record: /** @type {any} */ (auth.clientRecord('codex')) });
  s.kavTransport = (env, dir) => new ChildTransport(process.execPath, [FAKE_KAV], env, dir);
  sessions.push(s);
  return s;
}

/** @param {any} r */
const head = (r) => JSON.parse(r.content[0].text.split('\n')[0]);
/** Every record in the dataset files. */
const records = () => fs.readdirSync(decisions.dir()).filter((f) => f.endsWith('.jsonl'))
  .flatMap((f) => fs.readFileSync(path.join(decisions.dir(), f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
/** @param {string} name */
const envOf = (name) => JSON.parse(fs.readFileSync(path.join(kfwHome, `${name}.env.json`), 'utf8')).env;

test('off by default: no KFW_DECISIONS for Kav, no directory', async () => {
  const r = head(await session().call('run_flow', { flow: 'decide' }));
  assert.equal(r.status, 'done');
  assert.equal(envOf('decide').KFW_DECISIONS, undefined);
  assert.ok(!fs.existsSync(decisions.dir()));
  assert.equal(r.decisions, undefined);
});

test('on: one record per decision with its columns apart; success, refusal and invalid answer all kept; redacted; event file gone', async () => {
  config({ decisionLog: 'on' });
  const token = auth.addClient('codex');
  const r = head(await session().call('run_flow', { flow: 'decide' }));
  assert.deepEqual(r.decisions.recorded, 3, JSON.stringify(r));
  const file = envOf('decide').KFW_DECISIONS;
  assert.equal(path.dirname(file), path.join(decisions.dir(), 'incoming'));
  assert.ok(!fs.existsSync(file), 'the event file is deleted once read');
  assert.equal(fs.statSync(decisions.dir()).mode & 0o777, 0o700);
  for (const f of fs.readdirSync(decisions.dir()).filter((x) => x.endsWith('.jsonl'))) assert.equal(fs.statSync(path.join(decisions.dir(), f)).mode & 0o777, 0o600);

  const all = records();
  const [d1, d2, d3] = ['d1', 'd2', 'd3'].map((id) => all.find((x) => x.decision_id === id));
  assert.equal(d1.schema, 1);
  assert.equal(d1.run_id, r.decisions.run_id);
  assert.deepEqual([d1.source.params_keys, d1.source.textless], [[], false]);
  assert.equal(d1.question.want, '最便宜的直達車', 'no parameters: the text is kept');
  assert.equal(d1.source.flow, 'decide');
  assert.equal(d1.source.site_origin, 'https://allowed.example');
  assert.equal(d1.versions.redactor, decisions.REDACTOR_VERSION);
  assert.equal(d1.question.type, 'row_match');
  assert.equal(d1.question.options.length, 2);
  const cheap = d1.question.options.find((/** @type {any} */ o) => o.kav_id === 'c1');
  assert.match(cheap.id, /^[0-9a-f]{12}$/, 'a stable id from the text, not Kav\'s c1');
  assert.equal(d1.answer.chosen, cheap.id);
  assert.equal(d1.answer.scores[cheap.id], 0.934512, 'full precision');
  assert.deepEqual(d1.delivered, { verify: { ok: true, why: null }, click: { ok: true } });
  assert.deepEqual(d1.task, { status: 'done', reason: null });
  assert.equal(d1.confirmed, null, 'nobody confirmed it: not gold');
  assert.equal(d1.teacher, null);
  assert.deepEqual(d1.weak, { verify_pick_ok: true }, 'verify_pick passing is only a weak label');
  assert.deepEqual([d2.answer.chosen, d2.answer.refusal, d2.delivered], [null, 'small_gap', null], 'a refusal is kept; no action: delivered unknown');
  assert.deepEqual([d3.question.type, d3.answer.refusal, d3.answer.validation.ok], ['choice', 'model_answer_invalid', false]);
  const text = JSON.stringify(all);
  assert.ok(!text.includes('abcd1234efgh5678') && !text.includes('A123456789') && !text.includes('0912345678'), 'page secrets and personal numbers redacted');
  assert.ok(!text.includes(token));
  // a teacher's answer: a new record pointing at the decision, the original unchanged
  decisions.teach('d2', cheap.id, 'claude');
  const after = records();
  assert.deepEqual(after.find((x) => x.decision_id === 'd2'), d2);
  assert.deepEqual(after.find((x) => x.kind === 'teacher'), { ...after.find((x) => x.kind === 'teacher'), of: 'd2', teacher: { option: cheap.id, source: 'claude' } });
});

test('a run with parameters keeps only closed-format fields: a parameter can show up in any open text, the model name too', async () => {
  config({ decisionLog: 'on' });
  // kev-latest: the fake backend's model name, as if it echoed the question back as its name
  const params = { request: '甲', flag: true, obj: { private: 'LINE\nPRIVATE' }, want: '最便宜的直達車', model: 'kev-latest' };
  const r = head(await session().call('run_flow', { flow: 'decide', params }));
  assert.equal(r.decisions.recorded, 5);
  const all = records().filter((x) => x.run_id === r.decisions.run_id);
  for (const d of all) {
    assert.deepEqual([d.question.want, d.question.field, d.source.site_origin, d.source.textless], [null, null, null, true]);
    if (!d.decision_id.startsWith('n')) assert.deepEqual([d.question.subject, d.question.site], [null, null]);
    assert.equal(d.versions.backend, 'kev', 'the setting during the run');
    assert.ok(d.question.options.every((/** @type {any} */ o) => o.text === null && o.text_hash === null && o.id.startsWith('kav:')));
    assert.deepEqual(d.source.params_keys, ['flag', 'request'], 'only names the flow declares');
    assert.equal(d.versions.model, null);
  }
  const d1 = all.find((x) => x.decision_id === 'd1');
  assert.deepEqual([d1.answer.chosen, d1.answer.scores['kav:c1'], d1.delivered.click.ok], ['kav:c1', 0.934512, true], 'the structure is kept');
  assert.deepEqual(all.find((x) => x.decision_id === 'd3').answer.validation, { ok: false, errors: 1 }, 'messages counted, not kept');
  const text = JSON.stringify(all);
  for (const leak of ['甲', 'True', 'PRIVATE', '最便宜的直達車', '0612', 'allowed.example', 'score out of range', 'kev-latest']) {
    assert.ok(!text.includes(leak), leak);
  }
  assert.deepEqual(all.find((x) => x.decision_id === 'd2').answer.refusal, 'small_gap', 'known codes are kept');
  // noul's fixed question ids are closed too: their scores stay
  const n = all.find((x) => x.decision_id === 'n1');
  assert.deepEqual([n.question.type, n.question.options.map((/** @type {any} */ o) => o.id), n.answer.scores['kav:refurb'], n.answer.chosen],
    ['noul', ['kav:accessory', 'kav:refurb'], 0.91, 'refurbished']);
  // the candidate's rank and the site are closed formats: kept, so kev and jev can be compared item by item; anything else is not
  assert.deepEqual([n.question.subject.id, n.question.subject.text, n.question.site], ['r3', null, 'momo']);
  assert.match(n.question.subject.item, /^[0-9a-f]{16}$/);
  const n2 = all.find((x) => x.decision_id === 'n2');
  assert.deepEqual([n2.question.subject.id, n2.question.site], [null, 'other']);
  assert.notEqual(n2.question.subject.item, n.question.subject.item);
  // the same title in another run is the same item: keyed, the key 0600 outside the dataset directory
  const again = head(await session().call('run_flow', { flow: 'decide', params }));
  const n1b = records().find((x) => x.run_id === again.decisions.run_id && x.decision_id === 'n1');
  assert.equal(n1b.question.subject.item, n.question.subject.item);
  const keyFile = path.join(auth.home(), 'decisions.key');
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(records()).includes(fs.readFileSync(keyFile, 'utf8').trim()), 'the key is never in the dataset');
  assert.deepEqual(fs.readdirSync(auth.home()).filter((f) => f.startsWith('decisions.key.')), [], 'no temporary key file left');
  // a key file that is not a whole key (a writer died midway, an empty file): no item ids rather than ids anyone can recompute
  fs.writeFileSync(keyFile, '', { mode: 0o600 });
  const empty = head(await session().call('run_flow', { flow: 'decide', params }));
  assert.equal(records().find((x) => x.run_id === empty.decisions.run_id && x.decision_id === 'n1').question.subject.item, null);
  decisions.purge();
  assert.ok(!fs.existsSync(keyFile), 'purge deletes the key too');
  config({ decisionLog: 'on' });
  const fresh = head(await session().call('run_flow', { flow: 'decide', params }));
  assert.notEqual(records().find((x) => x.run_id === fresh.decisions.run_id && x.decision_id === 'n1').question.subject.item, n.question.subject.item,
    'another key, other ids: an id depends on the key, not only on the title');
});

test('a run stopped after a decision keeps it; a crashed run\'s stale event file is deleted (its parameters are unknown), a fresh one left alone; old files and purge', async () => {
  config({ decisionLog: 'on' });
  const s = session();
  const ac = new AbortController();
  const running = s.call('run_flow', { flow: 'decide-hang' }, ac.signal);
  assert.ok(await until(() => fs.existsSync(path.join(kfwHome, 'decide-hang.env.json')) && records().length === 0
    && fs.readdirSync(path.join(decisions.dir(), 'incoming')).some((f) => fs.statSync(path.join(decisions.dir(), 'incoming', f)).size > 0), 5000));
  ac.abort();
  const r = head(await running);
  assert.deepEqual([r.status, r.decisions.recorded], ['cancelled', 1]);
  const d1 = records().find((x) => x.decision_id === 'd1');
  assert.deepEqual([d1.delivered, d1.task.status], [null, 'cancelled']);

  // what a crashed K-Browser left behind: deleted, not read in (its parameters are unknown); a fresh file may be another
  // MCP process's run and is left alone
  const left = path.join(decisions.dir(), 'incoming', 'deadbeefdeadbeef.jsonl');
  fs.writeFileSync(left, `${JSON.stringify({ event: 'decision', schema: 1, decision_id: 'z9', type: 'noul', options: [], answer: { chosen: null } })}\n`, { mode: 0o600 });
  decisions.sweep();
  assert.ok(fs.existsSync(left), 'fresh: another run\'s, left alone');
  fs.utimesSync(left, new Date(Date.now() - 20 * 60e3), new Date(Date.now() - 20 * 60e3));
  const old = path.join(decisions.dir(), '250101.jsonl');
  fs.writeFileSync(old, '{}\n', { mode: 0o600 });
  decisions.sweep();
  assert.ok(!fs.existsSync(left) && !records().some((x) => x.decision_id === 'z9'), 'stale: deleted, not read');
  assert.ok(!fs.existsSync(old), 'older than 30 days: deleted');
  decisions.purge();
  assert.ok(!fs.existsSync(decisions.dir()));
});
