// @ts-check
// Hand-offs to the user (K-Browser never takes the focus; when the user must look, it is
// an explicit hand-off). Kept by the bridge, so every session of a client sees the same state, and a bridge restart
// forgets them all (a client asking about one then learns it is gone).
//
//   waiting -> returned     the user pressed "交還" in the extension popup
//           -> cancelled    the client cancelled it
//           -> expired      nobody returned it in time (default 30 minutes)
//           -> invalidated  the tab went away, the client was revoked, or the extension restarted
//
// "returned" means only that the user gave control back, never that the task succeeded: the client must look again.
// A navigation by the user meanwhile does not invalidate it; the URL at return time is reported.

import { randomBytes } from 'node:crypto';

/** @typedef {'waiting' | 'returned' | 'cancelled' | 'expired' | 'invalidated'} HandoffState */
/** @typedef {{ handoffId: string, owner: string, targetId: string, tabId: number, reason: string, source: 'client', state: HandoffState,
 *   createdAt: number, expiresAt: number, endedAt: number | null, why: string | null, url: string | null }} Handoff */

export const REASON_MAX = 200;
export const DEFAULT_TTL_MS = 30 * 60 * 1000;
const KEEP_ENDED = 200; // ended hand-offs kept for status queries
// Random ids: a restarted bridge must not hand out an id a client still holds from before (it would read another's state).
const newId = () => `h${randomBytes(8).toString('hex')}`;

export class Handoffs {
  /** @param {{ ttlMs?: number, now?: () => number, changed?: () => void }} [o] changed: the waiting list changed */
  constructor({ ttlMs = DEFAULT_TTL_MS, now = Date.now, changed = () => {} } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.changed = changed;
    /** @type {Map<string, Handoff>} */ this.items = new Map();
    /** @type {ReturnType<typeof setTimeout> | null} */ this.timer = null;
  }

  /** Move overdue hand-offs to expired. */
  #sweep() {
    const now = this.now();
    let any = false;
    for (const h of this.items.values()) {
      if (h.state === 'waiting' && now >= h.expiresAt) {
        this.#end(h, 'expired', `nobody returned it within ${Math.round(this.ttlMs / 60000)} min`);
        any = true;
      }
    }
    return any;
  }

  /** @param {Handoff} h @param {HandoffState} state @param {string | null} why */
  #end(h, state, why) {
    h.state = state;
    h.endedAt = this.now();
    h.why = why;
    const ended = [...this.items.values()].filter((x) => x.state !== 'waiting');
    for (const x of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED))) this.items.delete(x.handoffId);
  }

  #schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const next = Math.min(...[...this.items.values()].filter((h) => h.state === 'waiting').map((h) => h.expiresAt));
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => { if (this.#sweep()) this.changed(); this.#schedule(); }, Math.max(0, next - this.now()) + 5);
    this.timer.unref?.();
  }

  #touch() {
    this.#schedule();
    this.changed();
  }

  /**
   * Hand a tab to the user. One waiting hand-off per tab: asking again returns the one already waiting.
   * @param {string} owner @param {{ targetId: string, tabId: number }} target @param {unknown} reason
   */
  request(owner, target, reason) {
    this.#sweep();
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (!text) throw new Error('needs a reason (what the user should do)');
    const open = [...this.items.values()].find((h) => h.targetId === target.targetId && h.state === 'waiting');
    if (open) return { ...open, existing: true };
    const now = this.now();
    /** @type {Handoff} */
    const h = { handoffId: newId(), owner, targetId: target.targetId, tabId: target.tabId, reason: text.slice(0, REASON_MAX), source: 'client',
      state: 'waiting', createdAt: now, expiresAt: now + this.ttlMs, endedAt: null, why: null, url: null };
    this.items.set(h.handoffId, h);
    this.#touch();
    return { ...h, existing: false };
  }

  /** @param {string} owner @param {unknown} id @returns {Handoff | null} null when unknown or someone else's */
  get(owner, id) {
    if (this.#sweep()) this.#touch();
    const h = this.items.get(String(id));
    return h && h.owner === owner ? { ...h } : null;
  }

  /** @param {string} owner @param {unknown} id */
  cancel(owner, id) {
    const h = this.items.get(String(id));
    if (!h || h.owner !== owner) return null;
    if (h.state === 'waiting') {
      this.#end(h, 'cancelled', 'the client cancelled it');
      this.#touch();
    }
    return { ...h };
  }

  /** The waiting hand-off of a target, if any. @param {string} owner @param {string} targetId */
  waitingFor(owner, targetId) {
    if (this.#sweep()) this.#touch();
    const h = [...this.items.values()].find((x) => x.targetId === targetId && x.owner === owner && x.state === 'waiting');
    return h ? { ...h } : null;
  }

  /** The user gave the tab back (from the extension). @param {unknown} id @param {(h: Handoff) => string} urlOf the tab's URL now */
  returned(id, urlOf) {
    if (this.#sweep()) this.#touch();
    const h = this.items.get(String(id));
    if (!h || h.state !== 'waiting') return false;
    h.url = urlOf(h);
    this.#end(h, 'returned', null);
    this.#touch();
    return true;
  }

  /** @param {(h: Handoff) => boolean} pred @param {string} why */
  invalidate(pred, why) {
    let any = false;
    for (const h of this.items.values()) {
      if (h.state === 'waiting' && pred(h)) {
        this.#end(h, 'invalidated', why);
        any = true;
      }
    }
    if (any) this.#touch();
  }

  /** What the extension shows: every waiting hand-off. */
  waiting() {
    this.#sweep();
    return [...this.items.values()].filter((h) => h.state === 'waiting').map((h) => ({ handoffId: h.handoffId, tabId: h.tabId, reason: h.reason, expiresAt: h.expiresAt }));
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
