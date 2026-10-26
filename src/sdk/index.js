// @ts-check
// The K-Browser SDK: an ordinary CDP client of the bridge (its own client token, /c/<token>), with no back door: it
// can do only what the bridge's policy lets any client do.
//
// Footprint: no Runtime.enable, no script injected into the page's main world, no DOM marks.
// Page scripts the SDK runs live in per-document isolated worlds (world.js).
//
//   const browser = await Browser.connect('http://127.0.0.1:9444/c/<token>');
//   const tab = await browser.newTab('https://example.com');
//   const snap = await tab.snapshot();          // text with refs like [s1.3]
//   const text = await tab.read('s1.3');
//   await tab.click('s1.4');                    // human-like, trusted input; re-checked right before the press

import * as act from './act.js';
import { CdpClient, SdkError } from './cdp.js';
import { waitFor } from './evidence.js';
import { FrameTree } from './frames.js';
import { Input } from './input.js';
import { takeSnapshot } from './snapshot.js';
import { Worlds } from './world.js';

export { SdkError } from './cdp.js';

const NAV_TIMEOUT_MS = 30_000;
const KEEP_SNAPSHOTS = 5; // refs of this many recent snapshots stay resolvable (if their frames are unchanged)
const READ_MAX = 20_000;

/** @typedef {{ id: string, type: string, message: string, defaultPrompt: string, url: string, sessionId: string }} Dialog */

export class Browser {
  /** @param {CdpClient} client */
  constructor(client) {
    this.client = client;
  }

  /** @param {string} endpoint http://127.0.0.1:9444/c/<token> */
  static async connect(endpoint) {
    return new Browser(await CdpClient.connect(endpoint));
  }

  /** Open a background tab in the K-Browser window and attach to it. @param {string} [url] */
  async newTab(url = 'about:blank') {
    const { targetId } = await this.client.call('Target.createTarget', { url: 'about:blank', background: true });
    const tab = await Tab.attach(this.client, targetId);
    if (url !== 'about:blank') await tab.goto(url);
    return tab;
  }

  close() {
    this.client.close();
  }
}

