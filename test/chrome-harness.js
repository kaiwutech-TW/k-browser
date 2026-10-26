// @ts-check
// Runs the real extension/background.js in a fresh VM context with a scripted chrome.* API and a WebSocket that
// connects like Chrome does (Origin chrome-extension://<id>). Each harness is one service-worker lifetime.

import fs from 'node:fs';
import vm from 'node:vm';
import WS from 'ws';
import { ORIGIN } from './fakes.js';

const SOURCE = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const MANIFEST_VERSION = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8')).version;
const MESSAGES = JSON.parse(fs.readFileSync(new URL('../extension/_locales/en/messages.json', import.meta.url), 'utf8'));
const PROTOCOL_SOURCE = fs.readFileSync(new URL('../extension/protocol.js', import.meta.url), 'utf8');
const IMPORT = /^import \{([^}]+)\} from '\.\/protocol\.js';$/m;
const EXPORTED = [...PROTOCOL_SOURCE.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]);

/** A listener registry like chrome.events.Event. */
export const EXT_ID = 'olakpcnfpffffpakpoleompemlalacdb';

class Ev {
  /** @type {Function[]} */ fns = [];
  /** @param {Function} f */ addListener(f) { this.fns.push(f); }
  /** @param {...any} a */ fire(...a) { return this.fns.map((f) => f(...a)); }
}

export class ChromeHarness {
  /** @param {{ port: number, pairKey?: string, local?: Record<string, any>, session?: Record<string, any> }} o */
  constructor({ port, pairKey, local = {}, session = {} }) {
    /** @type {Record<string, any>} */ this.local = { port, ...(pairKey ? { pairKey } : {}), ...local };
    /** @type {Record<string, any>} */ this.session = { ...session };
    /** @type {Map<number, { id: string, url: string, title: string, windowId: number }>} */ this.tabs = new Map();
    /** @type {Map<number, 'self' | 'other'>} who has chrome.debugger attached to a tab (another extension, DevTools) */
    this.attachedBy = new Map();
    /** @type {[string, ...any[]][]} */ this.calls = [];
    /** @type {Map<string, Promise<void>>} chrome.debugger.sendCommand methods that wait on a gate */ this.gates = new Map();
    /** @type {Promise<void> | null} chrome.tabs.get waits on this when set */ this.tabsGetGate = null;
    /** @type {Promise<void>[]} each chrome.storage.local.get takes the next gate, if any, and answers (with what it read)
     * only after it resolves */
    this.storageGetGates = [];
    /** @type {Promise<void> | null} the next chrome.debugger.getTargets answers (with what it read) only after this */
    this.getTargetsGate = null;
    /** Hold an outgoing message (already computed by the worker) until gate resolves; later messages overtake it.
     * @type {{ match: (m: any) => boolean, gate: Promise<void>, held: boolean } | null} */
    this.outHold = null;
    /** @type {{ nth: number, entered: boolean, release: () => void, gate: Promise<void> } | null} hold the nth HMAC sign */
    this.signHold = null;
    this.signCalls = 0;
    /** @type {any[]} every message the worker's sockets received */
    this.received = [];
    this.stopped = false; // a stopped worker schedules nothing and opens nothing (its reconnect logic would otherwise run forever)
    /** @type {Set<any>} */ this.timers = new Set();
    /** @type {Set<WS>} */ this.sockets = new Set();
    this.nextTab = 7;
    /** @type {Map<number, { state: string }>} */ this.windows = new Map([[1, { state: 'normal' }]]);
    /** the chrome.* object the worker sees (set by start()) @type {any} */ this.chrome = null;
    this.ev = { debuggerEvent: new Ev(), debuggerDetach: new Ev(), tabCreated: new Ev(), tabUpdated: new Ev(), tabReplaced: new Ev(),
      tabRemoved: new Ev(), runtimeMessage: new Ev(), runtimeConnect: new Ev(), startup: new Ev(), installed: new Ev(), alarm: new Ev(), storageChanged: new Ev(), createdNavigationTarget: new Ev() };
  }

  /** @param {string} url */
  addTab(url = 'about:blank') {
    const id = this.nextTab++;
    this.tabs.set(id, { id: `TID-${id}`, url, title: '', windowId: 1 });
    return id;
  }

