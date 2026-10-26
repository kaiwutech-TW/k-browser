// @ts-check
// The decision dataset: every model decision Kav makes during a run_flow,
// kept on this machine for training a site-specific model later. Off unless ~/.k-browser/config.json says
// "decisionLog": "on".
//
//   ~/.k-browser/decisions/incoming/<run_id>.jsonl   K-Browser creates it (0600) and hands it to Kav as KFW_DECISIONS;
//                                                    Kav appends "decision" / "action" events as they happen
//   ~/.k-browser/decisions/<YYMMDD>.jsonl            after the run: one record per decision, redacted; kept 30 days
//
// A run with parameters keeps only closed-format fields (closedRecord): numbers, booleans, and strings from fixed
// vocabularies (question types, refusal / reason codes, Kav's option ids, version tags), each checked against its
// list; anything else is dropped or becomes "other" — the model's name too. A parameter can show up in any open text
// in any format — Kav's rendering of it, a page echoing a search, a backend echoing the question as its model name —
// and that cannot be verified away. Runs without
// parameters keep their text.
//
// The columns stay apart: what the model answered, whether the action reached its target, how the task ended,
// whether anyone independently confirmed the answer, a teacher's answer. Only `confirmed` and a teacher's answer can
// be gold; Kav's verify_pick passing, a page change or a confident model are not (`weak`). Unknown is null.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './activity.js';
import * as auth from './auth.js';

export const SCHEMA = 1;
export const REDACTOR_VERSION = 'k-browser-redact-4';
const KEEP_DAYS = 30;
// an event file untouched this long belongs to no run any more (the longest run_flow is 600 s)
const STALE_MS = 15 * 60e3;

export const enabled = () => readConfig().decisionLog === 'on';
export const dir = () => path.join(auth.home(), 'decisions');
const incoming = () => path.join(dir(), 'incoming');

/** The key that turns a product title into the same item id in every run: made once, kept outside the
 * dataset directory (~/.k-browser/decisions.key, 0600) so a copied dataset does not carry it; purge deletes it too.
 * Without it an item id cannot be checked against guessed titles (a plain hash could be, like a phone number's). */
const itemKeyFile = () => path.join(auth.home(), 'decisions.key');
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;
/** The key, or null when the file holds anything else (an empty or cut file): then no item ids, never ids from a guessable
 * key. A new key is written whole to a private temporary file and only then published under the name with link(),
 * which fails if another run published first — nobody can read a half-written key. */
