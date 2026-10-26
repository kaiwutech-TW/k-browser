// @ts-check
// The bridge's activity record: what each client did, for the extension's side panel and, when the user
// turns it on, a file. It is a summary, written by the bridge for every client (Kav included):
//   - commands: method, target, time, ok / error / refused by policy. Never their parameters; the one exception is the
//     URL of Page.navigate and Target.createTarget, redacted. Consecutive commands of one kind on one tab merge
//     ("Input.dispatchKeyEvent ×12").
//   - labels: KBrowser.mark labels the SDK writes ("點擊 button「查詢」"), redacted, marked as client-provided.
//   - results: what a client says its wait_for found, marked as judged by the SDK from the observation log, with the
//     record ids; never as verified by the bridge.
// No screenshots, no bodies, no typed text.
//
// Delivery never holds up a CDP reply: the panel and the file each have a bounded queue of their own; when one is full
// the oldest updates are dropped and the consumer is told there is a gap.

import fs from 'node:fs';
import path from 'node:path';
import * as auth from './auth.js';
import { redactor } from './redact.js';

export const LIMITS = Object.freeze({ perPrincipal: 500, label: 200, url: 2048, recordIds: 20, queue: 200, fileQueue: 2000,
  keepDays: 7, diskBytes: 50 * 1024 * 1024 });
const URL_METHODS = new Set(['Page.navigate', 'Target.createTarget']);
const VERDICTS = new Set(['completed', 'not_proven', 'unobservable', 'unverified']);
const LEVELS = new Set(['input_delivered', 'screen_changed', 'site_replied', 'business_confirmed']);

/** @typedef {'ok' | 'error' | 'refused'} Outcome */
/**
 * @typedef {{ id: number, seq: number, t: number, principal: string, name: string, kind: 'command' | 'label' | 'result',
 *   targetId: string | null, method?: string, outcome?: Outcome, count?: number, url?: string, label?: string,
 *   verdict?: string, level?: string | null, recordIds?: string[], source: 'bridge' | 'client' | 'sdk' }} Entry
 */

/**
 * A bounded, mergeable queue of updates with a sequence number; when full the oldest are dropped and `gap` is set.
 * One consumer at a time; `deliver` resolves when the consumer took the batch (it may never resolve: then the queue
 * just fills up and drops).
 */
export class Feed {
  /** @param {(batch: { seq: number, gap: boolean, updates: any[] }) => Promise<unknown>} deliver @param {number} limit */
  constructor(deliver, limit) {
    this.deliver = deliver;
    this.limit = limit;
    /** @type {Map<string, any>} key -> latest update (a Map keeps insertion order; re-adding a key moves it last) */
    this.queue = new Map();
    this.gap = false;
    this.seq = 0;
    this.busy = false;
    this.dropped = 0;
  }

  /** @param {string} key @param {any} update */
  push(key, update) {
    this.queue.delete(key);
    this.queue.set(key, update);
    while (this.queue.size > this.limit) {
      this.queue.delete(/** @type {string} */ (this.queue.keys().next().value));
      this.gap = true;
      this.dropped += 1;
    }
    this.#pump();
  }

  #pump() {
    if (this.busy || this.queue.size === 0) return;
    const updates = [...this.queue.values()];
    this.queue.clear();
    const batch = { seq: ++this.seq, gap: this.gap, updates };
    this.gap = false;
    this.busy = true;
    Promise.resolve().then(() => this.deliver(batch)).catch(() => { this.gap = true; }).finally(() => {
      this.busy = false;
      this.#pump();
    });
  }

  clear() {
    this.queue.clear();
    this.gap = false;
  }
}

export class Activity {
  /**
   * @param {{ limits?: Partial<Record<keyof typeof LIMITS, number>>, now?: () => number, disk?: { dir: string, write?: (file: string, text: string) => Promise<void> } | null }} [o]
   */
  constructor({ limits = {}, now = Date.now, disk = null } = {}) {
    this.limits = { ...LIMITS, ...limits };
    this.now = now;
    /** @type {Map<string, Entry[]>} principal -> newest last */
    this.byPrincipal = new Map();
    this.ids = 0;
    this.seq = 0;
    /** the side panel's feed, while a panel is open @type {Feed | null} */
    this.panel = null;
    /** @type {Feed | null} */
    this.file = null;
    /** when the credential files last changed, as the redactor saw them */
    this.credStamp = '';
    /** @type {import('./redact.js').Redactor | null} */
    this.r = null;
    if (disk) this.#openDisk(disk);
  }

