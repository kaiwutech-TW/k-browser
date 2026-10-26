// @ts-check
// The frame tree of one tab, and which CDP session owns each frame. Pure state: it is fed events and
// Page.getFrameTree replies and sends nothing itself.
//
// Generations: one counter per tab, only ever increasing. A frame gets a new sessionGen whenever the session that
// owns it changes (including a swap to another process) and a new documentGen whenever its document is replaced
// (cross-document navigation, document.open()). A frame that is removed and comes back under the same frameId gets
// fresh values too, so a ref or world captured earlier can never match by accident. Whatever was captured against a
// stamp is valid only while same(stamp) holds.
//
// A frame whose document is replaced loses its whole old subtree at once: child frames belong to the old document,
// and their own detach events may come later or never (an OOPIF's session simply goes away).
//
// Frame swaps (a frame moving between processes, i.e. between sessions). Measured with chrome.debugger on Chrome for
// Testing 149:
//   local -> remote: Target.attachedToTarget(new child) arrives BEFORE Page.frameDetached(reason: "swap") from the
//     old owner; the protocol does not promise this order (Playwright handles both), so both are handled.
//   remote -> local: Target.detachedFromTarget(old child) arrives BEFORE Page.frameAttached in the parent. The frame
//     is removed and then recreated with new generations: correct for refs, merely a brief absence.
// A late event from a session that no longer owns the frame is ignored; it must not undo the newer owner. Two
// exceptions keep a frame from ending up ownerless while something still holds it: a swap-out hands the frame to a live child session already rooted at it, and the
// session a frame was swapped out of may still remove it while no new owner has come.

/** @typedef {{ id: string, parentId: string | null, sessionId: string | null, sessionGen: number, documentGen: number,
 *   url: string, seq: number, prevSessionId: string | null }} Frame */
/** @typedef {{ sid: string, parent: string | null, alive: boolean, frameId: string | null }} Session */
/** @typedef {{ frameId: string, sessionId: string, sessionGen: number, documentGen: number }} Stamp */

export class FrameTree {
  /** @param {string} rootSession */
  constructor(rootSession) {
    this.rootSession = rootSession;
    this.gen = 0;
    /** @type {Map<string, Frame>} */
    this.frames = new Map();
    /** @type {Map<string, Session>} */
    this.sessions = new Map([[rootSession, { sid: rootSession, parent: null, alive: true, frameId: null }]]);
    /** @type {string | null} */
    this.mainFrameId = null;
    /** frameId -> seq of its removal, kept only while a getFrameTree is in flight @type {Map<string, number>} */
    this.removedAt = new Map();
    this.treesInFlight = 0;
  }

  next() {
    return ++this.gen;
  }

  /** @param {string | null} sid */
  live(sid) {
    return sid !== null && this.sessions.get(sid)?.alive === true;
  }

  /** Is this one of this tab's sessions (alive or not)? @param {string | null} sid */
  knows(sid) {
    return sid !== null && this.sessions.has(sid);
  }

  /** @param {string} frameId @returns {Stamp | null} null when the frame is unknown or has no owner right now */
  stamp(frameId) {
    const f = this.frames.get(frameId);
    if (!f || f.sessionId === null || !this.live(f.sessionId)) return null;
    return { frameId, sessionId: f.sessionId, sessionGen: f.sessionGen, documentGen: f.documentGen };
  }

  /** @param {Stamp} s */
  same(s) {
    const f = this.frames.get(s.frameId);
    return Boolean(f && f.sessionId === s.sessionId && f.sessionGen === s.sessionGen && f.documentGen === s.documentGen
      && this.live(s.sessionId));
  }

  /** Frames in tree order (depth first from the main frame), then any whose parent is not known yet. */
  order() {
    /** @type {Map<string | null, Frame[]>} */
    const kids = new Map();
    for (const f of this.frames.values()) {
      const p = f.parentId !== null && this.frames.has(f.parentId) ? f.parentId : null;
      if (!kids.has(p)) kids.set(p, []);
      /** @type {Frame[]} */ (kids.get(p)).push(f);
    }
    /** @type {Frame[]} */
    const out = [];
    /** @param {Frame} f */
    const walk = (f) => {
      out.push(f);
      for (const c of kids.get(f.id) ?? []) walk(c);
    };
    const roots = kids.get(null) ?? [];
    roots.sort((a, b) => Number(b.id === this.mainFrameId) - Number(a.id === this.mainFrameId));
    for (const r of roots) walk(r);
    return out;
  }

  /** @param {string} frameId */
  children(frameId) {
    return [...this.frames.values()].filter((f) => f.parentId === frameId);
  }

