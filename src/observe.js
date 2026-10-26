// @ts-check
// The bridge's observation log: network and navigation events of owned tabs, written
// by the bridge as it forwards them, so a page cannot change what was kept. Clients read it with KBrowser.* (relay.js).
//
// The bridge only listens: it never sends Network.enable for a client (that would change what Kav sees). What it
// saw depends on what the client enabled, so it also keeps *observable intervals*: per session (the root session
// of a tab, and each OOPIF child session), from a successful Network.enable to Network.disable, a detach, an
// extension reconnect, or the buffer dropping entries. A question about a window that was not observable all along
// is answered `unobservable`, never "nothing happened".
//
// Order: every recorded event and boundary gets a sequence number in the order the bridge received it. A mark taken
// after a barrier (relay.js) is later than every event Chrome sent before the mark; "after the mark" means "its
// requestWillBeSent came after the mark".

/** @typedef {{ kind: 'on' | 'off', seq: number, child: string | null, why: string }} Boundary */
/**
 * @typedef {{
 *   id: string, seq: number, chainSeq: number, t: number, requestId: string, hop: number, child: string | null, attachGen: number,
 *   obsGen: number, frameId: string | null, loaderId: string | null, url: string, method: string, type: string | null,
 *   status: number | null, mimeType: string | null, fromServiceWorker: boolean, fromCache: boolean,
 *   redirectedTo: boolean, finished: boolean, failed: string | null, respondedAt: number | null, endedAt: number | null,
 *   body: { text: string, base64Encoded: boolean, truncated: boolean, capturedSeq: number } | null, bytes: number,
 * }} Entry
 */
/** @typedef {{ actionId: string, seq: number, t: number, principal: string, targetId: string, obsGen: number, label: string, source: 'client' }} Mark */

/** @typedef {{ entries: number, bytes: number, body: number, url: number, label: number, queryLimit: number, queryBodyBytes: number, glob: number, marks: number, history: number }} Limits */

/** @type {Readonly<Limits>} */
export const LIMITS = Object.freeze({
  entries: 2000, // per target
  bytes: 8 * 1024 * 1024, // per target, bodies included
  body: 1024 * 1024, // per captured body
  url: 4096,
  label: 200,
  queryLimit: 200,
  queryBodyBytes: 4 * 1024 * 1024, // bodies returned by one query
  glob: 1000,
  marks: 500, // per target
  history: 50,
});

const ROOT = '<root>'; // key of the root session in per-session maps

class TargetLog {
  /** @param {string} owner */
  constructor(owner) {
    this.owner = owner;
    /** @type {Entry[]} */ this.entries = [];
    /** @type {Map<string, Entry>} requestId|child -> its latest hop */ this.latest = new Map();
    this.bytes = 0;
    /** the highest seq among entries dropped to stay within the limits */ this.evictedSeq = 0;
    /** @type {Map<string, number | null>} session key -> seq its current observable interval began, null when off */
    this.on = new Map();
    /** @type {Boundary[]} */ this.boundaries = [];
    /** @type {Map<string, number>} child sessions currently attached -> seq they attached at */ this.children = new Map();
    /** @type {Map<string, Mark>} */ this.marks = new Map();
    this.nav = { url: '', frameId: /** @type {string | null} */ (null), loaderId: /** @type {string | null} */ (null), history: /** @type {{ seq: number, t: number, url: string, loaderId: string | null, sameDocument: boolean }[]} */ ([]) };
    this.attachGen = 0;
  }
}

export class Observer {
  /** @param {{ limits?: Partial<Limits>, now?: () => number }} [o] */
  constructor({ limits = {}, now = Date.now } = {}) {
    this.limits = { ...LIMITS, ...limits };
    this.now = now;
    this.seq = 0;
    /** bumped when the extension reconnects: everything observed before belongs to another generation */
    this.obsGen = 0;
    this.marks = 0;
    /** @type {Map<string, TargetLog>} */
    this.logs = new Map();
  }

  /** The log of a target, created for its owner. @param {string} targetId @param {string} owner */
  log(targetId, owner) {
    let l = this.logs.get(targetId);
    if (!l) {
      l = new TargetLog(owner);
      this.logs.set(targetId, l);
    }
    return l;
  }

  /** @param {string} targetId */
  forget(targetId) {
    this.logs.delete(targetId);
  }

  /** chrome.debugger (re)attached to the target's tab. @param {string} targetId @param {string} owner */
  attached(targetId, owner) {
    this.log(targetId, owner).attachGen += 1;
  }

