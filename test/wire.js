// @ts-check
// A scripted CDP peer for the SDK unit tests (test/sdk.test.js, test/sdk-input.test.js), with helpers.

import assert from 'node:assert/strict';
import { CdpClient, SdkError } from '../src/sdk/cdp.js';
import { Tab } from '../src/sdk/index.js';

export const ROOT = 'ROOT';
export const MAIN = 'MAIN';

/** @typedef {(params: Record<string, any>, sessionId: string | null) => any} Handler */

/** A scripted CDP peer: answers by handler (asynchronously, like a socket), can hold replies and inject events. */
export class Wire {
  constructor() {
    /** @type {{ id: number, method: string, params: Record<string, any>, sessionId: string | null }[]} */
    this.sent = [];
    /** @type {Map<string, Handler>} */
    this.handlers = new Map();
    /** @type {Set<string>} methods whose replies are held until release() */
    this.holding = new Set();
    /** @type {{ method: string, deliver: () => void }[]} */
    this.held = [];
    this.ctx = 0;
    /** frame trees per session @type {Map<string, any>} */
    this.trees = new Map([[ROOT, { frame: { id: MAIN, url: 'https://a.test/' } }]]);
    /** AX nodes per frame @type {Map<string, any[]>} */
    this.ax = new Map();
    /** frameId owned by an iframe element's backendNodeId @type {Map<number, string>} */
    this.owners = new Map();
    this.client = new CdpClient({ send: (t) => this.#recv(JSON.parse(t)), close() {} });
    const ok = () => ({});
    this.on('Target.attachToTarget', () => ({ sessionId: ROOT }));
    this.on('Page.enable', ok);
    this.on('Network.enable', ok);
    this.on('Target.setAutoAttach', ok);
    this.on('Page.getFrameTree', (_, sid) => ({ frameTree: this.trees.get(String(sid)) ?? { frame: { id: `F-${sid}`, url: '' } } }));
    this.on('Page.createIsolatedWorld', () => ({ executionContextId: ++this.ctx }));
    this.on('Runtime.evaluate', () => ({ result: { type: 'string', value: 'ran' } }));
    this.on('Accessibility.getFullAXTree', (p) => ({ nodes: this.ax.get(p.frameId) ?? [] }));
    this.on('DOM.describeNode', (p) => ({ node: { frameId: this.owners.get(p.backendNodeId) } }));
    this.on('DOM.resolveNode', (p) => ({ object: { objectId: `obj-${p.backendNodeId}` } }));
    this.on('Runtime.callFunctionOn', () => ({ result: { value: true } }));
    this.on('Runtime.releaseObject', ok);
    this.on('Page.navigate', () => ({ frameId: MAIN, loaderId: 'L2' }));
  }

  /** @param {string} method @param {Handler} fn */
  on(method, fn) {
    this.handlers.set(method, fn);
  }

  /** @param {{ id: number, method: string, params: Record<string, any>, sessionId?: string }} msg */
  #recv(msg) {
    const sid = msg.sessionId ?? null;
    this.sent.push({ id: msg.id, method: msg.method, params: msg.params, sessionId: sid });
    const deliver = () => {
      const h = this.handlers.get(msg.method);
      let body;
      try {
        body = h ? { id: msg.id, result: h(msg.params, sid) } : { id: msg.id, error: { code: -32601, message: `${msg.method} not scripted` } };
      } catch (e) {
        body = { id: msg.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } };
      }
      this.client.receive(JSON.stringify(sid ? { ...body, sessionId: sid } : body));
    };
    if (this.holding.has(msg.method)) this.held.push({ method: msg.method, deliver });
    else setImmediate(deliver);
  }

  /** Deliver held replies of a method (all of them by default). @param {string} method */
  release(method) {
    const mine = this.held.filter((h) => h.method === method);
    this.held = this.held.filter((h) => h.method !== method);
    this.holding.delete(method);
    for (const h of mine) h.deliver();
  }

  /** @param {string} method @param {Record<string, any>} params @param {string | null} [sessionId] */
  event(method, params, sessionId = ROOT) {
    this.client.receive(JSON.stringify(sessionId ? { method, params, sessionId } : { method, params }));
  }

  /** @param {string} method */
  count(method) {
    return this.sent.filter((m) => m.method === method).length;
  }

  /** Announce an OOPIF child session for frameId. @param {string} child @param {string} frameId @param {string} [on] */
  attach(child, frameId, on = ROOT) {
    this.trees.set(child, { frame: { id: frameId, parentId: MAIN, url: `https://${frameId}.test/` } });
    this.event('Target.attachedToTarget', { sessionId: child, targetInfo: { targetId: frameId, type: 'iframe', url: `https://${frameId}.test/` }, waitingForDebugger: false }, on);
  }
}

/** An AX tree: a root with the given children (each [role, name, backendNodeId?]). @param {string} frameId @param {[string, string, number?][]} kids */
export function axDoc(frameId, kids) {
  /** @type {Record<string, any>[]} */
  const nodes = [{ nodeId: `${frameId}-root`, role: { value: 'RootWebArea' }, name: { value: frameId }, childIds: kids.map((_, i) => `${frameId}-${i}`), backendDOMNodeId: 1, frameId }];
  kids.forEach(([role, name, backend], i) => {
    /** @type {Record<string, any>} */
    const n = { nodeId: `${frameId}-${i}`, parentId: `${frameId}-root`, role: { value: role }, name: { value: name }, childIds: [] };
    if (backend !== undefined) n.backendDOMNodeId = backend;
    nodes.push(n);
  });
  return nodes;
}

export const tick = () => new Promise((r) => setImmediate(r));

/** @param {Wire} w */
export async function open(w) {
  const tab = await Tab.attach(w.client, 'T1');
  await tab.settled();
  return tab;
}

/** The ref a snapshot gave the node with this name. @param {Tab} tab @param {{ refs: { ref: string, name: string }[] }} snap @param {string} name */
export function refOf(tab, snap, name) {
  const r = snap.refs.find((x) => x.name === name);
  assert.ok(r, `a ref for ${name}`);
  return r.ref;
}

/** @param {() => unknown} fn @param {string} code */
export async function rejectsWith(fn, code) {
  await assert.rejects(async () => fn(), (e) => e instanceof SdkError && e.code === code);
}