  #chrome() {
    const h = this;
    /** @param {Record<string, any>} store @param {string} name */
    const area = (store, name) => ({
      /** @param {string | string[]} keys */
      async get(keys) {
        const ks = Array.isArray(keys) ? keys : [keys];
        const snapshot = Object.fromEntries(ks.filter((k) => k in store).map((k) => [k, store[k]]));
        const gate = name === 'local' ? h.storageGetGates.shift() : undefined;
        if (gate) await gate; // answers with what it read before the gate
        return snapshot;
      },
      /** @param {Record<string, any>} items */
      async set(items) {
        /** @type {Record<string, { oldValue?: any, newValue: any }>} */
        const changes = {};
        for (const [k, v] of Object.entries(items)) changes[k] = { oldValue: store[k], newValue: v };
        Object.assign(store, items);
        h.ev.storageChanged.fire(changes, name);
      },
    });
    /** @param {number} id */
    const tab = (id) => {
      const t = h.tabs.get(id);
      if (!t) throw new Error(`No tab with id: ${id}`);
      return { id, windowId: t.windowId, url: t.url, title: t.title };
    };
    return {
      runtime: { id: EXT_ID, getURL: (/** @type {string} */ p) => `chrome-extension://${EXT_ID}/${p}`, getManifest: () => ({ version: MANIFEST_VERSION }),
        onMessage: h.ev.runtimeMessage, onConnect: h.ev.runtimeConnect, onStartup: h.ev.startup, onInstalled: h.ev.installed },
      storage: { local: area(h.local, 'local'), session: area(h.session, 'session'), onChanged: h.ev.storageChanged },
      i18n: { getMessage: (/** @type {string} */ k) => MESSAGES[k]?.message ?? '' },
      alarms: { create() {}, onAlarm: h.ev.alarm },
      debugger: {
        /** @param {{ tabId: number }} t */
        async attach({ tabId }) {
          h.calls.push(['attach', tabId]);
          if (!h.tabs.has(tabId)) throw new Error(`No tab with given id ${tabId}.`);
          if (h.attachedBy.has(tabId)) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
          h.attachedBy.set(tabId, 'self');
        },
        /** Only our own attachment can be detached. @param {{ tabId: number }} t */
        async detach({ tabId }) {
          h.calls.push(['detach', tabId]);
          if (h.attachedBy.get(tabId) !== 'self') throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
          h.attachedBy.delete(tabId);
        },
        /** @param {any} target @param {string} method @param {any} params */
        async sendCommand(target, method, params) {
          h.calls.push(['sendCommand', target, method, params]);
          if (h.attachedBy.get(target.tabId) !== 'self') throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`);
          const gate = h.gates.get(method);
          if (gate) await gate;
          return { ok: true, method };
        },
        // `attached` says some debugger is attached, not who: exactly what Chrome reports.
        async getTargets() {
          const snapshot = [...h.tabs].map(([tabId, t]) => ({ id: t.id, tabId, type: 'page', url: t.url, title: t.title, attached: h.attachedBy.has(tabId) }));
          const gate = h.getTargetsGate;
          if (gate) { h.getTargetsGate = null; await gate; }
          return snapshot;
        },
        onEvent: h.ev.debuggerEvent,
        onDetach: h.ev.debuggerDetach,
      },
      tabs: {
        /** @param {{ url: string }} o */
        async create({ url }) { const id = h.addTab(url); return tab(id); },
        /** @param {number} id */
        async get(id) {
          const t = tab(id); // read now: the answer reflects the moment Chrome looked
          if (h.tabsGetGate) await h.tabsGetGate;
          return t;
        },
        /** @param {number} id */
        async remove(id) { h.tabs.delete(id); h.ev.tabRemoved.fire(id); },
        /** @param {number} id */
        async update(id) { return tab(id); },
        onCreated: h.ev.tabCreated, onUpdated: h.ev.tabUpdated, onReplaced: h.ev.tabReplaced, onRemoved: h.ev.tabRemoved,
      },
      webNavigation: { onCreatedNavigationTarget: h.ev.createdNavigationTarget },
      windows: {
        /** @param {number} id */
        async get(id) {
          const w = h.windows.get(id);
          if (!w) throw new Error(`No window with id: ${id}.`);
          return { id, state: w.state };
        },
        /** @param {{ url: string }} o */
        async create(o) { h.calls.push(['windows.create', o]); const id = h.addTab(o.url); return { id: 1, tabs: [tab(id)] }; },
        /** @param {number} id @param {Record<string, any>} props */
        async update(id, props) {
          h.calls.push(['windows.update', id, props]);
          const w = h.windows.get(id);
          if (w && props.state) w.state = props.state;
          return { id };
        },
      },
    };
  }

  #WebSocket() {
    const h = this;
    return class {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
      /** @type {((e: { data: string }) => void) | null} */ onmessage = null;
      /** @type {(() => void) | null} */ onclose = null;
      /** @type {(() => void) | null} */ onerror = null;
      /** @param {string} url */
      constructor(url) {
        if (h.stopped) throw new Error('worker stopped');
        this.ws = new WS(url, { headers: { Origin: ORIGIN } });
        h.sockets.add(this.ws);
        this.ws.on('message', (d) => {
          const text = d.toString();
          try { h.received.push(JSON.parse(text)); } catch { h.received.push(text); }
          this.onmessage?.({ data: text });
        });
        this.ws.on('close', () => { h.sockets.delete(this.ws); this.onclose?.(); });
        this.ws.on('error', () => this.onerror?.());
      }
      get readyState() { return this.ws.readyState; }
      /** @param {string} text */
      send(text) {
        const hold = h.outHold;
        let m;
        try { m = JSON.parse(text); } catch { m = null; }
        if (hold && m && hold.match(m)) {
          hold.held = true;
          void hold.gate.then(() => { if (this.ws.readyState === 1) this.ws.send(text); });
          return;
        }
        this.ws.send(text);
      }
      close() { this.ws.close(); }
    };
  }

  /** Start one service-worker lifetime. */
  start() {
    const h = this;
    const real = globalThis.crypto;
    const crypto = {
      getRandomValues: (/** @type {Uint8Array} */ a) => real.getRandomValues(a),
      subtle: {
        importKey: (/** @type {any[]} */ ...a) => /** @type {any} */ (real.subtle.importKey)(...a),
        sign: async (/** @type {any[]} */ ...a) => {
          const n = ++h.signCalls;
          if (h.signHold && h.signHold.nth === n) {
            h.signHold.entered = true;
            await h.signHold.gate;
          }
          return /** @type {any} */ (real.subtle.sign)(...a);
        },
      },
    };
    /** @param {Function} make @param {Function} clear */
    const tracked = (make, clear) => (/** @type {any[]} */ ...a) => {
      if (h.stopped) return 0;
      const t = make(...a);
      h.timers.add([t, clear]);
      return t;
    };
    const ctx = vm.createContext({
      chrome: (this.chrome = this.#chrome()), WebSocket: this.#WebSocket(), navigator: { userAgent: 'Mozilla/5.0 Chrome/149.0.0.0' }, crypto,
      TextEncoder, console, setTimeout: tracked(setTimeout, clearTimeout), setInterval: tracked(setInterval, clearInterval),
      clearTimeout, clearInterval,
    });
    // The protocol module is evaluated inside the worker's context, so its mac() uses the worker's crypto (above).
    const proto = vm.runInContext(`(() => { ${PROTOCOL_SOURCE.replace(/^export /gm, '')}\n return { ${EXPORTED.join(', ')} }; })()`,
      ctx, { filename: 'protocol.js' });
    ctx.__protocol = proto;
    const src = SOURCE.replace(IMPORT, (_m, names) => `const {${names}} = __protocol;`);
    if (src === SOURCE) throw new Error('background.js import line changed: update the harness');
    vm.runInContext(src, ctx, { filename: 'background.js' });
    return this;
  }

  /** Hold the nth HMAC sign until the returned release() is called. @param {number} nth */
  holdSign(nth) {
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((r) => { release = () => r(undefined); });
    this.signHold = { nth, entered: false, release, gate };
    return this.signHold;
  }

  /** Ask the worker to reconnect now (what the popup does after pairing). */
  reconnect() {
    return new Promise((resolve) => this.ev.runtimeMessage.fire({ type: 'reconnect' }, {}, resolve));
  }

  async stop() {
    this.stopped = true;
    for (const [t, clear] of this.timers) clear(t);
    for (const ws of this.sockets) ws.terminate();
  }
}
