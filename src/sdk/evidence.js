// @ts-check
// The evidence contract: "done" is decided by assertions the task names, checked
// against the bridge's observation log (KBrowser.queryNetwork) and the page, never by the agent saying so.
//
// Four levels, reported separately: input_delivered -> screen_changed -> site_replied (HTTP) -> business_confirmed.
//   url, text   screen_changed at most: the page controls its DOM and URL
//   network     site_replied at most: an old order, an error JSON, another request or a service worker can all match
//   business    the only way to business_confirmed: a success condition, data that matches this operation, the
//               source request and its known limits, all stated by the caller
//   quiet       a helper; it never completes anything on its own
// Bodies are read from the bridge's own copy of the Network.getResponseBody reply: the SDK asks Chrome for the body
// (so the bridge sees the reply), then reads what the bridge kept. Text the SDK got itself is never evidence.
// judgedBy is always "sdk": nothing here is verified by the bridge (there is no bridge-side judging); the record ids
// let anyone re-check with KBrowser.queryNetwork.

import { globMatcher } from '../observe.js';
import { SdkError } from './cdp.js';

/** @typedef {'input_delivered' | 'screen_changed' | 'site_replied' | 'business_confirmed'} Level */
/** @typedef {'proven' | 'not_proven' | 'unobservable'} Status */
/**
 * @typedef {{ kind: 'url', glob: string }
 *   | { kind: 'text', includes: string, ref?: string }
 *   | { kind: 'network', urlGlob: string, method?: string, status?: number | [number, number], bodyIncludes?: string }
 *   | { kind: 'business', urlGlob: string, method?: string, success: { path: string, equals: unknown }, match: Record<string, unknown>, limits: string }
 *   | { kind: 'quiet', ms: number }} Assertion
 */
/** @typedef {{ kind: string, status: Status, level: Level | null, evidence?: Record<string, any>, note?: string }} Result */

const OK_STATUS = /** @type {[number, number]} */ ([200, 299]);
const NEEDS_MARK = new Set(['network', 'business', 'quiet']);

/** @param {Assertion} a */
function validate(a) {
  const bad = (/** @type {string} */ why) => { throw new SdkError('bad_argument', `wait_for ${a?.kind ?? '?'}: ${why}`); };
  if (!a || typeof a !== 'object') bad('each assertion must be an object');
  switch (a.kind) {
    case 'url': if (typeof a.glob !== 'string') bad('needs glob'); break;
    case 'text': if (typeof a.includes !== 'string' || !a.includes) bad('needs includes'); break;
    case 'network': if (typeof a.urlGlob !== 'string') bad('needs urlGlob'); break;
    case 'business':
      if (typeof a.urlGlob !== 'string') bad('needs urlGlob (the source request)');
      if (!a.success || typeof a.success.path !== 'string' || !('equals' in a.success)) bad('needs success: { path, equals }');
      if (!a.match || typeof a.match !== 'object' || !Object.keys(a.match).length) bad('needs match: the fields that must equal this operation\'s input');
      if (typeof a.limits !== 'string' || !a.limits.trim()) bad('needs limits: what this evidence cannot show');
      break;
    case 'quiet': if (!Number.isFinite(a.ms) || a.ms < 0) bad('needs ms'); break;
    default: bad('kind must be url, text, network, business or quiet');
  }
}

/** A dotted path into parsed JSON ("data.order.status", "items.0.id"). @param {any} v @param {string} path */
function at(v, path) {
  for (const k of path.split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = v[k];
  }
  return v;
}

/** @param {{ text: string, base64Encoded: boolean }} b */
const bodyText = (b) => (b.base64Encoded ? Buffer.from(b.text, 'base64').toString('utf8') : b.text);

/**
 * Check assertions until each is proven or found unobservable, or the time is up.
 * `admit`: which network records the caller lets count at all (a site policy, src/mcp/): the others are neither
 * evidence nor quoted in notes.
 * @param {import('./index.js').Tab} tab @param {Assertion[]} assertions
 * @param {{ sinceActionId?: string, timeoutMs?: number, pollMs?: number, admit?: (entries: any[]) => Promise<any[]> }} [o]
 */