function itemKey() {
  const file = itemKeyFile();
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
    try {
      fs.linkSync(tmp, file);
    } catch (e) {
      if (/** @type {any} */ (e)?.code !== 'EEXIST') throw e; // two runs at once: the first one published wins
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  const key = fs.readFileSync(file, 'utf8').trim();
  return KEY_SHAPE.test(key) ? key : null;
}
/** A product's id across runs: its title (the first line Kav gives, without price or other card text), redacted and
 * normalized, keyed. @param {unknown} text @param {Redact} r */
function itemId(text, r) {
  if (typeof text !== 'string') return null;
  const title = r.text(text.split('\n')[0]).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const key = title ? itemKey() : null;
  return key ? createHmac('sha256', key).update(title).digest('hex').slice(0, 16) : null;
}
/** @param {string} s */
const sha = (s) => createHash('sha256').update(s).digest('hex');
/** A stable option id from its text (not Kav's c1, c2: those are per run). @param {string} text */
const optionId = (text) => sha(text).slice(0, 12);

/** @param {string} d */
function mkdirPrivate(d) {
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.chmodSync(d, 0o700);
}

/** An empty event file for one run, 0600, created here before Kav sees its path. @returns {{ runId: string, file: string }} */
export function prepare() {
  mkdirPrivate(dir());
  mkdirPrivate(incoming());
  const runId = randomBytes(8).toString('hex');
  const file = path.join(incoming(), `${runId}.jsonl`);
  fs.writeFileSync(file, '', { mode: 0o600, flag: 'wx' });
  return { runId, file };
}

/** declared: the parameter names the flow file declares. @typedef {{ flow?: string | null, kav_version?: string | null, params?: Record<string, any> | null,
 *   task?: Record<string, any> | null, declared?: string[], backend?: string | null }} RunInfo */

// the closed vocabularies of a parameterized run's record (Kav's kfw/judge.py, steps.py, recipes.py; since Kav 0.0.8 checked
// against its kfw/codes.json by test/decisions-vocab.test.js)
const TYPES = new Set(['row_match', 'choice', 'noul']);
const REFUSALS = new Set(['none_highest', 'low_confidence', 'small_gap', 'model_answer_invalid', 'kev_error', 'invalid_answer', 'ambiguous',
  'too_many_candidates', 'not_found',
  // added from Kav's kfw/codes.json (test/decisions-vocab.test.js keeps them in step)
  'kev_not_local', 'kev_url_has_token', 'model_unavailable', 'number_missing', 'bad_request', 'cloud_not_enabled', 'config_unreadable',
  'jev_key_missing', 'jev_policy_restricted', 'model_off', 'unauthorized']);
// the model setting during the run (run_flow reads it at the start and the end) and Kav's sites (its kfw/sites.py)
const BACKENDS = new Set(['kev', 'jev', 'off', 'changed']);
const SITES = new Set(['pchome', 'momo', 'yahoo', 'coupang']);
const VERDICTS = new Set(['match', 'other_model', 'accessory', 'bundle', 'refurbished', 'instalment', 'model_answer_invalid']);
const WHYS = new Set(['row_gone', 'group_changed', 'generation_changed', 'row_text_changed', 'control_moved', 'control_gone', 'pick_no_control',
  'unsafe_action', 'stateful_not_authorized', 'not_found', 'ambiguous', 'stale', 'kev_error', 'invalid_answer',
  // added from Kav's kfw/codes.json (test/decisions-vocab.test.js keeps them in step)
  'outside_pattern', 'click_failed', 'covered', 'gone', 'kev_not_local', 'kev_url_has_token', 'low_confidence', 'model_answer_invalid',
  'model_unavailable', 'no_rows', 'none_highest', 'not_set', 'number_missing', 'page_empty', 'radio_false', 'small_gap',
  'superlative_unsupported', 'then_not_met', 'then_target_not_unique', 'too_many_candidates', 'wait_timeout']);
const STATUSES = new Set(['done', 'partial', 'needs_help', 'error', 'blocked_origin', 'timeout', 'cancelled', 'kav_unsupported', 'kav_unavailable',
  'recorded_flow', 'cloud_not_enabled', 'busy', 'monitor_lost', 'unknown']);
const REASONS = new Set(['field_not_found', 'field_not_set', 'pre_step_failed', 'submit_not_found', 'step_failed', 'result_not_proven',
  'result_ambiguous', 'next_button_ambiguous', 'end_mismatch', 'pick_no_candidate', 'pick_no_control', 'pick_control_ambiguous', 'pick_uncertain',
  'pick_no_effect', 'pick_stale', 'choice_uncertain', 'model_answer_invalid', 'unsafe_action', 'stateful_not_authorized', 'kev_not_running',
  'kev_key_invalid', 'kev_key_missing', 'browser_unavailable', 'login_required', 'captcha', 'verification', 'access_denied', 'blocked', 'no_results',
  'extraction_failed', 'no_structured_data', 'bad_request', 'isolation_unavailable', 'kav_bad_result', 'unknown_flow', 'bad_flow', 'bad_argument',
  // added from Kav's kfw/codes.json (test/decisions-vocab.test.js keeps them in step)
  'kev_not_local', 'kev_url_has_token', 'loop_detected', 'model_unavailable', 'needs_profile_state', 'no_cards_found',
  'no_listing_matched', 'nothing_verified', 'suspicious_prices', 'then_already_true', 'widget_value_not_replayable', 'cloud_not_enabled',
  'config_unreadable', 'jev_key_missing', 'jev_policy_restricted', 'model_off', 'unauthorized']);
/** For the vocabulary check against Kav's list (test/decisions-vocab.test.js). */
export const VOCAB = { REFUSALS, VERDICTS, WHYS, STATUSES, REASONS, SITES };
const THRESHOLD_KEYS = new Set(['min_p', 'min_gap', 'yes_p']);
/** @param {unknown} v @param {Set<string>} set */
const pick = (v, set) => (typeof v === 'string' ? (set.has(v) ? v : 'other') : null);
/** @param {unknown} v */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** @param {unknown} v */
const bool = (v) => (typeof v === 'boolean' ? v : null);
// noul asks these fixed questions (Kav's kfw/judge.py SEMANTIC)
const NOUL_IDS = new Set(['accessory', 'bundle', 'refurb', 'installment']);
/** Kav's option ids: per run (c1, o2, none) or noul's fixed ones. @param {unknown} v */
const kavId = (v) => (typeof v === 'string' && (/^(?:[co]\d{1,4}|none)$/.test(v) || NOUL_IDS.has(v)) ? v : null);
/** @param {unknown} v @param {RegExp} re */
const shaped = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);

/**
 * A parameterized run's record: built field by field from closed formats only, never by removing text from an open one.
 * @param {any} d the decision event @param {any} a its action event @param {RunInfo} run @param {string} runId @param {Redact} r
 */
