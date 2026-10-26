// @ts-check
// The model exit: the one place a decision question leaves this machine.
//
// Kav asks POST /model/v1/systemone on the bridge with its client token as a Bearer; the bridge reads
// ~/.k-browser/config.json on every request and forwards to the local Kev, to TypeSafe's JEV, or refuses:
//   kev  the local Kev (model.kev.url, loopback only), body as sent
//   jev  only with a consent of the current version, a client with no site restrictions and a usable key in
//        ~/.k-browser/jev.key; every string value redacted first, a key the redaction would change refuses the request
//   off  refused (model_off): Kav hands the step back to the agent
// A config that exists but cannot be read or understood forwards nowhere, not even to the local Kev.

import fs from 'node:fs';
import path from 'node:path';
import * as auth from './auth.js';
import { redactor } from './redact.js';

export const CONSENT_VERSION = 1;
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_KEV = 'http://127.0.0.1:8009';
export const DEFAULT_JEV_MODEL = 'jev-latest';
export const LOCAL_MODEL = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/;
export const MAX_BODY = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 60_000;
const MODEL_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const KEY_MIN = 8;

/** What the user agrees to by choosing jev, in Traditional Chinese (the CLI and a Chinese panel) and English (CONSENT_TEXT_EN,
 * an English panel): the same agreement, so changing either means changing both and bumping CONSENT_VERSION. */
export const CONSENT_TEXT = [
  '選雲端 JEV(TypeSafe,api.typesafe.ai)代表同意以下內容:',
  '- 會送出:Kav 需要判斷的那一步的條件、候選選項文字,以及 Kav 放進請求的頁面資訊。',
  '- 送出前經 K-Browser 遮罩(密碼、token、cookie、卡號、手機號碼、身分證號等規則)。遮罩是規則式的,擋不住所有個資。',
  '- 有設網站封鎖或白名單的 client 不能用 JEV:K-Browser 無法證明送出的文字不是來自封鎖網站。沒有限制的 client,送出的文字可能來自任何網站。',
  '- 金鑰只存在 ~/.k-browser/jev.key,只有橋接讀取。',
  '- 隨時可以 `k-browser model kev` 或 `model off` 停用;下一個請求就停止,已送出的那一個收不回。費用由你的 TypeSafe 帳號計算。',
];
export const CONSENT_TEXT_EN = [
  'Choosing the cloud JEV (TypeSafe, api.typesafe.ai) means agreeing to the following:',
  '- What is sent: the conditions of the step Kav needs a judgement on, the text of the candidate options, and the page information Kav puts in the request.',
  '- Before sending, K-Browser masks it (rules for passwords, tokens, cookies, card numbers, phone numbers, ID numbers and the like). Masking is rule-based and cannot catch every piece of personal data.',
  '- Clients with blocked sites or an allow list cannot use JEV: K-Browser cannot prove the text sent did not come from a blocked site. For clients without limits, the text sent may come from any site.',
  '- The key is kept only in ~/.k-browser/jev.key and read only by the bridge.',
  '- You can stop at any time with `k-browser model kev` or `model off`; the next request stops, one already sent cannot be taken back. Costs are billed to your TypeSafe account.',
];

const configFile = () => path.join(auth.home(), 'config.json');
export const keyFile = () => path.join(auth.home(), 'jev.key');

/**
 * The model settings, read strictly: no file is the defaults, anything else that cannot be read or understood is an error.
 * @typedef {{ ok: true, backend: 'kev' | 'jev' | 'off' | 'legacy_cloud', kevUrl: string, jevModel: string,
 *   consent: { at: string, version: number } | null } | { ok: false, reason: 'config_unreadable', message: string }} ModelConfig
 * @returns {ModelConfig}
 */
