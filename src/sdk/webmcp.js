// @ts-check
// WebMCP: the tools a page registers with document.modelContext / navigator.modelContext, listed and called through
// Chrome's experimental CDP WebMCP domain (no script runs in the page's main world).
//
// Measured in Chrome for Testing 156: the domain exists only with the WebMCP feature on (chrome://flags, or
// --enable-features=WebMCPTesting,DevToolsWebMCPSupport); without it WebMCP.enable succeeds and reports nothing.
// WebMCP.enable replays toolsAdded for the tools already registered. invokeTool answers an invocationId at once;
// the result comes later as toolResponded (Completed / Canceled / Error). A tool that waits for a person (an
// approval card on the page) simply has not responded yet.
//
// A tool is named by a handle (w<list>.<n>) bound to its frame's document and to that one registration, like a ref:
// the main page and an iframe can register tools of the same name, and a page can remove a tool and register another
// one under the same name (both reproduced in Chrome for Testing). List numbers are never reused
// for a tab, across Tab objects and MCP workers too. An invocation is bound to the frame document it was sent to: once that changes,
// its outcome is unknown (the page may have acted) and it is never sent again.

import { SdkError } from './cdp.js';

/** @typedef {import('./frames.js').Stamp} Stamp */
/** @typedef {{ name: string, description: string, inputSchema?: any, annotations?: Record<string, boolean>, frameId: string }} Tool */
/** a registered tool, the frame document it was registered in (null: the frame was not known yet; bound when listed)
 * and its registration number: a tool removed and registered again under the same name is another registration
 * @typedef {{ tool: Tool, stamp: Stamp | null, reg: number, toolId: string | null }} Registered */
/** @typedef {{ handle: string, stamp: Stamp, name: string, reg: number }} ToolHandle */
/** @typedef {{ status: string, output?: any, errorText?: string, exception?: string }} Outcome */
/** @typedef {{ id: string, stamp: Stamp, name: string, at: number, outcome: Outcome | null, waiters: Set<(o: Outcome) => void> }} Invocation */

const KEEP_LISTS = 3;
const MAX_INVOCATIONS = 20; // kept for wait; the oldest finished ones go first
const KEEP_MS = 10 * 60_000;

export class WebMcp {
  /** @param {import('./index.js').Tab} tab */
  constructor(tab) {
    this.tab = tab;
    /** sessions WebMCP.enable was sent on @type {Set<string>} */
    this.enabled = new Set();
    /** registered tools by frameId, then name @type {Map<string, Map<string, Registered>>} */
    this.tools = new Map();
    /** registrations seen so far (Registered.reg) */
    this.regs = 0;
    /** @type {Map<string, ToolHandle>} */
    this.handles = new Map();
    /** @type {Map<string, Invocation>} */
    this.invocations = new Map();
    /** outcomes that arrived before invokeTool's own answer (the extension relays events and answers separately, so
     * the PDL's "answer before events" does not hold here; measured once in CfT) @type {Map<string, Outcome>} */
    this.early = new Map();
    this.unsubscribe = tab.client.onEvent((ev) => this.#onEvent(ev));
  }

  /** @param {import('./cdp.js').CdpEvent} ev */
  #onEvent(ev) {
    if (!ev.method.startsWith('WebMCP.') || !ev.sessionId || !this.tab.tree.knows(ev.sessionId)) return;
    const p = ev.params ?? {};
    if (ev.method === 'WebMCP.toolsAdded') {
      for (const t of Array.isArray(p.tools) ? p.tools : []) {
        if (typeof t?.name !== 'string' || typeof t.frameId !== 'string') continue;
        const byName = this.tools.get(t.frameId) ?? new Map();
        const tool = { name: t.name, description: String(t.description ?? ''), inputSchema: t.inputSchema, annotations: t.annotations, frameId: t.frameId };
        const toolId = typeof t.toolId === 'string' ? t.toolId : null;
        const was = byName.get(t.name);
        const now = this.tab.tree.stamp(t.frameId);
        // the same registration announced again (WebMCP.enable replays the registered tools; a page cannot register a
        // name twice without removing it) keeps its number; anything else is a new registration. A reload of the same
        // page registers the same names in a new document with no toolsRemoved before it (CfT 156): another
        // document is always a new registration
        const sameDoc = !!was && (!was.stamp || !now || (was.stamp.sessionId === now.sessionId && was.stamp.sessionGen === now.sessionGen
          && was.stamp.documentGen === now.documentGen));
        const same = was && sameDoc && (toolId !== null ? was.toolId === toolId : was.toolId === null);
        byName.set(t.name, { tool, stamp: same ? was.stamp : now, reg: same ? was.reg : ++this.regs, toolId });
        this.tools.set(t.frameId, byName);
      }
    } else if (ev.method === 'WebMCP.toolsRemoved') {
      for (const t of Array.isArray(p.tools) ? p.tools : []) this.tools.get(String(t?.frameId))?.delete(String(t?.name));
    } else if (ev.method === 'WebMCP.toolResponded') {
      const inv = this.invocations.get(String(p.invocationId));
      if (inv?.outcome) return;
      /** @type {Outcome} */ const o = { status: String(p.status ?? 'Error') };
      if (p.output !== undefined) o.output = p.output;
      if (typeof p.errorText === 'string') o.errorText = p.errorText;
      if (p.exception) {
        o.exception = String(p.exception.description ?? p.exception.value ?? 'exception').slice(0, 2000);
        if (p.exception.objectId) this.tab.client.call('Runtime.releaseObject', { objectId: p.exception.objectId }, ev.sessionId).catch(() => {});
      }
      if (!inv) {
        this.early.set(String(p.invocationId), o);
        if (this.early.size > MAX_INVOCATIONS) this.early.delete(/** @type {string} */ (this.early.keys().next().value));
        return;
      }
      inv.outcome = o;
      for (const w of inv.waiters) w(o);
      inv.waiters.clear();
    }
  }