function closedRecord(d, a, run, runId, r) {
  const type = pick(d.type, TYPES);
  const ids = (Array.isArray(d.options) ? d.options : []).map((/** @type {any} */ o) => kavId(o?.id));
  const scores = d.answer?.scores && typeof d.answer.scores === 'object'
    ? Object.fromEntries(Object.entries(d.answer.scores).filter(([k]) => kavId(k)).map(([k, v]) => [`kav:${k}`, num(v)]))
    : null;
  const chosenRaw = d.answer?.chosen;
  const chosen = type === 'noul' ? pick(chosenRaw, VERDICTS) : kavId(chosenRaw) ? `kav:${chosenRaw}` : chosenRaw == null ? null : 'other';
  const thresholds = d.thresholds && typeof d.thresholds === 'object'
    ? Object.fromEntries(Object.entries(d.thresholds).filter(([k]) => THRESHOLD_KEYS.has(k)).map(([k, v]) => [k, num(v)]))
    : null;
  const v = d.validation && typeof d.validation === 'object' ? d.validation : null;
  const declared = new Set(run.declared ?? []);
  return {
    schema: SCHEMA, kind: 'decision', decision_id: shaped(d.decision_id, /^[A-Za-z0-9_-]{1,64}$/), run_id: runId,
    at: shaped(d.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/),
    source: { flow: shaped(run.flow, /^[a-z0-9-]{1,64}$/), kav_version: shaped(run.kav_version, /^\d{1,4}\.\d{1,4}\.\d{1,4}$/), site_origin: null,
      params_keys: Object.keys(run.params ?? {}).filter((k) => declared.has(k)).sort(), textless: true },
    versions: { model: null, backend: pick(run.backend, BACKENDS), prompt: shaped(d.prompt_version, /^(?:row_match|choice|noul)-\d{1,4}$/), validator: shaped(d.validator_version, /^c9-\d{1,4}$/),
      redactor: REDACTOR_VERSION },
    // a candidate's rank on the result page (r3) and the site: closed formats, so kev and jev can be compared item by item
    question: { type, step_index: num(d.step_index), want: null, subject: d.subject && typeof d.subject === 'object'
        ? { id: shaped(d.subject.id, /^r\d{1,4}$/), item: itemId(d.subject.text, r), text: null } : null,
      field: null, site: pick(d.site, SITES),
      options: ids.map((/** @type {string | null} */ id) => ({ id: id ? `kav:${id}` : 'other', kav_id: id, text: null, text_hash: null })) },
    answer: { chosen, scores, thresholds, refusal: pick(d.answer?.refusal, REFUSALS),
      validation: v ? { ok: bool(v.ok), errors: Array.isArray(v.errors) ? v.errors.length : null } : null },
    delivered: a ? { verify: a.verify ? { ok: bool(a.verify.ok), why: pick(a.verify.why, WHYS) } : null, click: a.click ? { ok: bool(a.click.ok) } : null,
      ...(a.select ? { select: { ok: bool(a.select.ok) } } : {}) } : null,
    task: run.task ? { status: pick(run.task.status, STATUSES), reason: pick(run.task.reason, REASONS) } : null,
    confirmed: null,
    teacher: null,
    weak: a?.verify?.ok === true ? { verify_pick_ok: true } : null,
  };
}
/** @typedef {{ value: (v: unknown) => any, text: (s: string) => string }} Redact */

/**
 * Read a run's events into dataset records, append them (redacted) to today's file, and delete the event file.
 * Lines that are not JSON objects are skipped and counted. @param {string} file @param {string} runId @param {RunInfo} run @param {Redact} r
 */
