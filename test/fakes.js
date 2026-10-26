// @ts-check
// Stand-ins for the extension and a CDP client, talking to a real bridge over real websockets.

import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { mac, PROTOCOL, transcript } from '../extension/protocol.js';
import { EXTENSION_ID } from '../src/version.js';

export const ORIGIN = `chrome-extension://${EXTENSION_ID}`;
/** every fake that connected; the test harness closes them even when a test fails @type {{ close(): Promise<void> }[]} */
export const OPEN = [];

/** @param {() => boolean} pred @param {number} [ms] */
export async function until(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return pred();
}

export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** The Kav checkout tests run against: KBROWSER_TEST_KAV, or a Kav-test / kav-fastwebagent checkout next to this repo
 * (tests that need it are skipped when there is none). */
export function kavCheckout() {
  if (process.env.KBROWSER_TEST_KAV) return process.env.KBROWSER_TEST_KAV;
  const parent = path.resolve(import.meta.dirname, '..', '..');
  const near = ['Kav-test', 'kav-fastwebagent'].map((d) => path.join(parent, d));
  return near.find((d) => fs.existsSync(d)) ?? near[0];
}

/** @param {WebSocket} ws @returns {Promise<string | null>} */
const nextMessage = (ws) => new Promise((resolve) => {
  ws.once('message', (d) => resolve(d.toString()));
  ws.once('close', () => resolve(null));
});

/** Speaks the extension side of the wire protocol over a fake set of tabs. */
export class FakeExtension {
  /** @param {string} base @param {string} key @param {{ profile?: string, boot?: string, origin?: string }} [o] */
  constructor(base, key, { profile = 'profile-aaaaaaaa', boot = 'boot-aaaaaaaa', origin = ORIGIN } = {}) {
    this.base = base; this.key = key; this.profile = profile; this.boot = boot; this.origin = origin;
    /** @type {Map<number, { targetId: string, url: string, title: string, opener: number | null }>} */
    this.tabs = new Map();
    /** @type {Set<number>} */ this.owned = new Set();
    /** @type {Set<number>} tabs chrome.debugger is attached to */ this.attached = new Set();
    /** @type {[string, any][]} */ this.calls = [];
    /** @type {Set<string>} ops that never answer */ this.hang = new Set();
    /** @type {Map<string, Promise<void>>} ops that answer once their gate resolves */ this.gates = new Map();
    /** @type {Map<string, Promise<void>>} dbg.send methods that answer once their gate resolves */ this.sendGates = new Map();
    /** @type {Set<string>} dbg.send methods that fail */ this.sendFail = new Set();
    /** @type {Map<string, any>} dbg.send methods with a scripted result (Network.getResponseBody) */ this.sendResults = new Map();
    this.nextWindow = 1;
    this.bridgeProved = false;
    /** @type {any} */ this.error = null;
    /** @type {any[]} hand-offs as last synced by the bridge */ this.handoffs = [];
    /** @type {any[]} side panel batches received */ this.panel = [];
    /** @type {Promise<void> | null} */ this.panelGate = null;
    /** @type {number[]} tabs.show calls */ this.shown = [];
    /** @type {WebSocket} */ this.ws = /** @type {any} */ (null);
  }