  /** Network.enable succeeded on a session. @param {string} targetId @param {string} owner @param {string | null} child */
  enabled(targetId, owner, child) {
    const l = this.log(targetId, owner);
    const key = child ?? ROOT;
    if (typeof l.on.get(key) === 'number') return; // already observing
    const seq = ++this.seq;
    const attachedAt = child === null ? undefined : l.children.get(child);
    // a child is not observed from its attach to this enable: kept as a gap, so it outlives the child's detach
    if (attachedAt !== undefined && !l.boundaries.some((b) => b.child === child && b.kind === 'off')) {
      l.boundaries.push({ kind: 'off', seq: attachedAt, child, why: 'not observed from attach to Network.enable' });
    }
    l.on.set(key, seq);
    l.boundaries.push({ kind: 'on', seq, child, why: 'Network.enable' });
  }

  /**
   * A session stopped being observed. child undefined = every session of the target.
   * @param {string} targetId @param {string | null | undefined} child @param {string} why
   */
  disabled(targetId, child, why) {
    const l = this.logs.get(targetId);
    if (!l) return;
    const keys = child === undefined ? [...l.on.keys()] : [child ?? ROOT];
    for (const key of keys) {
      if (typeof l.on.get(key) !== 'number') continue;
      l.on.set(key, null);
      l.boundaries.push({ kind: 'off', seq: ++this.seq, child: key === ROOT ? null : key, why });
    }
    // Only a detach takes a child off the list: a child that switched its network off is still there, unobserved.
    if (child === undefined && why !== 'Network.disable') l.children.clear();
    if (l.boundaries.length > 1000) l.boundaries.splice(0, l.boundaries.length - 1000);
  }

  /** The extension reconnected: every interval ends, a new generation starts. */
  newGeneration() {
    for (const id of this.logs.keys()) this.disabled(id, undefined, 'extension reconnected');
    this.obsGen += 1;
  }

  /**
   * A CDP event of an owned target, as the bridge forwards it.
   * @param {string} targetId @param {string} owner @param {string | null} child @param {string} method @param {Record<string, any>} p
   */
  event(targetId, owner, child, method, p) {
    const l = this.log(targetId, owner);
    switch (method) {
      case 'Target.attachedToTarget':
        if (typeof p.sessionId === 'string') l.children.set(p.sessionId, ++this.seq);
        return;
      case 'Target.detachedFromTarget':
        if (typeof p.sessionId === 'string') {
          const attachedAt = l.children.get(p.sessionId);
          // never observed at all: its whole life is a gap, kept after it is gone
          if (attachedAt !== undefined && typeof l.on.get(p.sessionId) !== 'number' && !l.boundaries.some((b) => b.child === p.sessionId && b.kind === 'off')) {
            l.boundaries.push({ kind: 'off', seq: attachedAt, child: p.sessionId, why: 'never observed' });
          }
          this.disabled(targetId, p.sessionId, 'child session detached');
          l.children.delete(p.sessionId);
        }
        return;
      case 'Network.requestWillBeSent': {
        if (typeof p.requestId !== 'string') return;
        const key = `${p.requestId}|${child ?? ''}`;
        const prev = l.latest.get(key);
        if (prev && p.redirectResponse) {
          // the previous hop ends with the redirect: the same requestId goes on as the next hop
          prev.status = numberOr(p.redirectResponse.status);
          prev.mimeType = stringOr(p.redirectResponse.mimeType);
          prev.fromServiceWorker = !!p.redirectResponse.fromServiceWorker;
          prev.redirectedTo = true;
          prev.finished = true;
          prev.respondedAt = prev.endedAt = this.now();
        }
        const seq = ++this.seq;
        /** @type {Entry} */
        const e = {
          // chainSeq: when the request itself began (its first hop): a redirect after the mark is still the old request.
          // A redirect whose earlier hops are no longer known began at an unknown earlier time: 0, never "after" a mark.
          id: `n${seq}`, seq, chainSeq: p.redirectResponse ? prev?.chainSeq ?? 0 : seq, t: this.now(), requestId: p.requestId,
          hop: prev && p.redirectResponse ? prev.hop + 1 : 0, child, attachGen: l.attachGen,
          obsGen: this.obsGen, frameId: stringOr(p.frameId), loaderId: stringOr(p.loaderId),
          url: String(p.request?.url ?? '').slice(0, this.limits.url), method: String(p.request?.method ?? 'GET'),
          type: stringOr(p.type), status: null, mimeType: null, fromServiceWorker: false, fromCache: false, redirectedTo: false,
          finished: false, failed: null, respondedAt: null, endedAt: null, body: null, bytes: 0,
        };
        e.bytes = 300 + e.url.length;
        l.entries.push(e);
        l.latest.set(key, e);
        l.bytes += e.bytes;
        this.#trim(l);
        return;
      }
      case 'Network.responseReceived': {
        const e = l.latest.get(`${p.requestId}|${child ?? ''}`);
        if (!e) return;
        e.status = numberOr(p.response?.status);
        e.mimeType = stringOr(p.response?.mimeType);
        e.fromServiceWorker = !!p.response?.fromServiceWorker;
        e.fromCache = e.fromCache || !!p.response?.fromDiskCache || !!p.response?.fromPrefetchCache;
        e.respondedAt = this.now();
        return;
      }
      case 'Network.requestServedFromCache': {
        const e = l.latest.get(`${p.requestId}|${child ?? ''}`);
        if (e) e.fromCache = true;
        return;
      }
      case 'Network.loadingFinished': {
        const e = l.latest.get(`${p.requestId}|${child ?? ''}`);
        if (e) {
          e.finished = true;
          e.endedAt = this.now();
        }
        return;
      }
      case 'Network.loadingFailed': {
        const e = l.latest.get(`${p.requestId}|${child ?? ''}`);
        if (e) {
          e.finished = true;
          e.failed = String(p.errorText ?? 'failed').slice(0, 200);
          e.endedAt = this.now();
        }
        return;
      }
      case 'Page.frameNavigated':
        if (child === null && p.frame && !p.frame.parentId) {
          l.nav.frameId = stringOr(p.frame.id);
          this.#navigated(l, String(p.frame.url ?? ''), stringOr(p.frame.loaderId), false);
        }
        return;
      case 'Page.navigatedWithinDocument':
        if (child === null && typeof p.url === 'string' && p.frameId === l.nav.frameId) this.#navigated(l, p.url, l.nav.loaderId, true);
        return;
      default:
    }
  }