  /** WebMCP.enable on every live session of the tab not enabled yet (a child frame's session arrives later).
   * unsupported when Chrome has no such domain. */
  async #enable() {
    const sids = [...this.tab.tree.sessions.values()].filter((s) => s.alive && !this.enabled.has(s.sid)).map((s) => s.sid);
    await Promise.all(sids.map(async (sid) => {
      try {
        await this.tab.client.call('WebMCP.enable', {}, sid);
        this.enabled.add(sid);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/wasn't found|not found|unknown method/i.test(msg) && sid === this.tab.sessionId) {
          throw new SdkError('unsupported', `this Chrome has no WebMCP debugging support (${msg.slice(0, 120)}); turn on WebMCP in chrome://flags and restart Chrome`);
        }
        if (sid === this.tab.sessionId) throw e; // a child that went away meanwhile is simply not listed
      }
    }));
  }

  /** The tools registered now, each with a handle; `skip`: frames not to list (site policy).
   * @param {{ skip?: Set<string> }} [o] */
  async list({ skip = new Set() } = {}) {
    await this.tab.settled();
    await this.#enable();
    await this.tab.input.sleep(50); // the replayed toolsAdded come with (or right after) the enable answer
    const seq = ++this.tab.webmcpSeq; // never reused for this tab, also across Tab objects and workers (webmcpSeq)
    /** @type {(Tool & { handle: string })[]} */ const out = [];
    for (const f of this.tab.tree.order()) {
      if (skip.has(f.id)) continue;
      const stamp = this.tab.tree.stamp(f.id);
      if (!stamp) continue;
      for (const [name, r] of this.tools.get(f.id) ?? []) {
        r.stamp ??= stamp;
        // registered by a document the frame has since left (no toolsRemoved came): not offered any more
        if (!this.tab.tree.same(r.stamp) || r.stamp.documentGen !== stamp.documentGen || r.stamp.sessionId !== stamp.sessionId) {
          this.tools.get(f.id)?.delete(name);
          continue;
        }
        const handle = `w${seq}.${out.length + 1}`;
        this.handles.set(handle, { handle, stamp, name, reg: r.reg });
        out.push({ ...r.tool, handle });
      }
    }
    for (const h of [...this.handles.keys()]) if (Number(h.slice(1, h.indexOf('.'))) <= seq - KEEP_LISTS) this.handles.delete(h);
    return out;
  }

  /** @param {string} handle */
  entry(handle) {
    const h = this.handles.get(handle);
    if (!h) throw new SdkError('stale_ref', `unknown tool ${handle} (not from one of the last ${KEEP_LISTS} lists); list the tools again`);
    if (!this.tab.tree.same(h.stamp)) throw new SdkError('stale_ref', `tool ${handle}: its frame has navigated or gone away; list the tools again`);
    const r = this.tools.get(h.stamp.frameId)?.get(h.name);
    if (!r) throw new SdkError('stale_ref', `tool ${handle}: the page no longer offers it; list the tools again`);
    if (r.reg !== h.reg) throw new SdkError('stale_ref', `tool ${handle}: the page removed it and registered another tool under the same name; list the tools again`);
    return h;
  }

  /** What the page registered for a handle (name, description, schema, annotations): page content. @param {string} handle */
  tool(handle) {
    const h = this.entry(handle);
    return /** @type {Registered} */ (this.tools.get(h.stamp.frameId)?.get(h.name)).tool;
  }

  /**
   * Call a tool. Answers its outcome if it responds within timeoutMs; else status "waiting" with the invocation id
   * (the page may be waiting for the user, e.g. an approval on the page), to be collected with wait().
   * approvalId: the user's Allow in the K-Browser panel for exactly this call (a tool the site marks consequential;
   * the bridge checks and uses it up, src/relay.js #checkInvoke).
   * @param {string} handle @param {Record<string, any>} args @param {{ timeoutMs?: number, approvalId?: string }} [o]
   */
  async call(handle, args, { timeoutMs = 30_000, approvalId } = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new SdkError('bad_argument', 'args: an object matching the tool\'s inputSchema');
    const h = this.entry(handle);
    this.#prune();
    if ([...this.invocations.values()].filter((i) => !i.outcome).length >= MAX_INVOCATIONS) {
      throw new SdkError('unsupported', `${MAX_INVOCATIONS} tool calls are still waiting on this tab; wait for them first`);
    }
    if (!this.tab.tree.same(h.stamp)) throw new SdkError('stale_ref', `tool ${handle}: its frame changed; list the tools again`);
    let r;
    try {
      r = await this.tab.client.call('WebMCP.invokeTool', { frameId: h.stamp.frameId, toolName: h.name, input: args, ...(approvalId ? { kbApprovalId: approvalId } : {}) },
        h.stamp.sessionId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // the bridge refused it before Chrome saw it: certainly not called
      if (/nothing was called|has not seen this tool/.test(msg)) throw new SdkError('unsupported', msg.replace(/^WebMCP\.invokeTool: /, ''));
      if (/not found/i.test(msg)) throw new SdkError('stale_ref', `tool ${handle}: the page no longer offers it (${msg.slice(0, 120)})`);
      throw new SdkError('result_unknown', `the call to ${handle} may or may not have reached the page (${msg.slice(0, 200)}); list and check the page before calling again`);
    }
    const id = String(r?.invocationId ?? '');
    if (!id) throw new SdkError('result_unknown', `the call to ${handle} got no invocation id; check the page before calling again`);
    /** @type {Invocation} */
    const inv = { id, stamp: h.stamp, name: h.name, at: Date.now(), outcome: this.early.get(id) ?? null, waiters: new Set() };
    this.early.delete(id);
    this.invocations.set(id, inv);
    return this.#await(inv, timeoutMs);
  }

  /** The outcome of an earlier call, waiting up to timeoutMs more. @param {string} invocationId @param {{ timeoutMs?: number }} [o] */
  wait(invocationId, { timeoutMs = 30_000 } = {}) {
    const inv = this.invocations.get(invocationId);
    if (!inv) throw new SdkError('bad_argument', `no tool call ${JSON.stringify(invocationId)} on this tab (finished ones are kept ${KEEP_MS / 60_000} minutes)`);
    return this.#await(inv, timeoutMs);
  }

  /** @param {Invocation} inv @param {number} timeoutMs */
  async #await(inv, timeoutMs) {
    const head = { invocationId: inv.id, tool: inv.name };
    const outcome = inv.outcome ?? await new Promise((resolve) => {
      /** @param {Outcome | null} o */
      const done = (o) => { clearInterval(watch); clearTimeout(timer); inv.waiters.delete(done); resolve(o); };
      // the frame changed (navigated, replaced, closed): the page may have done it, nobody will answer
      const watch = setInterval(() => { if (this.#lost(inv)) done(null); }, 200);
      const timer = setTimeout(() => done(null), Math.max(0, Math.min(timeoutMs, 600_000)));
      inv.waiters.add(done);
    });
    if (outcome) return { ...head, ...outcome };
    if (this.#lost(inv)) {
      this.invocations.delete(inv.id);
      throw new SdkError('result_unknown', `the page of tool call ${inv.id} (${inv.name}) navigated or went away before it answered: it may or may not have acted; read the page, never call it again blindly`);
    }
    return { ...head, status: 'waiting' };
  }

  /** Nobody will answer this call any more: its frame changed, the tab went away, or the connection to K-Browser closed.
   * @param {Invocation} inv */
  #lost(inv) {
    return !this.tab.tree.same(inv.stamp) || Boolean(this.tab.gone) || Boolean(this.tab.client.closedWhy);
  }

  #prune() {
    const now = Date.now();
    for (const [id, i] of this.invocations) if (i.outcome && now - i.at > KEEP_MS) this.invocations.delete(id);
    const done = [...this.invocations.values()].filter((i) => i.outcome);
    while (this.invocations.size > MAX_INVOCATIONS * 2 && done.length) this.invocations.delete(/** @type {Invocation} */ (done.shift()).id);
  }

  close() {
    this.unsubscribe();
  }
}
