// @ts-check
// The model exit: reading the settings strictly, the JEV key, consent, site restrictions,
// redaction before anything leaves the machine, and the bridge route (token in the Authorization header only). The
// upstreams (local Kev, JEV) are a fake fetch that records what it was sent; nothing reaches the network.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import * as auth from '../src/auth.js';
import * as model from '../src/model.js';
import { startBridge } from '../src/server.js';

const KEY = 'jev-test-key-0123456789abcdef';
const JEV = 'https://jev.test/v1/systemone';

/** @type {string} */ let home;
const config = (/** @type {unknown} */ c) => fs.writeFileSync(path.join(home, 'config.json'), typeof c === 'string' ? c : JSON.stringify(c));
const consented = (/** @type {Record<string, unknown>} */ more = {}) => ({ model: { backend: 'jev', consent: { at: '2026-10-25T00:00:00Z', version: model.CONSENT_VERSION }, ...more } });

/** A fake upstream: what it was sent, and what it answers. @param {(url: string, init: any) => Response} [answer] */
function upstream(answer = () => Response.json({ answers: { c1: { probs: { yes: 0.9 } } }, model: 'jev-1' })) {
  /** @type {{ url: string, init: any, body: any }[]} */ const sent = [];
  /** @type {typeof globalThis.fetch} */
  const fake = async (url, init) => {
    sent.push({ url: String(url), init, body: JSON.parse(String(init?.body)) });
    return answer(String(url), init);
  };
  return { fetch: fake, sent };
}

const body = (/** @type {Record<string, unknown>} */ extra = {}) => JSON.stringify({ model: 'kev-latest', state: { page: '電話 0912345678' },
  questions: { c1: { type: 'noul', instructions: '使用者要找的是「便當」。這個項目「排骨便當」是不是?' } }, ...extra });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-model-'));
  process.env.KBROWSER_HOME = home;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

test('settings: no file is the local Kev; an unreadable, broken or unknown setting is an error, not a fallback', () => {
  assert.deepEqual(model.readModel(), { ok: true, backend: 'kev', kevUrl: model.DEFAULT_KEV, jevModel: 'jev-latest', consent: null });
  config({ model: { url: 'http://127.0.0.1:9000/' } });
  assert.equal(/** @type {any} */ (model.readModel()).kevUrl, 'http://127.0.0.1:9000', 'the old model.url, local: Kev');
  config({ model: { url: 'https://api.typesafe.ai' } });
  assert.equal(/** @type {any} */ (model.readModel()).backend, 'legacy_cloud', 'the old model.url, not local: nobody agreed to it');
  for (const bad of ['{', '[]', { model: [] }, { model: { backend: 'cloud' } }, { model: { backend: 'kev', kev: { url: 'https://x.example' } } },
    { model: { backend: 'jev', jev: { model: 'a b' } } }, { model: { backend: 'jev', consent: 'yes' } }, { model: null }, { model: { backend: null } }]) {
    config(bad);
    assert.equal(model.readModel().ok, false, JSON.stringify(bad));
  }
  fs.rmSync(path.join(home, 'config.json'));
  fs.symlinkSync(path.join(home, 'gone.json'), path.join(home, 'config.json'));
  assert.equal(model.readModel().ok, false, 'a link to a missing file is broken, not "not set up"');
  fs.rmSync(path.join(home, 'config.json'));
  config({});
  fs.chmodSync(path.join(home, 'config.json'), 0o000);
  if (process.getuid?.() !== 0) assert.equal(model.readModel().ok, false, 'unreadable');
});