export function readModel() {
  /** @param {string} message @returns {ModelConfig} */
  const bad = (message) => ({ ok: false, reason: 'config_unreadable', message });
  let text;
  try {
    text = fs.readFileSync(configFile(), 'utf8');
  } catch (e) {
    // only a file that is not there at all is "not set up yet"; a link to a missing file is a broken setting
    if (/** @type {any} */ (e).code === 'ENOENT' && !linkExists(configFile())) {
      return { ok: true, backend: 'kev', kevUrl: DEFAULT_KEV, jevModel: DEFAULT_JEV_MODEL, consent: null };
    }
    return bad(`${configFile()} cannot be read (${/** @type {any} */ (e).code ?? 'error'})`);
  }
  let c;
  try {
    c = JSON.parse(text);
  } catch {
    return bad(`${configFile()} is not valid JSON`);
  }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return bad(`${configFile()} is not a JSON object`);
  const m = c.model === undefined ? {} : c.model; // model: null is a broken setting, not "no setting"
  if (!m || typeof m !== 'object' || Array.isArray(m)) return bad('model: an object');
  const kevUrl = m.kev?.url ?? (m.backend === undefined && typeof m.url === 'string' ? m.url : DEFAULT_KEV);
  let backend = m.backend;
  if (backend === undefined) {
    // before backends existed: a local model.url is Kev, anything else is a cloud nobody has agreed to
    backend = typeof kevUrl === 'string' && LOCAL_MODEL.test(kevUrl) ? 'kev' : 'legacy_cloud';
    if (backend === 'legacy_cloud') return { ok: true, backend, kevUrl: DEFAULT_KEV, jevModel: DEFAULT_JEV_MODEL, consent: null };
  }
  if (!['kev', 'jev', 'off'].includes(backend)) return bad(`model.backend: kev, jev or off, not ${JSON.stringify(backend)}`);
  if (m.kev !== undefined && (!m.kev || typeof m.kev !== 'object')) return bad('model.kev: an object');
  if (typeof kevUrl !== 'string' || !LOCAL_MODEL.test(kevUrl)) return bad('model.kev.url: a URL on this machine (127.0.0.1, localhost or [::1])');
  const jevModel = m.jev?.model ?? DEFAULT_JEV_MODEL;
  if (m.jev !== undefined && (!m.jev || typeof m.jev !== 'object')) return bad('model.jev: an object');
  if (typeof jevModel !== 'string' || !MODEL_NAME.test(jevModel)) return bad('model.jev.model: a model name');
  const consent = m.consent ?? null;
  if (consent !== null && (typeof consent !== 'object' || typeof consent.at !== 'string' || !Number.isInteger(consent.version))) {
    return bad('model.consent: { at, version }');
  }
  return { ok: true, backend, kevUrl: kevUrl.replace(/\/+$/, ''), jevModel, consent };
}

/** Whether something (a dangling link included) is at file. @param {string} file */
function linkExists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Change config.json through fn (the whole object); refuses when the file is there but unreadable, so nothing is lost.
 * @param {(c: Record<string, any>) => void} fn */
export function updateConfig(fn) {
  /** @type {Record<string, any>} */ let c = {};
  try {
    c = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch (e) {
    if (/** @type {any} */ (e).code !== 'ENOENT') throw new Error(`${configFile()} cannot be read or is not valid JSON: fix or remove it first`);
  }
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`${configFile()} is not a JSON object: fix or remove it first`);
  fn(c);
  auth.writePrivate(configFile(), `${JSON.stringify(c, null, 2)}\n`);
}

/** Choose where Kav's decisions go; the terminal (`k-browser model`) and the side panel both come here. Leaving JEV
 * withdraws the agreement (choosing it again asks again); choosing it records an agreement to CONSENT_TEXT as it is now.
 * @param {'kev' | 'off' | 'jev'} backend @param {{ kevUrl?: string }} [opts] */
export function choose(backend, { kevUrl } = {}) {
  if (!['kev', 'off', 'jev'].includes(backend)) throw new Error('kev, off or jev');
  if (kevUrl !== undefined && !LOCAL_MODEL.test(kevUrl)) throw new Error('--url: a URL on this machine (127.0.0.1, localhost or [::1])');
  updateConfig((c) => {
    const m = c.model && typeof c.model === 'object' ? c.model : {};
    delete m.url;
    m.backend = backend;
    if (backend === 'jev') m.consent = { at: new Date().toISOString(), version: CONSENT_VERSION };
    else delete m.consent;
    if (kevUrl !== undefined) m.kev = { ...(m.kev ?? {}), url: kevUrl };
    c.model = m;
  });
}

/** Why a key cannot be used (it could not be masked reliably), or null. Kav's kev_key_invalid rule. @param {string} k */
export function keyProblem(k) {
  if (k.length < KEY_MIN) return `shorter than ${KEY_MIN} characters`;
  if (!/^[\x21-\x7e]+$/.test(k)) return 'contains spaces, control or non-ASCII characters';
  return null;
}