  /** @param {string} frameId @returns {string[]} */
  #descendants(frameId) {
    return this.children(frameId).flatMap((c) => [c.id, ...this.#descendants(c.id)]);
  }

  // ---------- mutations ----------

  /** @param {string} id @param {string | null} parentId @param {string} sessionId @param {string} url @param {number} seq */
  #create(id, parentId, sessionId, url, seq) {
    this.removedAt.delete(id);
    /** @type {Frame} */
    const f = { id, parentId, sessionId, sessionGen: this.next(), documentGen: this.next(), url, seq, prevSessionId: null };
    this.frames.set(id, f);
    return f;
  }

  /** Drop every descendant of frameId (not the frame itself). @param {string} frameId @param {number} seq */
  #dropDescendants(frameId, seq) {
    for (const c of this.children(frameId)) this.#remove(c.id, seq);
  }

  /** Remove a frame and its subtree; a child session rooted at a removed frame dies with it. @param {string} frameId @param {number} seq */
  #remove(frameId, seq) {
    const f = this.frames.get(frameId);
    if (!f) return;
    this.#dropDescendants(frameId, seq);
    this.frames.delete(frameId);
    if (this.treesInFlight > 0) this.removedAt.set(frameId, seq);
    for (const s of this.sessions.values()) if (s.frameId === frameId && s.sid !== this.rootSession) this.#kill(s.sid, seq);
  }

  /** A session and every session attached through it stop counting; frames they own go away.
   * @param {string} sid @param {number} seq */
  #kill(sid, seq) {
    const s = this.sessions.get(sid);
    if (!s || !s.alive) return;
    s.alive = false;
    for (const other of this.sessions.values()) if (other.parent === sid) this.#kill(other.sid, seq);
    // Its frames go, and so does a frame swapped out of it that no new owner has taken: nothing could remove it later.
    for (const f of [...this.frames.values()]) {
      if (f.sessionId === sid || (f.sessionId === null && f.prevSessionId === sid)) this.#remove(f.id, seq);
    }
  }

  /** The frame's document was replaced. @param {Frame} f @param {number} seq */
  #newDocument(f, seq) {
    f.documentGen = this.next();
    f.seq = seq;
    this.#dropDescendants(f.id, seq);
  }

  /** The frame now belongs to sid (a swap, or its first owner). @param {Frame} f @param {string | null} sid @param {number} seq */
  #newOwner(f, sid, seq) {
    if (f.sessionId !== null) f.prevSessionId = f.sessionId;
    f.sessionId = sid;
    f.sessionGen = this.next();
    this.#newDocument(f, seq);
  }

  /**
   * Apply one event. Returns the id of a child session that needs setting up (Page.enable, getFrameTree,
   * auto-attach), if the event announced one.
   * @param {import('./cdp.js').CdpEvent} ev @returns {string | null}
   */
  onEvent({ method, params, sessionId: sid, seq }) {
    if (method === 'Target.detachedFromTarget') {
      if (this.knows(params.sessionId)) this.#kill(params.sessionId, seq);
      return null;
    }
    if (!this.live(sid)) return null; // not ours, or from a session that already ended
    const S = /** @type {string} */ (sid);
    switch (method) {
      case 'Target.attachedToTarget': {
        const info = params.targetInfo ?? {};
        if (info.type !== 'iframe' || typeof params.sessionId !== 'string') return null;
        const C = params.sessionId;
        this.sessions.set(C, { sid: C, parent: S, alive: true, frameId: info.targetId });
        const f = this.frames.get(info.targetId);
        if (f) this.#newOwner(f, C, seq);
        else this.#create(info.targetId, null, C, info.url ?? '', seq);
        // The newest session for a frame supersedes any earlier one still alive (its detach may come later): at most
        // one live child session is rooted at a frame, so a hand-back can never pick an outdated one.
        for (const old of this.sessions.values()) {
          if (old.sid !== C && old.alive && old.frameId === info.targetId && old.sid !== this.rootSession) this.#kill(old.sid, seq);
        }
        return C;
      }
      case 'Page.frameAttached': {
        const f = this.frames.get(params.frameId);
        if (!f) this.#create(params.frameId, params.parentFrameId ?? null, S, '', seq);
        // remote -> local with frameAttached before the child's detach (the order Playwright usually sees). A stale
        // frameAttached takes the frame too, but a following swap-out hands it back to the live child (below).
        else if (f.sessionId !== S) this.#newOwner(f, S, seq);
        return null;
      }
      case 'Page.frameNavigated': {
        const fr = params.frame ?? {};
        if (typeof fr.id !== 'string') return null;
        let f = this.frames.get(fr.id);
        if (f && f.sessionId !== S) return null; // a session that no longer owns it
        // Only cross-document navigations come here (same-document ones are Page.navigatedWithinDocument).
        if (f) this.#newDocument(f, seq);
        else f = this.#create(fr.id, fr.parentId ?? null, S, fr.url ?? '', seq);
        f.url = fr.url ?? f.url;
        if (fr.parentId) f.parentId = fr.parentId;
        if (!fr.parentId && S === this.rootSession) this.#setMain(fr.id);
        return null;
      }
      case 'Page.documentOpened': {
        const f = this.frames.get(params.frame?.id);
        if (f && f.sessionId === S) this.#newDocument(f, seq);
        return null;
      }
      case 'Page.frameDetached': {
        const f = this.frames.get(params.frameId);
        // Unknown yet, but a frame tree reply may be waiting to be applied: it must not bring this frame back.
        if (!f && params.reason !== 'swap' && this.treesInFlight > 0) this.removedAt.set(params.frameId, seq);
        if (!f) return null;
        if (f.sessionId !== S) {
          // A late event from a session that lost the frame is ignored, except that the session it was swapped out of
          // may still remove it while no new owner has come: otherwise it would stay behind as an ownerless ghost.
          if (params.reason !== 'swap' && f.sessionId === null && f.prevSessionId === S) this.#remove(f.id, seq);
          return null;
        }
        // A swap keeps the logical frame. Its new owner attaches later, unless a live child session rooted at it
        // already did (attach first, then a late swap from here): then it goes to that session, never to nobody.
        if (params.reason === 'swap') this.#newOwner(f, this.#childRootedAt(f.id, S), seq);
        else this.#remove(f.id, seq);
        return null;
      }
      default:
        return null;
    }
  }

  /** A live child session whose root is frameId, other than except. @param {string} frameId @param {string} except */
  #childRootedAt(frameId, except) {
    for (const s of this.sessions.values()) {
      if (s.alive && s.frameId === frameId && s.sid !== except && s.sid !== this.rootSession) return s.sid;
    }
    return null;
  }

  /** @param {string} id */
  #setMain(id) {
    this.mainFrameId = id;
    const root = this.sessions.get(this.rootSession);
    if (root) root.frameId = id;
  }

  /** Call before sending Page.getFrameTree; pair with applyFrameTree or treeFailed. */
  treeRequested() {
    this.treesInFlight += 1;
  }

  treeFailed() {
    this.treesInFlight = Math.max(0, this.treesInFlight - 1);
    if (this.treesInFlight === 0) this.removedAt.clear();
  }

  /**
   * Reconcile with a Page.getFrameTree reply from session sid that arrived with sequence number seq. An entry that an
   * event touched after the reply (higher seq) wins; a frame removed after the reply stays removed. Where the reply is
   * not taken for a frame, it is not taken for anything under it either: those children belong to a document or a
   * session the reply no longer describes.
   * @param {string} sid @param {any} frameTree @param {number} seq
   */
  applyFrameTree(sid, frameTree, seq) {
    try {
      if (!this.live(sid)) return;
      /** @type {Set<string>} */
      const seen = new Set();
      /** @param {any} node @param {string | null} parentId */
      const visit = (node, parentId) => {
        const fr = node.frame;
        seen.add(fr.id);
        const pid = fr.parentId ?? parentId;
        const f = this.frames.get(fr.id);
        if (f) {
          // Changed after the reply, owned by another session, or between owners (swap): the reply is out of date here.
          if (f.seq > seq || f.sessionId !== sid) {
            for (const d of this.#descendants(f.id)) seen.add(d);
            return;
          }
          f.url = fr.url;
          if (pid) f.parentId = pid;
        } else if ((this.removedAt.get(fr.id) ?? -1) > seq) {
          return; // removed after the reply: so is everything that was under it
        } else {
          this.#create(fr.id, pid ?? null, sid, fr.url, seq);
        }
        if (!pid && sid === this.rootSession) this.#setMain(fr.id);
        for (const c of node.childFrames ?? []) visit(c, fr.id);
      };
      visit(frameTree, null);
      // Owned by sid, untouched since before the reply, and absent from it: gone before the reply was made.
      for (const f of [...this.frames.values()]) {
        if (f.sessionId === sid && !seen.has(f.id) && f.seq < seq) this.#remove(f.id, seq);
      }
    } finally {
      this.treeFailed();
    }
  }
}