test('the key: only usable keys are kept, never shown; .env values in their usual spellings', () => {
  assert.throws(() => model.saveJevKey('short'), (e) => /shorter/.test(String(e)) && !String(e).includes('short\''));
  assert.throws(() => model.saveJevKey('has space inside'), /spaces/);
  model.saveJevKey(KEY);
  assert.equal(model.jevKey(), KEY);
  assert.equal(fs.statSync(model.keyFile()).mode & 0o777, 0o600);
  model.forgetJevKey();
  assert.equal(model.jevKey(), null);
  assert.equal(model.envValue(`A=1\nTYPESAFE_AI = ${KEY}`, 'TYPESAFE_AI'), KEY, 'spaces around =, no final newline');
  assert.equal(model.envValue(`export TYPESAFE_AI="${KEY}"\n`, 'TYPESAFE_AI'), KEY);
  assert.equal(model.envValue(`TYPESAFE_AI='${KEY}' # mine\n`, 'TYPESAFE_AI'), KEY);
  assert.equal(model.envValue(`TYPESAFE_AI=${KEY} # mine\n`, 'TYPESAFE_AI'), KEY);
  assert.equal(model.envValue('# TYPESAFE_AI=x\n', 'TYPESAFE_AI'), null);
});

test('choosing (terminal and side panel share it): leaving JEV withdraws the agreement; the panel view never carries the key', () => {
  config({ decisionLog: 'on', model: { kev: { url: 'http://127.0.0.1:8100' }, url: 'http://127.0.0.1:1' } });
  model.choose('jev');
  let c = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(c.decisionLog, 'on', 'the rest of the file is kept');
  assert.equal(c.model.backend, 'jev');
  assert.equal(c.model.consent.version, model.CONSENT_VERSION);
  assert.equal(c.model.url, undefined, 'the old model.url goes');
  assert.equal(c.model.kev.url, 'http://127.0.0.1:8100');
  model.choose('off');
  c = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.deepEqual([c.model.backend, c.model.consent], ['off', undefined]);
  assert.throws(() => model.choose('kev', { kevUrl: 'https://kev.example' }), /on this machine/);
  assert.throws(() => model.choose(/** @type {any} */ ('cloud')), /kev, off or jev/);

  auth.addClient('open');
  auth.addClient('shy');
  const shy = path.join(home, 'clients', 'shy.json');
  fs.writeFileSync(shy, JSON.stringify({ ...JSON.parse(fs.readFileSync(shy, 'utf8')), blockedOrigins: ['https://bank.example'] }));
  let v = model.panelView();
  assert.deepEqual([v.backend, v.keySet, v.consentVersion, v.limited], ['off', false, model.CONSENT_VERSION, ['shy']]);
  assert.deepEqual(v.consentText, model.CONSENT_TEXT);
  model.saveJevKey(KEY);
  v = model.panelView();
  assert.equal(v.keySet, true);
  assert.equal(JSON.stringify(v).includes(KEY), false, 'never the key');
});

test('kev: the body goes to the local Kev as it came; off and an old cloud model.url send nothing', async () => {
  const up = upstream();
  let r = await model.forward({ record: {}, raw: body(), fetch: up.fetch });
  assert.equal(r.status, 200);
  assert.equal(up.sent[0].url, `${model.DEFAULT_KEV}/v1/systemone`);
  assert.equal(up.sent[0].body.state.page, '電話 0912345678', 'the local Kev gets the page as it is');
  assert.equal(up.sent[0].init.headers.Authorization, undefined);

  config({ model: { backend: 'off' } });
  r = await model.forward({ record: {}, raw: body(), fetch: up.fetch });
  assert.deepEqual([r.status, JSON.parse(r.body).error], [409, 'model_off']);
  config({ model: { url: 'https://api.typesafe.ai' } });
  assert.equal(JSON.parse((await model.forward({ record: {}, raw: body(), fetch: up.fetch })).body).error, 'cloud_not_enabled');
  config('{');
  assert.equal(JSON.parse((await model.forward({ record: {}, raw: body(), fetch: up.fetch })).body).error, 'config_unreadable');
  assert.equal(up.sent.length, 1, 'only the first request went anywhere');
});