export class Tab {
  /** @param {CdpClient} client @param {string} targetId */
  static async attach(client, targetId) {
    const { sessionId } = await client.call('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(client, targetId, sessionId);
    await tab.#setUp(sessionId);
    return tab;
  }

  /** @param {CdpClient} client @param {string} targetId @param {string} sessionId */
  constructor(client, targetId, sessionId) {
    this.client = client;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.tree = new FrameTree(sessionId);
    this.worlds = new Worlds(client, this.tree);
    this.input = new Input(client, sessionId);
    /** @type {string | null} why the tab can no longer be used */
    this.gone = null;
    /** @type {Set<Promise<void>>} child sessions being set up */
    this.setups = new Set();
    this.snapshotSeq = 0;
    /** @type {Map<string, import('./snapshot.js').RefEntry>} */
    this.refs = new Map();
    /** the JavaScript dialog open now, from any of the tab's sessions @type {Dialog | null} */
    this.dialog = null;
    this.dialogSeq = 0;
    /** @type {Set<(d: Dialog) => void>} */
    this.dialogListeners = new Set();
    this.unsubscribe = client.onEvent((ev) => this.#onEvent(ev));
  }

  /** @param {import('./cdp.js').CdpEvent} ev */
  #onEvent(ev) {
    if (ev.sessionId === null) {
      if (ev.method === 'Target.detachedFromTarget' && ev.params.sessionId === this.sessionId) this.gone ??= 'the tab was detached';
      else if (ev.method === 'Target.targetDestroyed' && ev.params.targetId === this.targetId) this.gone ??= 'the tab was closed';
      else if (ev.method !== 'Target.detachedFromTarget') return;
    } else if (!this.tree.knows(ev.sessionId)) {
      return;
    } else if (ev.method === 'Page.javascriptDialogOpening') {
      // Comes on its own, while the command that caused it is still waiting for its reply.
      const p = ev.params;
      /** @type {Dialog} */
      const d = { id: `d${++this.dialogSeq}`, type: String(p.type ?? ''), message: String(p.message ?? ''), defaultPrompt: String(p.defaultPrompt ?? ''),
        url: String(p.url ?? ''), sessionId: ev.sessionId };
      this.dialog = d;
      this.input.dialogOpened();
      for (const fn of [...this.dialogListeners]) {
        try { fn(d); } catch { /* one listener's bug must not hide the dialog from others */ }
      }
      return;
    } else if (ev.method === 'Page.javascriptDialogClosed') {
      if (this.dialog?.sessionId === ev.sessionId) this.dialog = null;
      if (!this.dialog) this.input.dialogClosed();
      return;
    }
    const child = this.tree.onEvent(ev);
    if (child) {
      const p = this.#setUp(child).catch(() => {}); // a child that goes away mid-setup is simply gone
      this.setups.add(p);
      void p.finally(() => this.setups.delete(p));
    }
  }

  /** Page events, the initial frame tree, then auto-attach (each child session repeats this for its own children:
   * auto-attach does not recurse by itself). @param {string} sid */
  async #setUp(sid) {
    await this.client.call('Page.enable', {}, sid);
    // the bridge records only what a session has enabled (observe.js): the evidence contract needs the network
    await this.client.call('Network.enable', {}, sid);
    this.tree.treeRequested();
    let r;
    try {
      r = await this.client.request('Page.getFrameTree', {}, sid);
    } catch (e) {
      this.tree.treeFailed();
      throw e;
    }
    this.tree.applyFrameTree(sid, r.result.frameTree, r.seq);
    await this.client.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }] }, sid);
  }

  /** Wait until every child session announced so far is set up. */
  async settled() {
    while (this.setups.size) await Promise.all([...this.setups]);
  }

  #alive() {
    if (this.gone) throw new SdkError('disconnected', this.gone);
  }

  /** Wait for an event matching pred that arrives after now. @param {(e: import('./cdp.js').CdpEvent) => boolean} pred @param {number} timeoutMs */
  #nextEvent(pred, timeoutMs) {
    /** @type {() => void} */ let off = () => {};
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let timer;
    const p = new Promise((resolve, reject) => {
      off = this.client.onEvent((e) => { if (pred(e)) resolve(e); });
      timer = setTimeout(() => reject(new SdkError('timeout', `no matching event within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    });
    return { promise: p.finally(() => { off(); clearTimeout(timer); }), cancel: () => { off(); clearTimeout(timer); } };
  }

  /** Navigate the main frame and wait for its load event. @param {string} url @param {{ timeoutMs?: number }} [o] */
  async goto(url, { timeoutMs = NAV_TIMEOUT_MS } = {}) {
    this.#alive();
    const load = this.#nextEvent((e) => e.method === 'Page.loadEventFired' && e.sessionId === this.sessionId, timeoutMs);
    load.promise.catch(() => {});
    let r;
    try {
      // the timeout bounds the command too: Page.navigate itself waits while a server sends no response headers
      r = await this.client.call('Page.navigate', { url }, this.sessionId, { timeoutMs });
    } catch (e) {
      load.cancel();
      throw e;
    }
    if (r.errorText) {
      load.cancel();
      throw new SdkError('navigation_failed', `navigation to ${url} failed: ${r.errorText}`);
    }
    if (!r.loaderId) {
      load.cancel(); // same-document navigation: no load event
      return;
    }
    await load.promise;
    await this.settled();
  }

  /** Reload the main frame and wait for its load event. @param {{ ignoreCache?: boolean, timeoutMs?: number }} [o] */
  async reload({ ignoreCache = false, timeoutMs = NAV_TIMEOUT_MS } = {}) {
    this.#alive();
    const load = this.#nextEvent((e) => e.method === 'Page.loadEventFired' && e.sessionId === this.sessionId, timeoutMs);
    load.promise.catch(() => {});
    try {
      await this.client.call('Page.reload', { ignoreCache }, this.sessionId, { timeoutMs });
    } catch (e) {
      load.cancel();
      throw e;
    }
    await load.promise;
    await this.settled();
  }

  /**
   * Rows of the main frame (only: frames are not searched in v1) matching a CSS selector, in the isolated world. fields: { name: spec }, spec = "sub selector",
   * "sub selector@attribute", "@attribute" or "" (the row's text). The selector and specs are data (arguments), never
   * code. A password field's value is never read. @param {string} selector @param {Record<string, string> | null} fields
   * @param {{ max?: number, maxBytes?: number }} [o]
   */
  async query(selector, fields, { max = 50, maxBytes = 100_000 } = {}) {
    this.#alive();
    /** @param {string} sel @param {Record<string, string> | null} spec @param {number} max @param {number} maxBytes */
    function run(sel, spec, max, maxBytes) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch {
        return { error: 'bad_selector' };
      }
      // by localName and type, not tagName: an XHTML page's tag names are lowercase
      const secret = (/** @type {any} */ el) => Boolean(el) && String(el.localName ?? '').toLowerCase() === 'input'
        && [el.type, el.getAttribute?.('type')].some((t) => String(t ?? '').toLowerCase() === 'password');
      const text = (/** @type {any} */ el) => (secret(el) ? '' : String(el.innerText ?? el.textContent ?? '').trim());
      /** @param {any} row @param {string} s */
      const pick = (row, s) => {
        const at = s.lastIndexOf('@');
        const attr = at >= 0 && /^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(s.slice(at + 1)) ? s.slice(at + 1) : null;
        const subSel = (attr ? s.slice(0, at) : s).trim();
        let el;
        try {
          el = subSel ? row.querySelector(subSel) : row;
        } catch {
          return null;
        }
        if (!el) return null;
        if (!attr) return text(el);
        if (attr.toLowerCase() === 'value') return secret(el) ? null : typeof el.value === 'string' ? el.value : el.getAttribute('value');
        return el.getAttribute(attr);
      };
      const rows = [];
      let bytes = 0;
      for (const row of Array.from(nodes)) {
        if (rows.length >= max) break;
        const r = spec ? Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, pick(row, String(v))])) : text(row);
        bytes += new TextEncoder().encode(JSON.stringify(r)).length; // UTF-8 bytes, not UTF-16 units
        if (bytes > maxBytes) break;
        rows.push(r);
      }
      return { rows, total: nodes.length };
    }
    const r = await this.worlds.run(this.#main(), run, [selector, fields, max, maxBytes]);
    if (r?.error) throw new SdkError('bad_argument', `not a valid CSS selector: ${selector.slice(0, 200)}`);
    return { rows: r.rows, total: r.total, truncated: r.rows.length < r.total };
  }

  /** The accessibility snapshot of every frame, with refs for interactive nodes (or every node with full: true).
   * `hide`: frames (ids) to leave out entirely. @param {{ full?: boolean, maxLines?: number, maxBytes?: number, hide?: Set<string> }} [o] */
  async snapshot(o = {}) {
    this.#alive();
    await this.settled();
    const seq = ++this.snapshotSeq;
    const snap = await takeSnapshot(this, { ...o, seq });
    for (const r of snap.refs) this.refs.set(r.ref, r);
    const oldest = seq - KEEP_SNAPSHOTS;
    for (const key of [...this.refs.keys()]) if (Number(key.slice(1, key.indexOf('.'))) <= oldest) this.refs.delete(key);
    return snap;
  }

  /** The ref's entry if it still names the same node in the same document, else stale_ref. @param {string} ref */
  entry(ref) {
    const e = this.refs.get(ref);
    if (!e) throw new SdkError('stale_ref', `unknown ref ${ref} (not from one of this tab's last ${KEEP_SNAPSHOTS} snapshots); take a new snapshot`);
    if (!this.tree.same(e.stamp)) throw new SdkError('stale_ref', `ref ${ref}: its frame has navigated, changed process or gone away; take a new snapshot`);
    return e;
  }

  /** Run fn with `this` = the ref's node, in the isolated world. @param {string} ref @param {Function | string} fn @param {unknown[]} [args] */
  async onNode(ref, fn, args = []) {
    this.#alive();
    const e = this.entry(ref);
    const objectId = await this.worlds.resolve(e.stamp, e.backendNodeId);
    try {
      const connected = await this.worlds.callOn(e.stamp, objectId, /** @this {Node} */ function () { return this.isConnected; });
      if (connected !== true) throw new SdkError('stale_ref', `ref ${ref}: the node is no longer in the document; take a new snapshot`);
      return await this.worlds.callOn(e.stamp, objectId, fn, args);
    } finally {
      await this.worlds.release(e.stamp, objectId);
    }
  }

  /** Visible text of a ref's node, or of the main frame's body. @param {string} [ref] @param {{ max?: number }} [o] */
  async read(ref, { max = READ_MAX } = {}) {
    this.#alive();
    /** @this {any} @param {number} n */
    function text(n) {
      const el = this && this.nodeType === 1 ? this : this?.parentElement ?? null;
      const node = this && this.nodeType ? this : document.body;
      // a password field's value is never read (its text is nothing: innerText of an <input> is empty)
      const secret = Boolean(el) && String(el.localName ?? '').toLowerCase() === 'input'
        && [el.type, el.getAttribute?.('type')].some((t) => String(t ?? '').toLowerCase() === 'password'); // XHTML too
      const v = el && !secret && 'value' in el && typeof el.value === 'string' && el.tagName !== 'BUTTON' ? el.value : null;
      const s = v ?? (node && 'innerText' in node ? node.innerText : node?.textContent) ?? '';
      return { text: s.slice(0, n), length: s.length };
    }
    const r = ref ? await this.onNode(ref, text, [max]) : await this.worlds.run(this.#main(), `function (n) { return (${text}).call(document.body, n); }`, [max]);
    return { text: r.text, truncated: r.length > max };
  }

  /** Run fn(...args) in a frame's isolated world (the main frame by default). @param {Function | string} fn @param {unknown[]} [args] @param {{ frameId?: string }} [o] */
  async evaluate(fn, args = [], { frameId } = {}) {
    this.#alive();
    return this.worlds.run(frameId ?? this.#main(), fn, args);
  }

  /**
   * An agent's own expression in the main frame's isolated world (MCP eval). Not a sandbox: the world shares the
   * DOM with the page, so the expression can affect the page and reach its scripts.
   * The result comes back by value; the frame changing while it runs discards it. @param {string} expression
   * @param {{ timeoutMs?: number }} [o]
   */
  async evalIsolated(expression, { timeoutMs = 5000 } = {}) {
    this.#alive();
    const w = await this.worlds.world(this.#main());
    const end = Date.now() + timeoutMs;
    const group = 'kb-eval';
    // Runtime.evaluate's timeout covers the synchronous run only, not waiting for a promise: a promise
    // result is raced against a timer in the page for the time left
    let r = await this.client.call('Runtime.evaluate', { expression, contextId: w.contextId, objectGroup: group, timeout: timeoutMs },
      w.stamp.sessionId, { timeoutMs: timeoutMs + 2000 });
    try {
      if (!r.exceptionDetails && r.result?.objectId) {
        const left = Math.max(0, end - Date.now());
        r = await this.client.call('Runtime.callFunctionOn', {
          objectId: r.result.objectId, returnByValue: true, awaitPromise: true,
          functionDeclaration: `function () { return this instanceof Promise ? Promise.race([this, new Promise((_, no) =>
            setTimeout(() => no(new Error('timed out after ${timeoutMs} ms')), ${left}))]) : this; }`,
        }, w.stamp.sessionId, { timeoutMs: left + 2000 });
      }
    } finally {
      await this.client.call('Runtime.releaseObjectGroup', { objectGroup: group }, w.stamp.sessionId).catch(() => {});
    }
    if (!this.tree.same(w.stamp)) throw new SdkError('no_frame', 'the page changed while the script ran; result discarded');
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new SdkError('script_error', `script failed: ${d.exception?.description ?? d.text ?? 'exception'}`.slice(0, 500));
    }
    return r.result?.value;
  }

  /**
   * Run an action after writing what it is into the bridge's activity record (a KBrowser.mark label: the user's side
   * panel shows it, as client-provided). Typed text is never in it, only its length. A failed label stops nothing.
   * @template T @param {string} label @param {() => Promise<T>} fn
   */
  async #labelled(label, fn) {
    this.#alive();
    await this.client.call('KBrowser.mark', { targetId: this.targetId, label: label.slice(0, 200) }).catch(() => {});
    return fn();
  }

  /** 'button "Search"' for a ref, from the snapshot it came from. @param {string} ref */
  #what(ref) {
    const e = this.refs.get(ref);
    if (!e) return ref;
    const name = e.name.replace(/\s+/g, ' ').trim();
    return `${e.role} "${name.length > 60 ? `${name.slice(0, 60)}…` : name}"`;
  }

  /** Click a ref's node. @param {string} ref @param {act.ActOptions & { clickCount?: number }} [o] */
  click(ref, o) {
    return this.#labelled(`click ${this.#what(ref)}`, () => act.click(this, ref, o));
  }

  /** @param {string} ref @param {act.ActOptions} [o] */
  dblclick(ref, o) {
    return this.#labelled(`double-click ${this.#what(ref)}`, () => act.dblclick(this, ref, o));
  }

  /** Click a field and type into it. @param {string} ref @param {string} text @param {act.ActOptions & { replace?: boolean }} [o] */
  type(ref, text, o) {
    return this.#labelled(`type into ${this.#what(ref)} (${[...String(text)].length} chars)`, () => act.type(this, ref, text, o));
  }

  /** Press a key or combination on whatever has focus. @param {string} combo @param {{ fast?: boolean }} [o] */
  key(combo, o) {
    return this.#labelled(`press ${String(combo).slice(0, 40)}`, () => act.key(this, combo, o));
  }

  /** Choose an option of a native <select>. @param {string} ref @param {{ value?: string, label?: string }} want @param {act.ActOptions} [o] */
  select(ref, want, o) {
    return this.#labelled(`select in ${this.#what(ref)}`, () => act.select(this, ref, want, o));
  }

  /** Scroll with the wheel. @param {{ ref?: string, dx?: number, dy?: number }} what @param {{ fast?: boolean }} [o] */
  scroll(what, o) {
    return this.#labelled(`scroll${what.ref ? ` ${this.#what(what.ref)}` : ''}`, () => act.scroll(this, what, o));
  }

  /** A point in the bridge's observation log to judge an action's effects from: take it before the action.
   * @param {string} [label] at most 200 characters, kept as client-provided */
  async mark(label = '') {
    this.#alive();
    return /** @type {{ actionId: string, t: number, label: string, source: 'client' }} */ (await this.client.call('KBrowser.mark', { targetId: this.targetId, label }));
  }

  /** Check the evidence contract (evidence.js): completed only if every assertion is proven.
   * @param {import('./evidence.js').Assertion[]} assertions @param {{ sinceActionId?: string, timeoutMs?: number, pollMs?: number, admit?: (entries: any[]) => Promise<any[]> }} [o] */
  waitFor(assertions, o) {
    this.#alive();
    return waitFor(this, assertions, o);
  }

  /** @param {{ format?: 'png' | 'jpeg', quality?: number }} [o] */
  async screenshot({ format = 'png', quality } = {}) {
    this.#alive();
    const r = await this.client.call('Page.captureScreenshot', { format, ...(quality ? { quality } : {}) }, this.sessionId);
    return Buffer.from(r.data, 'base64');
  }

  /** Called with every JavaScript dialog that opens in this tab. @param {(d: Dialog) => void} fn @returns {() => void} unsubscribe */
  onDialog(fn) {
    this.dialogListeners.add(fn);
    return () => this.dialogListeners.delete(fn);
  }

  /** Accept or dismiss the open dialog; `id` must name it (a closed or replaced one is stale_dialog).
   * @param {string} id @param {{ accept: boolean, promptText?: string }} o */
  async handleDialog(id, { accept, promptText }) {
    const d = this.dialog;
    if (!d || d.id !== id) throw new SdkError('stale_dialog', `dialog ${id} is not open${d ? ` (${d.id} is)` : ''}`);
    await this.client.call('Page.handleJavaScriptDialog', { accept, ...(promptText !== undefined ? { promptText } : {}) }, d.sessionId);
    if (this.dialog === d) {
      this.dialog = null;
      this.input.dialogClosed();
    }
    return { id, accepted: accept };
  }

  /** Frames as the SDK currently sees them. */
  frames() {
    return this.tree.order().map((f) => ({ frameId: f.id, parentId: f.parentId, url: f.url, owned: this.tree.stamp(f.id) !== null,
      oopif: f.sessionId !== null && f.sessionId !== this.sessionId }));
  }

  #main() {
    if (!this.tree.mainFrameId) throw new SdkError('no_frame', 'the main frame is not known yet');
    return this.tree.mainFrameId;
  }

  async close() {
    this.unsubscribe();
    if (!this.gone) await this.client.call('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
    this.gone ??= 'the tab was closed';
  }
}