  /** @param {TargetLog} l @param {string} url @param {string | null} loaderId @param {boolean} same */
  #navigated(l, url, loaderId, same) {
    l.nav.url = url.slice(0, this.limits.url);
    l.nav.loaderId = loaderId;
    l.nav.history.push({ seq: ++this.seq, t: this.now(), url: l.nav.url, loaderId, sameDocument: same });
    if (l.nav.history.length > this.limits.history) l.nav.history.shift();
  }

  /** Keep the newest entries within both limits; what is dropped makes earlier windows unobservable. @param {TargetLog} l */
  #trim(l) {
    while (l.entries.length > this.limits.entries || (l.bytes > this.limits.bytes && l.entries.length > 1)) {
      const e = /** @type {Entry} */ (l.entries.shift());
      l.bytes -= e.bytes;
      l.evictedSeq = Math.max(l.evictedSeq, e.seq);
      const key = `${e.requestId}|${e.child ?? ''}`;
      if (l.latest.get(key) === e) l.latest.delete(key);
    }
  }

  /**
   * The body of a response, from the bridge's own copy of Chrome's reply to Network.getResponseBody (never text a
   * client submits). It belongs to the latest hop of that requestId on that session.
   * @param {string} targetId @param {string | null} child @param {string} requestId @param {{ body?: unknown, base64Encoded?: unknown }} result
   */
  body(targetId, child, requestId, result) {
    const l = this.logs.get(targetId);
    const e = l?.latest.get(`${requestId}|${child ?? ''}`);
    if (!l || !e || typeof result.body !== 'string') return;
    const truncated = result.body.length > this.limits.body;
    const text = truncated ? result.body.slice(0, this.limits.body) : result.body;
    if (e.body) l.bytes -= e.body.text.length;
    e.body = { text, base64Encoded: result.base64Encoded === true, truncated, capturedSeq: ++this.seq };
    l.bytes += text.length;
    this.#trim(l);
  }

  /** @param {string} principal @param {string} targetId @param {string} label @returns {Mark} */
  mark(principal, targetId, label) {
    const l = this.log(targetId, principal);
    const seq = ++this.seq;
    /** @type {Mark} */
    const m = { actionId: `a${++this.marks}`, seq, t: this.now(), principal, targetId, obsGen: this.obsGen, label: String(label ?? '').slice(0, this.limits.label), source: 'client' };
    l.marks.set(m.actionId, m);
    if (l.marks.size > this.limits.marks) l.marks.delete(/** @type {string} */ (l.marks.keys().next().value));
    return m;
  }

  /**
   * Network entries of a target. Throws (message for the client) on a bad mark or arguments.
   * @param {string} principal @param {string} targetId
   * @param {{ sinceActionId?: string, urlGlob?: string, method?: string, status?: number | [number, number], limit?: number, includeBody?: boolean }} q
   */
  query(principal, targetId, q = {}) {
    const l = this.logs.get(targetId);
    let since = 0;
    /** @type {Mark | null} */ let mark = null;
    if (q.sinceActionId !== undefined) {
      mark = l?.marks.get(String(q.sinceActionId)) ?? null;
      if (!mark || mark.principal !== principal || mark.targetId !== targetId) throw new Error(`no mark ${String(q.sinceActionId)} for this target`);
      since = mark.seq;
    }
    const limit = Math.max(1, Math.min(this.limits.queryLimit, Number.isInteger(q.limit) ? /** @type {number} */ (q.limit) : 50));
    const match = q.urlGlob === undefined ? null : globMatcher(q.urlGlob, this.limits.glob);
    const method = q.method === undefined ? null : String(q.method).toUpperCase();
    const status = q.status === undefined ? null : Array.isArray(q.status) ? q.status : [q.status, q.status];
    const all = (l?.entries ?? []).filter((e) => e.chainSeq > since && (!match || match(e.url)) && (!method || e.method === method)
      && (!status || (e.status !== null && e.status >= status[0] && e.status <= status[1])));
    let budget = this.limits.queryBodyBytes;
    const entries = all.slice(-limit).map((e) => {
      const { bytes, body, ...rest } = e;
      if (!q.includeBody || !body) return { ...rest, body: body ? { captured: true, length: body.text.length, truncated: body.truncated } : null };
      const fits = body.text.length <= budget;
      budget -= fits ? body.text.length : 0;
      return { ...rest, body: fits ? { ...body } : { captured: true, length: body.text.length, truncated: true, omitted: 'query body budget' } };
    });
    return { entries, truncated: all.length > entries.length, markT: mark?.t ?? null, ...this.observability(l, since, mark) };
  }

  /**
   * Was the window (since, now] observable all along on the root session? Children that were attached but not
   * observed make it `partial` (their requests may be missing).
   * @param {TargetLog | undefined} l @param {number} since @param {Mark | null} mark
   */
  observability(l, since, mark) {
    /** @type {string[]} */ const why = [];
    if (!l) why.push('nothing observed for this target');
    else {
      if (mark && mark.obsGen !== this.obsGen) why.push('the extension reconnected after the mark');
      const rootOn = l.on.get(ROOT);
      if (typeof rootOn !== 'number') why.push('the network is not being observed (no Network.enable on the tab session)');
      else if (rootOn > since && since > 0) why.push('the network was not observed from the mark on (enabled after it)');
      for (const b of l.boundaries) if (b.seq > since && b.kind === 'off' && b.child === null) why.push(`observation was interrupted after the mark (${b.why})`);
      if (l.evictedSeq > since) why.push('older entries were dropped to stay within the log limits');
    }
    // A cross-site frame's requests may be missing from the window: a child attached now that is not observed, was
    // observed only from after it attached (or after the mark), or was switched off at some point in the window.
    const partial = !!l && ([...l.children].some(([c, attachedAt]) => {
      const on = l.on.get(c);
      return typeof on !== 'number' || on > Math.max(since, attachedAt);
    }) || l.boundaries.some((b) => b.seq > since && b.kind === 'off' && b.child !== null && b.why !== 'child session detached'));
    return { unobservable: why.length > 0, why: [...new Set(why)], partial };
  }

  /** @param {string} targetId */
  navigation(targetId) {
    const l = this.logs.get(targetId);
    return l ? { url: l.nav.url, loaderId: l.nav.loaderId, history: l.nav.history.map((h) => ({ ...h })) } : { url: '', loaderId: null, history: [] };
  }
}

/** @param {unknown} v */
const numberOr = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** @param {unknown} v */
const stringOr = (v) => (typeof v === 'string' ? v : null);

/**
 * A glob matcher: `*` any run of characters (slashes included), `?` one character, everything else literal.
 * Linear-time two-pointer matching (no regular expression), so a hostile pattern cannot stall the event loop.
 * @param {unknown} pattern @param {number} maxLength @returns {(s: string) => boolean}
 */
export function globMatcher(pattern, maxLength = LIMITS.glob) {
  if (typeof pattern !== 'string' || pattern.length > maxLength) throw new Error(`urlGlob must be a string of at most ${maxLength} characters`);
  const p = pattern.replace(/\*+/g, '*');
  return (s) => {
    let i = 0;
    let j = 0;
    let star = -1;
    let mark = 0;
    while (i < s.length) {
      if (j < p.length && (p[j] === '?' || p[j] === s[i])) {
        i += 1;
        j += 1;
      } else if (j < p.length && p[j] === '*') {
        star = j;
        mark = i;
        j += 1;
      } else if (star !== -1) {
        j = star + 1;
        mark += 1;
        i = mark;
      } else return false;
    }
    while (j < p.length && p[j] === '*') j += 1;
    return j === p.length;
  };
}
