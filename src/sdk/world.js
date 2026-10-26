// @ts-check
// One isolated world per frame document: every script the SDK runs in a page runs there, never in the page's main
// world, so the page's own JS cannot see or tamper with it (and the SDK leaves no globals behind).
//
// Runtime.enable is never sent (it is observable by the page and not needed), so no execution-context events arrive.
// A world is therefore trusted only while the frame's stamp (session and document generations) is unchanged: a
// context can outlive its document (after document.open() the old world still answers, measured),
// so "the context still exists" proves nothing. A world that cannot be (re)created is an error;
// there is no fallback to the main world.

import { randomBytes } from 'node:crypto';
import { SdkError } from './cdp.js';

/** @typedef {import('./frames.js').Stamp} Stamp */
/** @typedef {{ stamp: Stamp, contextId: number }} World */

/** An argument passed by reference: a remote object of the same world (callOn). */
export class Handle {
  /** @param {string} objectId */
  constructor(objectId) {
    this.objectId = objectId;
  }
}

/** Chrome could not find the context, so the command never ran: the only error worth one retry with a new world.
 * Not "Execution context was destroyed" (the script may have run in part), and never an exception the page script
 * threw (script_error, whatever its text says): re-running either could repeat its effects.
 * @param {unknown} e */
const contextNotFound = (e) => e instanceof SdkError && e.code === 'cdp_error' && /Cannot find context with specified id/i.test(e.message);

export class Worlds {
  /** @param {import('./cdp.js').CdpClient} client @param {import('./frames.js').FrameTree} tree */
  constructor(client, tree) {
    this.client = client;
    this.tree = tree;
    /** @type {Map<string, World>} */
    this.cache = new Map();
  }

  /**
   * Send a command that acts in a frame document, but only if the stamp still holds at the moment of sending: what
   * is already known to be stale is never sent (a result discarded afterwards cannot undo what the script did).
   * Synchronous up to the send, so no event can be handled between the check and the send. It narrows the race; it
   * cannot close it (Chrome may replace the document before the command arrives).
   * @param {Stamp} stamp @param {string} method @param {Record<string, any>} params @param {'no_frame' | 'stale_ref'} code
   */
  #send(stamp, method, params, code) {
    if (!this.tree.same(stamp)) {
      return Promise.reject(new SdkError(code, `frame ${stamp.frameId} has changed (navigated, document replaced or changed process); ${method} not sent; take a new snapshot`));
    }
    return this.client.call(method, params, stamp.sessionId);
  }

  /** The current stamp of a frame, or a stale/no_frame error. @param {string} frameId */
  stampOf(frameId) {
    const s = this.tree.stamp(frameId);
    if (!s) throw new SdkError('no_frame', `frame ${frameId} is gone or is changing process; take a new snapshot`);
    return s;
  }

  /** The isolated world of the frame's current document, created when needed. @param {string} frameId @returns {Promise<World>} */
  async world(frameId) {
    const stamp = this.stampOf(frameId);
    const cached = this.cache.get(frameId);
    if (cached && sameStamp(cached.stamp, stamp) && this.tree.same(cached.stamp)) return cached;
    this.cache.delete(frameId);
    let r;
    try {
      r = await this.#send(stamp, 'Page.createIsolatedWorld', { frameId, worldName: `w${randomBytes(6).toString('hex')}` }, 'no_frame');
    } catch (e) {
      if (e instanceof SdkError && e.code === 'cdp_error') throw new SdkError('world_unavailable', `no isolated world in frame ${frameId} (${e.message}); not using the main world`);
      throw e;
    }
    // A reply that arrives after the frame changed belongs to the old document: discard it.
    if (!this.tree.same(stamp)) throw new SdkError('no_frame', `frame ${frameId} changed while its isolated world was being created; take a new snapshot`);
    if (!Number.isInteger(r?.executionContextId)) throw new SdkError('world_unavailable', `Page.createIsolatedWorld returned no context in frame ${frameId}`);
    /** @type {World} */
    const w = { stamp, contextId: r.executionContextId };
    this.cache.set(frameId, w);
    return w;
  }

  /** Run fn (a function, or the source text of one) in the frame's isolated world with JSON-able args; returns its
   * JSON-able result. A context Chrome cannot find is recreated once (the script had not run).
   * @param {string} frameId @param {Function | string} fn @param {unknown[]} [args] */
  async run(frameId, fn, args = []) {
    for (let attempt = 0; ; attempt++) {
      const w = await this.world(frameId);
      try {
        return await this.#call(w, fn, args);
      } catch (e) {
        if (attempt === 0 && contextNotFound(e)) {
          this.cache.delete(frameId);
          continue;
        }
        throw e;
      }
    }
  }

  /** @param {World} w @param {Function | string} fn @param {unknown[]} args */
  async #call(w, fn, args) {
    const expression = `(${String(fn)})(...${JSON.stringify(args)})`;
    const r = await this.#send(w.stamp, 'Runtime.evaluate', { expression, contextId: w.contextId, returnByValue: true, awaitPromise: true }, 'no_frame');
    if (!this.tree.same(w.stamp)) throw new SdkError('no_frame', `frame ${w.stamp.frameId} changed while a script ran in it; result discarded`);
    return unwrap(r);
  }

  /** A remote object for a DOM node, in the frame's isolated world. @param {Stamp} stamp @param {number} backendNodeId */
  async resolve(stamp, backendNodeId) {
    const w = await this.world(stamp.frameId);
    if (!sameStamp(w.stamp, stamp)) throw new SdkError('stale_ref', 'the frame has changed since this ref was taken; take a new snapshot');
    let r;
    try {
      r = await this.#send(stamp, 'DOM.resolveNode', { backendNodeId, executionContextId: w.contextId }, 'stale_ref');
    } catch (e) {
      if (e instanceof SdkError && e.code === 'cdp_error') throw new SdkError('stale_ref', `the node is gone (${e.message}); take a new snapshot`);
      throw e;
    }
    if (!this.tree.same(stamp)) throw new SdkError('stale_ref', 'the frame changed while the node was being resolved; take a new snapshot');
    return /** @type {string} */ (r.object.objectId);
  }

  /** Call fn with `this` = the node object; args are JSON values, or Handles of objects in the same world.
   * @param {Stamp} stamp @param {string} objectId @param {Function | string} fn @param {unknown[]} [args] */
  async callOn(stamp, objectId, fn, args = []) {
    const r = await this.#send(stamp, 'Runtime.callFunctionOn', {
      objectId, functionDeclaration: String(fn), returnByValue: true, awaitPromise: true,
      arguments: args.map((a) => (a instanceof Handle ? { objectId: a.objectId } : { value: a })),
    }, 'stale_ref');
    if (!this.tree.same(stamp)) throw new SdkError('stale_ref', 'the frame changed while a script ran on the node; result discarded');
    return unwrap(r);
  }

  /** @param {Stamp} stamp @param {string} objectId */
  async release(stamp, objectId) {
    await this.client.call('Runtime.releaseObject', { objectId }, stamp.sessionId).catch(() => {});
  }
}

/** @param {Stamp} a @param {Stamp} b */
function sameStamp(a, b) {
  return a.frameId === b.frameId && a.sessionId === b.sessionId && a.sessionGen === b.sessionGen && a.documentGen === b.documentGen;
}

/** @param {any} r */
function unwrap(r) {
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new SdkError('script_error', `script failed: ${d.exception?.description ?? d.text ?? 'exception'}`.slice(0, 500));
  }
  return r.result?.value;
}