test('jev: consent of the current version, no site restrictions and a key, or nothing is sent', async () => {
  const up = upstream();
  const ask = (/** @type {Record<string, any> | null} */ record = {}) => model.forward({ record, raw: body(), fetch: up.fetch, jevUrl: JEV });
  config({ model: { backend: 'jev' } });
  assert.equal(JSON.parse((await ask()).body).error, 'cloud_not_enabled', 'no consent');
  config({ model: { backend: 'jev', consent: { at: 'x', version: model.CONSENT_VERSION - 1 } } });
  assert.equal(JSON.parse((await ask()).body).error, 'cloud_not_enabled', 'an older consent');
  config(consented());
  assert.equal(JSON.parse((await ask()).body).error, 'jev_key_missing');
  model.saveJevKey(KEY);
  assert.equal(JSON.parse((await ask({ blockedOrigins: ['https://bank.example'] })).body).error, 'jev_policy_restricted');
  assert.equal(JSON.parse((await ask({ allowedOrigins: [] })).body).error, 'jev_policy_restricted');
  assert.equal(JSON.parse((await ask(null)).body).error, 'jev_policy_restricted', 'an unknown client');
  for (const bad of [{ blockedOrigins: 'https://bank.example' }, { blockedOrigins: null }, { blockedOrigins: {} }, { allowedOrigins: null }]) {
    assert.equal(JSON.parse((await ask(bad)).body).error, 'jev_policy_restricted', `a malformed policy is a restriction: ${JSON.stringify(bad)}`);
  }
  assert.equal(up.sent.length, 0);

  const r = await ask({ blockedOrigins: [] });
  assert.equal(r.status, 200);
  assert.equal(up.sent[0].url, JEV);
  assert.equal(up.sent[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(up.sent[0].init.redirect, 'error');
  assert.equal(up.sent[0].body.model, 'jev-latest');
  assert.ok(!JSON.stringify(up.sent[0].body).includes('0912345678'), JSON.stringify(up.sent[0].body));
  assert.ok(up.sent[0].body.questions.c1.instructions.includes('排骨便當'), 'ordinary text stays');

  config({ model: { backend: 'kev' } });
  await ask({});
  assert.equal(up.sent[1].url, `${model.DEFAULT_KEV}/v1/systemone`, 'switching back takes effect on the next request');
});

test('jev: client tokens and the key are redacted out of what is sent; a key the redaction would change refuses the request', async () => {
  const tok = auth.addClient('kav');
  model.saveJevKey(KEY);
  config(consented());
  const up = upstream();
  await model.forward({ record: {}, raw: body({ state: { note: `token ${tok} and ${KEY}` } }), fetch: up.fetch, jevUrl: JEV });
  const sent = JSON.stringify(up.sent[0].body);
  assert.ok(!sent.includes(tok) && !sent.includes(KEY), sent);

  const r = await model.forward({ record: {}, raw: body({ questions: { [`手機 0912345678`]: { type: 'noul', instructions: 'x' } } }), fetch: up.fetch, jevUrl: JEV });
  assert.deepEqual([r.status, JSON.parse(r.body).error], [400, 'bad_request']);
  assert.equal(up.sent.length, 1);
});

test('answers: a credential echoed back is taken out; errors, timeouts and oversized answers carry no upstream text', async () => {
  const tok = auth.addClient('kav');
  model.saveJevKey(KEY);
  config(consented());
  let r = await model.forward({ record: {}, raw: body(), jevUrl: JEV, fetch: upstream(() => Response.json({ answers: {}, model: `x ${KEY} ${tok}` })).fetch });
  assert.ok(!r.body.includes(KEY) && !r.body.includes(tok), r.body);
  const escaped = KEY.split('').map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  r = await model.forward({ record: {}, raw: body(), jevUrl: JEV, fetch: upstream(() => new Response(`{"answers":{},"model":"${escaped}"}`)).fetch });
  assert.ok(!JSON.stringify(JSON.parse(r.body)).includes(KEY), 'a key written as JSON escapes is still found');
  assert.equal(model.withoutSecrets('{"a": "x\\"y"}', ['x"y']), '{"a":"[redacted:key]"}', 'a key with a quote');
  assert.equal(model.withoutSecrets('{"a": 1}', [KEY]), '{"a": 1}', 'an answer without a secret goes back byte for byte');
  r = await model.forward({ record: {}, raw: body(), jevUrl: JEV, fetch: upstream(() => new Response(`bad key ${KEY}`, { status: 502 })).fetch });
  assert.deepEqual([r.status, JSON.parse(r.body).error], [502, 'model_unavailable']);
  assert.ok(!r.body.includes(KEY));
  r = await model.forward({ record: {}, raw: body(), jevUrl: JEV, fetch: async () => { throw new TypeError(`fetch failed ${KEY}`); } });
  assert.deepEqual([r.status, JSON.parse(r.body).error], [502, 'model_unavailable']);
  assert.ok(!r.body.includes(KEY));
  r = await model.forward({ record: {}, raw: body(), jevUrl: JEV, fetch: upstream(() => new Response('x'.repeat(model.MAX_BODY + 1))).fetch });
  assert.equal(r.outcome, 'too_big');
  const broken = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"answers"')); c.error(new Error(`reset ${KEY}`)); } });
  r = await model.forward({ record: {}, raw: body(), jevUrl: JEV, fetch: upstream(() => new Response(broken)).fetch });
  assert.deepEqual([r.status, JSON.parse(r.body).error], [502, 'model_unavailable'], 'an answer that breaks off');
  assert.ok(!r.body.includes(KEY));
});

test('the bridge route: the token only as a Bearer (not in the URL, not from a web page); the activity record names where it went', async () => {
  const tok = auth.addClient('kav');
  const up = upstream();
  const bridge = await startBridge({ port: 0, log: () => {}, modelOpts: { fetch: up.fetch } });
  try {
    const url = `http://127.0.0.1:${bridge.port}/model/v1/systemone`;
    const post = (/** @type {Record<string, string>} */ headers, u = url) => fetch(u, { method: 'POST', headers, body: body() });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ Authorization: 'Bearer nope' })).status, 401);
    assert.equal((await post({ Authorization: `Bearer ${tok}`, Origin: 'https://evil.example' })).status, 401, 'a web page');
    assert.equal((await post({}, `http://127.0.0.1:${bridge.port}/model/${tok}/v1/systemone`)).status, 404, 'a token in the URL');
    const ok = await post({ Authorization: `Bearer ${tok}` });
    assert.equal(ok.status, 200);
    assert.equal(up.sent.length, 1);
    const big = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: 'x'.repeat(model.MAX_BODY + 1) }).catch(() => null);
    if (big) assert.equal(big.status, 413);
    config({ model: { backend: 'off' } });
    const off = await post({ Authorization: `Bearer ${tok}` });
    assert.equal(off.status, 409);
    const rec = JSON.stringify(bridge.relay.activity);
    assert.ok(!rec.includes(tok));
  } finally {
    await bridge.close();
  }
});

test('the bridge route: a client removed and made again under the same name while the body comes in is refused, not given the new policy', async () => {
  const tok = auth.addClient('kav');
  auth.updateClient('kav', { blockedOrigins: ['https://bank.example'] });
  model.saveJevKey(KEY);
  config(consented());
  const up = upstream();
  const bridge = await startBridge({ port: 0, log: () => {}, modelOpts: { fetch: up.fetch, jevUrl: JEV } });
  try {
    const http = await import('node:http');
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: bridge.port, path: '/model/v1/systemone', method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      const raw = body();
      req.write(raw.slice(0, 10));
      setTimeout(() => {
        auth.removeClient('kav');
        auth.addClient('kav'); // no site policy: JEV would be allowed for it
        req.end(raw.slice(10));
      }, 100);
    });
    assert.equal(status, 401);
    assert.equal(up.sent.length, 0, 'nothing reached JEV');
  } finally {
    await bridge.close();
  }
});