  /**
   * A redactor with every credential on disk now. Rebuilt whenever any credential file changes — added, removed,
   * replaced or rewritten in place (each file's mtime, size and inode, not only the directory's: an in-place rewrite
   * leaves the directory alone, and auth accepts the new token at once) — never on a timer: a
   * token must be masked from its first use, since what is recorded stays.
   */
  #redact() {
    const st = (/** @type {string} */ p) => { try { const x = fs.statSync(p); return `${x.mtimeMs}:${x.size}:${x.ino}`; } catch { return '-'; } };
    const dir = path.join(auth.home(), 'clients');
    /** @type {string[]} */ let files = [];
    try { files = fs.readdirSync(dir).sort(); } catch { /* no clients yet */ }
    const stamp = [st(path.join(auth.home(), 'pair.key')), ...files.map((f) => `${f}=${st(path.join(dir, f))}`)].join('|');
    if (!this.r || stamp !== this.credStamp) {
      this.r = redactor({ secrets: [auth.pairKey(), ...auth.clients().values()] });
      this.credStamp = stamp;
    }
    return this.r;
  }

  /** Page or client text as the panel may show it (titles, hand-off reasons). @param {string} s */
  redactText(s) {
    return this.#redact().text(String(s));
  }

  /** A URL as the panel may show it. @param {string} u */
  redactUrl(u) {
    return this.#redact().url(String(u).slice(0, this.limits.url));
  }

  /** @param {string} principal */
  #list(principal) {
    let l = this.byPrincipal.get(principal);
    if (!l) this.byPrincipal.set(principal, (l = []));
    return l;
  }

  /** @param {Entry} e */
  #emit(e) {
    e.seq = ++this.seq;
    this.panel?.push(`e${e.id}`, { type: 'entry', entry: { ...e } });
    this.file?.push(`e${e.id}`, { ...e });
  }

  /**
   * One client command, as the bridge answered it.
   * @param {{ principal: string, name: string, method: unknown, targetId: string | null, outcome: Outcome, params?: Record<string, any> }} c
   */
  command({ principal, name, method, targetId, outcome, params = {} }) {
    const m = typeof method === 'string' ? method.slice(0, 80) : '?';
    const l = this.#list(principal);
    const last = l[l.length - 1];
    if (last && last.kind === 'command' && last.method === m && last.targetId === targetId && last.outcome === outcome && !URL_METHODS.has(m)) {
      last.count = (last.count ?? 1) + 1;
      last.t = this.now();
      this.#emit(last);
      return last;
    }
    /** @type {Entry} */
    const e = { id: ++this.ids, seq: 0, t: this.now(), principal, name, kind: 'command', targetId, method: m, outcome, count: 1, source: 'bridge' };
    if (URL_METHODS.has(m) && typeof params.url === 'string') e.url = this.#redact().url(params.url.slice(0, this.limits.url));
    return this.#add(l, e);
  }

  /** A KBrowser.mark label (client-provided). @param {{ principal: string, name: string, targetId: string, label: string }} c */
  label({ principal, name, targetId, label }) {
    if (!label) return null;
    /** @type {Entry} */
    const e = { id: ++this.ids, seq: 0, t: this.now(), principal, name, kind: 'label', targetId,
      label: this.#redact().text(String(label).slice(0, this.limits.label)), source: 'client' };
    return this.#add(this.#list(principal), e);
  }

  /**
   * What the SDK says its wait_for found (KBrowser.reportResult). Validated, never trusted as the bridge's own finding.
   * @param {{ principal: string, name: string, targetId: string, verdict: unknown, level: unknown, recordIds: unknown }} c
   */
  result({ principal, name, targetId, verdict, level, recordIds }) {
    if (typeof verdict !== 'string' || !VERDICTS.has(verdict)) throw new Error(`verdict must be one of ${[...VERDICTS].join(', ')}`);
    if (level !== null && level !== undefined && (typeof level !== 'string' || !LEVELS.has(level))) throw new Error(`level must be null or one of ${[...LEVELS].join(', ')}`);
    const ids = Array.isArray(recordIds) ? recordIds.filter((x) => typeof x === 'string' && /^n\d{1,12}$/.test(x)).slice(0, this.limits.recordIds) : [];
    /** @type {Entry} */
    const e = { id: ++this.ids, seq: 0, t: this.now(), principal, name, kind: 'result', targetId, verdict, level: level ?? null, recordIds: ids, source: 'sdk' };
    return this.#add(this.#list(principal), e);
  }

  /** @param {Entry[]} l @param {Entry} e */
  #add(l, e) {
    l.push(e);
    while (l.length > this.limits.perPrincipal) l.shift();
    this.#emit(e);
    return e;
  }

  /** The newest entries of every client. @param {number} [n] per client */
  recent(n = 100) {
    return [...this.byPrincipal.entries()].map(([principal, l]) => ({ principal, entries: l.slice(-n).map((e) => ({ ...e })) }));
  }

  /** A client was removed: its record goes with it. @param {Set<string>} live */
  forgetExcept(live) {
    for (const p of [...this.byPrincipal.keys()]) if (!live.has(p)) this.byPrincipal.delete(p);
  }

  // ---------- the file (activityLog: "disk") ----------

  /** @param {{ dir: string, write?: (file: string, text: string) => Promise<void> }} disk */
  #openDisk({ dir, write }) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    this.prune(dir);
    const append = write ?? (async (file, text) => {
      await fs.promises.appendFile(file, text, { mode: 0o600 });
      await fs.promises.chmod(file, 0o600);
    });
    let lastDay = '';
    let bytes = this.#size(dir);
    let missed = false; // updates dropped because the files were full: the next write starts with a gap line
    this.file = new Feed(async ({ gap, updates }) => {
      const day = localDay(this.now());
      if (day !== lastDay) {
        lastDay = day;
        this.prune(dir); // a new day: old files go
        bytes = this.#size(dir);
      }
      const lines = [...(gap || missed ? [{ type: 'gap', t: this.now() }] : []), ...updates].map((u) => JSON.stringify(u)).join('\n');
      const text = `${lines}\n`;
      const n = Buffer.byteLength(text, 'utf8');
      if (bytes + n > this.limits.diskBytes) {
        this.prune(dir, n); // older days first
        bytes = this.#size(dir);
        if (bytes + n > this.limits.diskBytes) { // today alone is full: keep the cap, write nothing more today
          missed = true;
          return;
        }
      }
      await append(path.join(dir, `${day}.jsonl`), text);
      bytes += n;
      missed = false;
    }, this.limits.fileQueue);
  }

  /** @param {string} dir */
  #size(dir) {
    return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
  }

  /** Delete files older than keepDays, then the oldest until the total (plus `room` bytes about to be written) fits;
   * today's file is never deleted. @param {string} dir @param {number} [room] */
  prune(dir, room = 0) {
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    const cutoff = localDay(this.now() - this.limits.keepDays * 86400_000);
    for (const f of files.filter((x) => x.slice(0, 10) < cutoff)) fs.rmSync(path.join(dir, f), { force: true });
    const left = files.filter((x) => x.slice(0, 10) >= cutoff);
    let total = left.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0) + room;
    const today = localDay(this.now());
    for (const f of left.filter((x) => x.slice(0, 10) < today)) {
      if (total <= this.limits.diskBytes) break;
      total -= fs.statSync(path.join(dir, f)).size;
      fs.rmSync(path.join(dir, f), { force: true });
    }
  }
}

/** The user's calendar day (local time), YYYY-MM-DD: a file holds what happened on the day the user lived it, so the
 * activity of 00:00-08:00 in Taiwan is not filed under the day before. @param {number} ms */
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** `~/.k-browser/config.json` (absent or unreadable: the defaults). */
export function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(auth.home(), 'config.json'), 'utf8'));
    return c && typeof c === 'object' ? c : {};
  } catch {
    return {};
  }
}