export async function waitFor(tab, assertions, { sinceActionId, timeoutMs = 10_000, pollMs = 200, admit = async (e) => e } = {}) {
  if (!Array.isArray(assertions)) throw new SdkError('bad_argument', 'wait_for takes a list of assertions');
  for (const a of assertions) {
    validate(a);
    if (NEEDS_MARK.has(a.kind) && !sinceActionId) throw new SdkError('bad_argument', `wait_for ${a.kind}: needs sinceActionId (a mark taken before the action)`);
  }
  if (!assertions.length) return { completed: false, verdict: 'unverified', level: null, judgedBy: 'sdk', results: /** @type {Result[]} */ ([]), note: 'no assertions: nothing was checked' };

  const kb = (/** @type {string} */ method, /** @type {Record<string, any>} */ params) => tab.client.call(method, { targetId: tab.targetId, ...params });
  /** The same entries with the bodies the bridge kept: Chrome is asked for any it has not seen yet (its reply goes
   * into the bridge's log; the SDK ignores what it gets back), then the bridge's copies are read.
   * @param {any[]} entries @param {Record<string, any>} q */
  const withBodies = async (entries, q) => {
    for (const e of entries) {
      if (!e.body) await tab.client.call('Network.getResponseBody', { requestId: e.requestId }, e.child ?? tab.sessionId).catch(() => {});
    }
    const ids = new Set(entries.map((e) => e.id));
    const r = await kb('KBrowser.queryNetwork', { ...q, includeBody: true });
    // the window may have stopped being observable meanwhile: that answer counts, not the earlier one
    return { ...r, entries: r.entries.filter((/** @type {any} */ e) => ids.has(e.id)) };
  };

  /** @param {Assertion} a @returns {Promise<Result>} */
  const check = async (a) => {
    switch (a.kind) {
      case 'url': {
        const nav = await kb('KBrowser.getNavigation', {});
        return globMatcher(a.glob)(nav.url)
          ? { kind: 'url', status: 'proven', level: 'screen_changed', evidence: { url: nav.url, source: 'bridge navigation log' } }
          : { kind: 'url', status: 'not_proven', level: null, note: `the URL is ${nav.url}` };
      }
      case 'text': {
        const r = await tab.read(a.ref).catch((e) => ({ text: '', error: e instanceof Error ? e.message : String(e) }));
        return r.text.includes(a.includes)
          ? { kind: 'text', status: 'proven', level: 'screen_changed', evidence: { ref: a.ref ?? null, source: 'isolated-world read (page-controlled)' } }
          : { kind: 'text', status: 'not_proven', level: null, note: 'error' in r ? String(r.error) : 'text not found' };
      }
      case 'network':
      case 'business': {
        const q = { sinceActionId, urlGlob: a.urlGlob, ...(a.method ? { method: a.method } : {}), status: a.kind === 'network' ? a.status ?? OK_STATUS : OK_STATUS, limit: 200 };
        const r = await kb('KBrowser.queryNetwork', q);
        if (r.unobservable) return { kind: a.kind, status: 'unobservable', level: null, note: r.why.join('; ') };
        let done = (await admit(r.entries)).filter((/** @type {any} */ e) => e.finished && !e.failed && !e.redirectedTo);
        const partial = r.partial ? 'some cross-site frames were not observed (no Network.enable on their sessions)' : undefined;
        if (!done.length) return { kind: a.kind, status: 'not_proven', level: null, note: partial ?? 'no matching response after the mark' };
        const source = (/** @type {any} */ e) => ({ recordId: e.id, url: e.url, method: e.method, status: e.status, fromServiceWorker: e.fromServiceWorker, fromCache: e.fromCache });
        if (a.kind === 'network' && a.bodyIncludes === undefined) {
          const e = done[done.length - 1];
          return { kind: 'network', status: 'proven', level: 'site_replied', evidence: source(e), note: e.fromServiceWorker ? 'answered by a service worker' : partial };
        }
        const again = await withBodies(done, q);
        if (again.unobservable) return { kind: a.kind, status: 'unobservable', level: null, note: again.why.join('; ') };
        done = again.entries;
        /** @type {string[]} */ const seen = [];
        for (const e of [...done].reverse()) {
          if (typeof e.body?.text !== 'string') continue;
          const text = bodyText(e.body);
          if (a.kind === 'network') {
            if (a.bodyIncludes !== undefined && text.includes(a.bodyIncludes)) return { kind: 'network', status: 'proven', level: 'site_replied', evidence: { ...source(e), bodyIncludes: a.bodyIncludes } };
            continue;
          }
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            seen.push(`${e.id}: not JSON`);
            continue;
          }
          if (at(json, a.success.path) !== a.success.equals) { seen.push(`${e.id}: ${a.success.path} is ${JSON.stringify(at(json, a.success.path))}`); continue; }
          const off = Object.entries(a.match).filter(([p, v]) => at(json, p) !== v);
          if (off.length) { seen.push(`${e.id}: ${off.map(([p]) => `${p} is ${JSON.stringify(at(json, p))}`).join(', ')}`); continue; }
          return { kind: 'business', status: 'proven', level: 'business_confirmed',
            evidence: { ...source(e), success: a.success, matched: a.match, limits: a.limits }, note: e.fromServiceWorker ? 'answered by a service worker' : partial };
        }
        return { kind: a.kind, status: 'not_proven', level: null, note: seen.length ? `responses after the mark did not match this operation: ${seen.join('; ').slice(0, 500)}` : 'no body to check' };
      }
      case 'quiet': {
        const r = await kb('KBrowser.queryNetwork', { sinceActionId, limit: 200 });
        if (r.unobservable) return { kind: 'quiet', status: 'unobservable', level: null, note: r.why.join('; ') };
        // quiet is a claim about absence: a frame whose requests may be missing makes it unknowable
        if (r.partial) return { kind: 'quiet', status: 'unobservable', level: null, note: 'some cross-site frames were not observed all along' };
        if (typeof r.markT !== 'number') return { kind: 'quiet', status: 'not_proven', level: null, note: 'the bridge did not say when the mark was taken' };
        const busy = r.entries.some((/** @type {any} */ e) => !e.finished);
        // quiet since the mark at the earliest: no entries does not mean quiet since forever
        const last = Math.max(r.markT, ...r.entries.map((/** @type {any} */ e) => e.endedAt ?? e.t));
        return !busy && Date.now() - last >= a.ms
          ? { kind: 'quiet', status: 'proven', level: null, note: 'a helper only: quiet alone completes nothing' }
          : { kind: 'quiet', status: 'not_proven', level: null, note: busy ? 'requests still in flight' : 'recent network activity' };
      }
      default:
        throw new SdkError('bad_argument', 'unknown assertion');
    }
  };

  const end = Date.now() + timeoutMs;
  /** @type {(Result | null)[]} */ const final = assertions.map(() => null);
  /** @type {Result[]} */ let last = [];
  for (;;) {
    last = await Promise.all(assertions.map((a, i) => final[i] ?? check(a)));
    last.forEach((r, i) => { if (r.status !== 'not_proven') final[i] = r; });
    if (final.every((r) => r !== null) || Date.now() >= end) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const results = last;
  const anyUnobservable = results.some((r) => r.status === 'unobservable');
  const allProven = results.every((r) => r.status === 'proven');
  const onlyQuiet = results.every((r) => r.kind === 'quiet');
  const completed = allProven && !onlyQuiet;
  const verdict = completed ? 'completed' : anyUnobservable ? 'unobservable' : 'not_proven';
  const order = ['input_delivered', 'screen_changed', 'site_replied', 'business_confirmed'];
  const top = results.map((r) => r.level).filter((l) => l !== null).sort((x, y) => order.indexOf(/** @type {string} */ (y)) - order.indexOf(/** @type {string} */ (x)))[0] ?? null;
  const outcome = { completed, verdict, level: completed ? top : null, judgedBy: 'sdk', results, ...(onlyQuiet && allProven ? { note: 'quiet alone completes nothing' } : {}) };
  // for the user's side panel: what the SDK judged, with the records it used (the bridge keeps it as the SDK's finding)
  const recordIds = results.map((r) => r.evidence?.recordId).filter((x) => typeof x === 'string');
  await tab.client.call('KBrowser.reportResult', { targetId: tab.targetId, verdict, level: outcome.level, recordIds }).catch(() => {});
  return outcome;
}
