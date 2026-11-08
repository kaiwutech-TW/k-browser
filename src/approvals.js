// @ts-check
// Approvals: the user allows (or denies) one action of a client in the K-Browser side panel before it is sent.
// Used for WebMCP tools the site marks consequential. Kept by the bridge like hand-offs: every
// session of the client sees the same state, and a bridge restart forgets them (a client asking then learns it is gone).
//
//   waiting -> allowed | denied      the user pressed 允許 / 拒絕 in the panel
//           -> expired              nobody decided in time (default 5 minutes)
//           -> invalidated          the tab went away, or the client was revoked
//
// What the panel shows (title, detail) is written by the bridge from what the approval is bound to (the tool's name,
// the page's origin, the arguments), never by the client: plain text, never markup. An allowed approval is used once,
// by the bridge itself, for exactly that call (use): the check cannot be skipped by a client that sends the CDP
// command directly.

import { randomBytes } from 'node:crypto';

/** @typedef {'waiting' | 'allowed' | 'denied' | 'expired' | 'invalidated' | 'used'} ApprovalState */
/** @typedef {{ approvalId: string, owner: string, targetId: string, tabId: number, title: string, detail: string, state: ApprovalState,
 *   createdAt: number, expiresAt: number, why: string | null, binding: string }} Approval */

export const TITLE_MAX = 200;
export const DETAIL_MAX = 2000;
export const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_WAITING = 20; // per client
const KEEP_ENDED = 200;
const newId = () => `a${randomBytes(8).toString('hex')}`;

export class Approvals {
  /** @param {{ ttlMs?: number, now?: () => number, changed?: () => void }} [o] changed: the waiting list changed */
  constructor({ ttlMs = DEFAULT_TTL_MS, now = Date.now, changed = () => {} } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.changed = changed;
    /** @type {Map<string, Approval>} */ this.items = new Map();
    /** @type {ReturnType<typeof setTimeout> | null} */ this.timer = null;
  }

  #sweep() {
    const now = this.now();
    let any = false;
    for (const a of this.items.values()) {
      if (a.state === 'waiting' && now >= a.expiresAt) {
        this.#end(a, 'expired', `nobody decided within ${Math.round(this.ttlMs / 60000)} min`);
        any = true;
      }
    }
    if (any) this.changed();
  }

  /** @param {Approval} a @param {ApprovalState} state @param {string | null} why */
  #end(a, state, why) {
    a.state = state;
    a.why = why;
    const ended = [...this.items.values()].filter((x) => x.state !== 'waiting');
    for (const x of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED))) this.items.delete(x.approvalId);
  }

  #schedule() {
    if (this.timer) clearTimeout(this.timer);
    const next = Math.min(...[...this.items.values()].filter((a) => a.state === 'waiting').map((a) => a.expiresAt));
    this.timer = Number.isFinite(next) ? setTimeout(() => { this.#sweep(); this.#schedule(); }, Math.max(0, next - this.now()) + 5) : null;
    this.timer?.unref?.();
  }

  /** A client asks the user. binding: what exactly is allowed (compared by use()).
   * @param {string} owner @param {{ targetId: string, tabId: number }} t @param {unknown} title @param {unknown} detail @param {string} [binding] */
  request(owner, t, title, detail, binding = '') {
    if (typeof title !== 'string' || !title.trim()) throw new Error('an approval needs a title (what the user is asked to allow)');
    this.#sweep();
    if ([...this.items.values()].filter((a) => a.owner === owner && a.state === 'waiting').length >= MAX_WAITING) {
      throw new Error(`${MAX_WAITING} approvals of this client are already waiting`);
    }
    const now = this.now();
    /** @type {Approval} */
    const a = { approvalId: newId(), owner, targetId: t.targetId, tabId: t.tabId, title: title.slice(0, TITLE_MAX),
      detail: typeof detail === 'string' ? detail.slice(0, DETAIL_MAX) : '', state: 'waiting', createdAt: now, expiresAt: now + this.ttlMs, why: null, binding };
    this.items.set(a.approvalId, a);
    this.#schedule();
    this.changed();
    return a;
  }

  /** The client's own approval, or null. Asking about an allowed one uses it up (it allows one action).
   * @param {string} owner @param {unknown} id @param {{ consume?: boolean }} [o] */
  get(owner, id, { consume = false } = {}) {
    this.#sweep();
    const a = typeof id === 'string' ? this.items.get(id) : undefined;
    if (!a || a.owner !== owner) return null;
    const seen = { ...a };
    if (consume && a.state === 'allowed') this.#end(a, 'used', 'already used for the action it allowed');
    return seen;
  }

  /** Use an allowed approval for the action it was bound to, once. false (nothing used) for anything else.
   * @param {string} owner @param {unknown} id @param {string} binding */
  use(owner, id, binding) {
    this.#sweep();
    const a = typeof id === 'string' ? this.items.get(id) : undefined;
    if (!a || a.owner !== owner || a.state !== 'allowed' || a.binding !== binding) return false;
    this.#end(a, 'used', 'already used for the action it allowed');
    return true;
  }

  /** The user's answer from the panel: only a waiting approval of that client. @param {string} owner @param {unknown} id @param {boolean} allow */
  decide(owner, id, allow) {
    this.#sweep();
    const a = typeof id === 'string' ? this.items.get(id) : undefined;
    if (!a || a.owner !== owner || a.state !== 'waiting') return false;
    this.#end(a, allow ? 'allowed' : 'denied', allow ? null : 'the user denied it');
    this.#schedule();
    this.changed();
    return true;
  }

  /** Waiting ones, and allowed ones not used yet (an Allow must not outlive its tab or client).
   * @param {(a: Approval) => boolean} which @param {string} why */
  invalidate(which, why) {
    let any = false;
    for (const a of this.items.values()) {
      if ((a.state === 'waiting' || a.state === 'allowed') && which(a)) {
        this.#end(a, 'invalidated', why);
        any = true;
      }
    }
    if (any) {
      this.#schedule();
      this.changed();
    }
  }

  waiting() {
    this.#sweep();
    return [...this.items.values()].filter((a) => a.state === 'waiting');
  }
}