/** The JEV key, or null (none, or not usable). */
export function jevKey() {
  try {
    const k = fs.readFileSync(keyFile(), 'utf8').replace(/\r?\n$/, '');
    return keyProblem(k) ? null : k;
  } catch {
    return null;
  }
}

/** @param {string} k */
export function saveJevKey(k) {
  const why = keyProblem(k);
  if (why) throw new Error(`the key cannot be used: ${why} (the key itself is not shown)`);
  auth.writePrivate(keyFile(), `${k}\n`);
}

export function forgetJevKey() {
  fs.rmSync(keyFile(), { force: true });
}

/** One variable from a .env text: `NAME=value`, `NAME = value`, `export NAME=…`, quotes, comments; null if absent.
 * @param {string} text @param {string} name */
export function envValue(text, name) {
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || m[1] !== name) continue;
    const q = /^(['"])(.*?)\1(?:\s+#.*)?$/.exec(m[2]);
    return q ? q[2] : m[2].replace(/\s+#.*$/, '');
  }
  return null;
}

/** A client whose site policy restricts anything (blocked origins or an allow list) never sends to JEV; a policy field
 * that is there but not an empty list (a malformed one included) counts as a restriction.
 * @param {Record<string, any> | null} record */
export function restricted(record) {
  if (!record) return true;
  const b = record.blockedOrigins;
  return (b !== undefined && !(Array.isArray(b) && b.length === 0)) || record.allowedOrigins !== undefined;
}

/** A refusal: status, and the JSON body Kav turns into its reason. @param {number} status @param {string} error @param {string} message */
const refuse = (status, error, message) => ({ status, body: JSON.stringify({ error, message }), backend: null, outcome: error });

/** Every string value redacted; null when a key would change (it would no longer match what Kav asked about).
 * @param {unknown} v @param {(s: string) => string} text @returns {{ v: unknown } | null} */
function scrubValue(v, text) {
  if (typeof v === 'string') return { v: text(v) };
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v) {
      const r = scrubValue(x, text);
      if (!r) return null;
      out.push(r.v);
    }
    return { v: out };
  }
  if (v && typeof v === 'object') {
    /** @type {Record<string, unknown>} */ const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (text(k) !== k) return null;
      const r = scrubValue(x, text);
      if (!r) return null;
      out[k] = r.v;
    }
    return { v: out };
  }
  return { v };
}

/**
 * Answer one model request from a client.
 * @param {{ record: Record<string, any> | null, raw: string, fetch?: typeof globalThis.fetch, jevUrl?: string }} o
 *   jevUrl: tests only (a fake JEV); the real address is fixed
 * @returns {Promise<{ status: number, body: string, backend: string | null, outcome: string }>}
 */