  /** @param {{ macOverride?: string }} [o] */
  async connect({ macOverride } = {}) {
    OPEN.push(this);
    this.ws = new WebSocket(`${this.base.replace('http', 'ws')}/ext`, { headers: { Origin: this.origin } });
    this.ws.on('error', () => {});
    const helloText = await nextMessage(this.ws);
    if (!helloText) return false;
    const hello = JSON.parse(helloText);
    if (hello.t === 'error') { this.error = hello; return false; }
    const enonce = 'e'.repeat(8) + '0123456789abcdef';
    const script = transcript(hello.nonce, enonce);
    this.ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL, nonce: enonce, mac: macOverride ?? await mac(this.key, 'ext', script),
      profileId: this.profile, bootId: this.boot, userAgent: 'FakeChrome', product: 'Chrome/999' }));
    // The bridge's first command can arrive right behind welcome: install the command handler before awaiting.
    /** @type {any[]} */
    const early = [];
    let welcomed = false;
    const welcome = new Promise((resolve) => {
      this.ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (!welcomed) {
          welcomed = true;
          resolve(m);
          return;
        }
        if (m.t === 'cmd') early.push(m);
      });
      this.ws.once('close', () => resolve(null));
    });
    const m = /** @type {any} */ (await welcome);
    if (!m || m.t !== 'welcome') { this.error = m; return false; }
    this.bridgeProved = m.mac === await mac(this.key, 'bridge', script);
    this.ws.removeAllListeners('message');
    this.ws.on('message', (d) => {
      const c = JSON.parse(d.toString());
      if (c.t === 'cmd') void this.#handle(c);
    });
    for (const c of early) void this.#handle(c);
    return true;
  }

  /** @param {any} m */
  async #handle(m) {
    const { op, args = {} } = m;
    this.calls.push([op, args]);
    if (this.hang.has(op)) return;
    const gate = this.gates.get(op);
    if (gate) await gate;
    try {
      const fn = /** @type {any} */ (this)[`op_${op.replace('.', '_')}`];
      const result = await fn.call(this, args);
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'res', id: m.id, ok: true, result }));
    } catch (e) {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'res', id: m.id, ok: false, error: String(e) }));
    }
  }

  newTab(url = 'about:blank', opener = /** @type {number | null} */ (null)) {
    let tid = 100 + this.tabs.size;
    while (this.tabs.has(tid)) tid += 1;
    this.tabs.set(tid, { targetId: `TARGET-${this.boot}-${tid}`, url, title: '', opener });
    return tid;
  }

  // ---------- ops ----------
  /** No window id (or none yet): a new window, like the real extension. @param {any} a */
  async op_tabs_create({ url, windowId }) {
    const win = windowId ?? this.nextWindow++;
    await new Promise((r) => setImmediate(r)); // creating a window takes a moment
    const tid = this.newTab(url);
    this.owned.add(tid);
    return { tabId: tid, windowId: win, targetId: this.tabs.get(tid)?.targetId, url, title: '' };
  }
  /** @param {any} a */ op_tabs_alive({ tabIds }) {
    return Object.fromEntries(tabIds.filter((/** @type {number} */ t) => this.tabs.has(t)).map((/** @type {number} */ t) => [String(t), this.tabs.get(t)?.targetId]));
  }
  /** Same contract as the real extension: owned set first, detach everything attached, report missing. @param {any} a */
  op_own_sync({ tabIds }) {
    this.owned = new Set(tabIds);
    this.attached.clear();
    return { missing: tabIds.filter((/** @type {number} */ t) => !this.tabs.has(t)) };
  }
  /** The waiting hand-offs the bridge shows the user. @param {any} a */ op_handoff_sync({ items }) { this.handoffs = items; return true; }
  /** Side panel updates; a test may hold them with panelGate. @param {any} batch */
  async op_panel_push(batch) { if (this.panelGate) await this.panelGate; this.panel.push(batch); return true; }
  /** @param {any} a */ op_tabs_show({ tabId }) { this.shown.push(tabId); return true; }
  /** @param {any} a */ op_own({ tabId, owned }) { if (owned) this.owned.add(tabId); else this.owned.delete(tabId); return true; }
  /** @param {any} a */ op_tabs_get({ tabId }) {
    const t = this.tabs.get(tabId);
    if (!t) throw new Error(`no tab ${tabId}`);
    return { tabId, windowId: 1, targetId: t.targetId, url: t.url, title: t.title };
  }
  /** @param {any} a */ op_tabs_close({ tabId }) {
    this.tabs.delete(tabId);
    setImmediate(() => this.event('tab.removed', { tabId }));
    return true;
  }
  op_tabs_activate() { return true; }
  /** @param {any} a */ op_dbg_attach({ tabId }) { this.attached.add(tabId); return true; }
  /** @param {any} a */ op_dbg_detach({ tabId }) { this.attached.delete(tabId); return true; }
  /** @param {any} a */
  async op_dbg_send({ tabId, sessionId, method }) {
    const gate = this.sendGates.get(method);
    if (gate) await gate;
    if (this.sendFail.has(method)) throw new Error(`${method} failed`);
    if (this.sendResults.has(method)) return this.sendResults.get(method);
    return { echo: method, tabId, child: sessionId };
  }

  /** @param {string} ev @param {Record<string, any>} [kw] */
  event(ev, kw = {}) {
    this.ws.send(JSON.stringify({ t: 'ev', ev, ...kw }));
  }

  async close() {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      const closed = new Promise((r) => this.ws.once('close', r));
      this.ws.close();
      await Promise.race([closed, sleep(500)]);
    }
  }
}

/** A CDP client: id-matched replies, every event collected. */
export class FakeCdp {
  /** @param {string} base @param {string} token */
  constructor(base, token) {
    this.url = `${base.replace('http', 'ws')}/c/${token}/devtools/browser/x`;
    this.ids = 0;
    /** @type {Map<number, (m: any) => void>} */ this.waiting = new Map();
    /** @type {any[]} */ this.events = [];
    this.closed = false;
    /** @type {WebSocket} */ this.ws = /** @type {any} */ (null);
  }

  async connect() {
    OPEN.push(this);
    this.ws = new WebSocket(this.url);
    this.ws.on('error', () => {});
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      const w = 'id' in m ? this.waiting.get(m.id) : undefined;
      if (w) { this.waiting.delete(m.id); w(m); } else this.events.push(m);
    });
    this.ws.on('close', () => { this.closed = true; });
    return this;
  }

  /** @param {string} method @param {Record<string, any>} [params] @param {string} [sessionId] @param {number} [ms] @returns {Promise<any>} */
  raw(method, params = {}, sessionId, ms = 5000) {
    const id = ++this.ids;
    /** @type {Record<string, any>} */
    const body = { id, method, params };
    if (sessionId) body.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), ms);
      this.waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
      this.ws.send(JSON.stringify(body));
    });
  }

  /** @param {string} method @param {Record<string, any>} [params] @param {string} [sessionId] */
  async call(method, params, sessionId) {
    const m = await this.raw(method, params, sessionId);
    if (m.error) throw new Error(m.error.message);
    return m.result;
  }

  /** @param {string} method */
  named(method) {
    return this.events.filter((e) => e.method === method);
  }

  async close() {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      const closed = new Promise((r) => this.ws.once('close', r));
      this.ws.close();
      await Promise.race([closed, sleep(500)]);
    }
  }
}