export function ingest(file, runId, run, r) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { records: 0, skipped: 0 };
  }
  /** @type {Map<string, any>} */ const decisions = new Map();
  /** @type {Map<string, any>} */ const actions = new Map();
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    /** @type {any} */ let e;
    try {
      e = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (!e || typeof e !== 'object' || typeof e.decision_id !== 'string') { skipped++; continue; }
    if (e.event === 'decision') decisions.set(e.decision_id, e);
    else if (e.event === 'action') actions.set(e.decision_id, e);
    else skipped++;
  }
  const params = run.params && typeof run.params === 'object' ? run.params : null;
  const textless = params !== null && Object.keys(params).length > 0;
  const out = [];
  for (const [id, d] of decisions) {
    if (textless) {
      out.push(closedRecord(d, actions.get(id), run, runId, r));
      continue;
    }
    // ids and hashes from the redacted text: a hash of a phone number could be reversed by trying them all
    const options = (Array.isArray(d.options) ? d.options : []).map((/** @type {any} */ o) => {
      const t = r.text(String(o?.text ?? ''));
      return { id: optionId(t), kav_id: String(o?.id ?? ''), text: t, text_hash: sha(t),
        ...(typeof o?.shown === 'string' ? { shown: r.text(o.shown) } : {}) }; // pick: the text Kev actually saw
    });
    const byKav = new Map(options.map((/** @type {any} */ o) => [o.kav_id, o.id]));
    const scores = d.answer?.scores && typeof d.answer.scores === 'object'
      ? Object.fromEntries(Object.entries(d.answer.scores).map(([k, v]) => [byKav.get(k) ?? `kav:${k}`, typeof v === 'number' ? v : null]))
      : null;
    const chosen = typeof d.answer?.chosen === 'string' ? byKav.get(d.answer.chosen) ?? `kav:${d.answer.chosen}` : null;
    const a = actions.get(id);
    out.push({
      schema: SCHEMA, kind: 'decision', decision_id: id, run_id: runId, at: typeof d.ts === 'string' ? d.ts : null,
      source: { flow: run.flow ?? null, kav_version: run.kav_version ?? null, site_origin: typeof d.page_origin === 'string' ? d.page_origin : null,
        params_keys: [], textless: false },
      versions: { model: d.model ?? null, backend: pick(run.backend, BACKENDS), prompt: d.prompt_version ?? null, validator: d.validator_version ?? null, redactor: REDACTOR_VERSION },
      // noul asks fixed questions about one subject (a product); choice names the form field; noul the site
      question: { type: d.type ?? null, step_index: typeof d.step_index === 'number' ? d.step_index : null, want: typeof d.want === 'string' ? d.want : null,
        subject: d.subject && typeof d.subject === 'object' ? { ...d.subject, item: itemId(d.subject.text, r) } : d.subject ?? null, field: d.field ?? null, site: d.site ?? null, options },
      answer: { chosen, scores, thresholds: d.thresholds ?? null, refusal: typeof d.answer?.refusal === 'string' && /^[a-z_]{1,40}$/.test(d.answer.refusal) ? d.answer.refusal : null,
        validation: d.validation ?? null },
      delivered: a ? { verify: a.verify ?? null, click: a.click ?? null } : null,
      task: run.task ?? null,
      confirmed: null,
      teacher: null,
      weak: a?.verify?.ok === true ? { verify_pick_ok: true } : null,
    });
  }
  if (out.length) append(out.map((x) => r.value(x)));
  fs.rmSync(file, { force: true });
  return { records: out.length, skipped };
}

/** @param {any[]} records */
function append(records) {
  mkdirPrivate(dir());
  const now = new Date(); // this machine's date, like the activity log
  const day = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const f = path.join(dir(), `${day}.jsonl`);
  fs.appendFileSync(f, records.map((x) => `${JSON.stringify(x)}\n`).join(''), { mode: 0o600 });
  fs.chmodSync(f, 0o600);
}

/**
 * Before a run: event files a crashed run left behind are deleted, not read in — its parameters are not known, so their
 * values could not be taken out — but only once untouched for STALE_MS: a newer one may be another
 * run's, in another MCP process. Files older than the keeping period are deleted.
 */
export function sweep() {
  if (!fs.existsSync(dir())) return;
  if (fs.existsSync(incoming())) {
    for (const f of fs.readdirSync(incoming())) {
      const file = path.join(incoming(), f);
      const st = fs.statSync(file, { throwIfNoEntry: false });
      if (st && Date.now() - st.mtimeMs > STALE_MS) fs.rmSync(file, { force: true });
    }
  }
  const cutoff = Date.now() - KEEP_DAYS * 86400e3;
  for (const f of fs.readdirSync(dir())) {
    const m = /^(\d{2})(\d{2})(\d{2})\.jsonl$/.exec(f);
    if (m && Date.parse(`20${m[1]}-${m[2]}-${m[3]}T23:59:59`) < cutoff) fs.rmSync(path.join(dir(), f), { force: true });
  }
}

/** A teacher's answer to a decision: a new record pointing at it (the original is never changed). @param {string} decisionId @param {string} option @param {'claude' | 'human'} source */
export function teach(decisionId, option, source) {
  if (!/^[\w-]{1,64}$/.test(decisionId) || !/^[\w:-]{1,64}$/.test(option)) throw new Error('decision and option ids are word characters');
  append([{ schema: SCHEMA, kind: 'teacher', of: decisionId, at: new Date().toISOString(), teacher: { option, source } }]);
}

/** Delete the whole dataset. */
export function purge() {
  fs.rmSync(dir(), { recursive: true, force: true });
  fs.rmSync(itemKeyFile(), { force: true }); // new ids from here on: nothing left to compare them with
}