export async function forward({ record, raw, fetch = globalThis.fetch, jevUrl = JEV_URL }) {
  /** @type {any} */ let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return refuse(400, 'bad_request', 'the body is not JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !body.questions || typeof body.questions !== 'object') {
    return refuse(400, 'bad_request', 'expected { model, state, questions }');
  }
  const cfg = readModel();
  if (!cfg.ok) return refuse(409, cfg.reason, `${cfg.message}; nothing was sent anywhere`);
  if (cfg.backend === 'off') return refuse(409, 'model_off', 'the user turned the model off (`k-browser model off`): hand this decision back to the agent');
  if (cfg.backend === 'legacy_cloud') return refuse(409, 'cloud_not_enabled', 'model.url is not on this machine; choose with `k-browser model kev|jev|off`');

  const tokens = [...auth.clients().values()];
  /** @type {string} */ let url;
  /** @type {Record<string, string>} */ const headers = { 'Content-Type': 'application/json' };
  /** @type {string[]} */ let secrets = tokens;
  let send = raw;
  if (cfg.backend === 'kev') {
    url = `${cfg.kevUrl}/v1/systemone`;
  } else {
    if (cfg.consent?.version !== CONSENT_VERSION) {
      return refuse(409, 'cloud_not_enabled', 'JEV has no consent of the current version: the user runs `k-browser model jev` to see what is sent and agree');
    }
    if (restricted(record)) {
      return refuse(403, 'jev_policy_restricted', 'this client has site restrictions (blocked sites or an allow list), so nothing goes to JEV');
    }
    const key = jevKey();
    if (!key) return refuse(409, 'jev_key_missing', 'no usable JEV key: the user runs `k-browser model jev` to import one');
    secrets = [...tokens, key];
    const r = redactor({ secrets: [auth.pairKey(), ...secrets] });
    const scrubbed = scrubValue(body, r.text);
    if (!scrubbed) return refuse(400, 'bad_request', 'a key in the request would be changed by redaction, so it was not sent');
    send = JSON.stringify({ .../** @type {any} */ (scrubbed.v), model: cfg.jevModel });
    url = jevUrl;
    headers.Authorization = `Bearer ${key}`;
  }

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: send, redirect: 'error', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (e) {
    const why = /** @type {any} */ (e)?.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
    return { status: 502, body: JSON.stringify({ error: 'model_unavailable', message: `the ${cfg.backend} model ${why}` }), backend: cfg.backend, outcome: 'unavailable' };
  }
  let text;
  try {
    text = await readCapped(res);
  } catch {
    return { status: 502, body: JSON.stringify({ error: 'model_unavailable', message: `the ${cfg.backend} model's answer broke off` }), backend: cfg.backend, outcome: 'unavailable' };
  }
  if (text === null) return { status: 502, body: JSON.stringify({ error: 'model_unavailable', message: 'the answer is larger than 1 MB' }), backend: cfg.backend, outcome: 'too_big' };
  if (!res.ok) {
    return { status: 502, body: JSON.stringify({ error: 'model_unavailable', message: `the ${cfg.backend} model answered HTTP ${res.status}` }), backend: cfg.backend, outcome: `http_${res.status}` };
  }
  // the answer goes back as it came (Kav parses it strictly); only a credential echoed by the backend is taken out
  return { status: 200, body: withoutSecrets(text, secrets), backend: cfg.backend, outcome: 'ok' };
}

/** text with every secret taken out. JSON is checked after parsing, since any character of a string can be written as an
 * escape (`\"`, `\u0041`) that a search of the raw text would miss; only an answer that had one is serialized again.
 * @param {string} text @param {string[]} secrets */
export function withoutSecrets(text, secrets) {
  const live = secrets.filter(Boolean);
  const raw = (/** @type {string} */ s) => live.reduce((t, x) => (t.includes(x) ? t.split(x).join('[redacted:key]') : t), s);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return raw(text);
  }
  let hit = false;
  /** @param {unknown} v @returns {unknown} */
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = raw(v);
      if (r !== v) hit = true;
      return r;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      /** @type {Record<string, unknown>} */ const out = {};
      for (const [k, x] of Object.entries(v)) out[/** @type {string} */ (walk(k))] = walk(x);
      return out;
    }
    return v;
  };
  const clean = walk(parsed);
  return hit ? JSON.stringify(clean) : raw(text);
}

/** The response text, or null past MAX_BODY. @param {Response} res */
async function readCapped(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  /** @type {Uint8Array[]} */ const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A short summary for status / doctor: never the key. */
export function summary() {
  const c = readModel();
  if (!c.ok) return { backend: null, problem: c.reason };
  /** @type {Record<string, unknown>} */ const out = { backend: c.backend === 'legacy_cloud' ? 'kev' : c.backend };
  if (c.backend === 'legacy_cloud') out.problem = 'cloud_not_enabled';
  if (c.backend === 'jev') {
    out.consent_at = c.consent?.at ?? null;
    out.key_set = jevKey() !== null;
    if (c.consent?.version !== CONSENT_VERSION) out.problem = 'cloud_not_enabled';
    else if (!out.key_set) out.problem = 'jev_key_missing';
  }
  return out;
}

/** What the side panel shows and needs to switch: the summary, whether a key is there (it is only imported in a
 * terminal), the agreement text and its version (agreeing in the panel sends that version back), and which clients
 * cannot use JEV. Never the key. @returns {Record<string, unknown>} */
export function panelView() {
  return { ...summary(), keySet: jevKey() !== null, consentVersion: CONSENT_VERSION, consentText: CONSENT_TEXT, consentTextEn: CONSENT_TEXT_EN,
    limited: [...auth.clients().keys()].filter((n) => restricted(auth.clientRecord(n))).sort() };
}
