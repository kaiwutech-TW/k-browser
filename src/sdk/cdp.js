// @ts-check
// A plain CDP client: one browser websocket, flattened sessions, id-matched replies, ordered events.
//
// Every received message gets a sequence number in arrival order. Replies carry theirs too, so state built from a
// reply (Page.getFrameTree) can be compared with events that arrived after it but were handled first: an await
// continuation runs after any events already queued behind the reply.
// A command that times out is never resent: it may have run (same rule as the bridge's ResultUnknown).

import WebSocket from 'ws';

const DEFAULT_TIMEOUT_MS = 30_000;

/** Error codes the SDK reports. cdp_error: Chrome refused the command; script_error: a script the SDK ran in the page
 * threw (it did run). The input checks before a press (act.js): target_changed (the node now has another role, name or
 * context), not_visible, occluded (something else would get the click), unsupported_transform (an OOPIF whose
 * coordinates the SDK cannot map), not_focused (typing would go elsewhere); unsupported: K-Browser cannot do it with
 * trusted input here (and will not fake it from script); dialog_open: a JavaScript dialog opened (the page waits for it);
 * stale_dialog: that dialog is not the one open now; handed_off: the tab is with the user (a hand-off).
 * @typedef {'cdp_error' | 'script_error' | 'result_unknown' | 'disconnected' | 'stale_ref' | 'no_frame'
 * | 'world_unavailable' | 'navigation_failed' | 'timeout' | 'bad_argument' | 'target_changed' | 'not_visible' | 'occluded'
 * | 'unsupported_transform' | 'not_focused' | 'unsupported' | 'dialog_open' | 'stale_dialog' | 'handed_off'} SdkErrorCode */

export class SdkError extends Error {
  /** @param {SdkErrorCode} code @param {string} message @param {number} [cdpCode] */
  constructor(code, message, cdpCode) {
    super(message);
    this.code = code;
    this.cdpCode = cdpCode;
  }
}

/** @typedef {{ method: string, params: Record<string, any>, sessionId: string | null, seq: number }} CdpEvent */
/** @typedef {{ send(text: string): void, close(): void }} Transport */

export class CdpClient {
  /** @param {Transport} transport */
  constructor(transport) {
    this.transport = transport;
    this.ids = 0;
    /** sequence number of the last message received */
    this.seq = 0;
    /** @type {Map<number, { method: string, resolve: (v: { result: any, seq: number }) => void, reject: (e: Error) => void }>} */
    this.pending = new Map();
    /** @type {Set<(e: CdpEvent) => void>} */
    this.listeners = new Set();
    /** every method this client sent, with how often: lets tests prove what the SDK never sends @type {Map<string, number>} */
    this.sent = new Map();
    /** @type {string | null} why the client is closed */
    this.closedWhy = null;
  }

  /** Connect to a K-Browser client endpoint (http://127.0.0.1:9444/c/<token>) or any CDP browser websocket URL.
   * @param {string} endpoint */
  static async connect(endpoint) {
    const url = /^wss?:/.test(endpoint) ? endpoint : `${endpoint.replace(/^http/, 'ws').replace(/\/$/, '')}/devtools/browser/k-browser-sdk`;
    const ws = new WebSocket(url, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', (e) => reject(new SdkError('disconnected', `cannot connect to the CDP endpoint (${e.message})`)));
    });
    const client = new CdpClient({ send: (text) => ws.send(text), close: () => ws.close() });
    ws.on('message', (d) => client.receive(d.toString()));
    ws.on('error', () => {});
    ws.on('close', () => client.closed('the CDP connection closed'));
    return client;
  }

  /** @param {(e: CdpEvent) => void} fn @returns {() => void} unsubscribe */
  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** @param {string} text */
  receive(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const seq = ++this.seq;
    if (Number.isInteger(msg.id)) {
      const p = this.pending.get(msg.id);
      if (!p) return; // timed out earlier: its late answer changes nothing
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new SdkError('cdp_error', `${p.method}: ${msg.error.message}`, msg.error.code));
      else p.resolve({ result: msg.result ?? {}, seq });
      return;
    }
    if (typeof msg.method !== 'string') return;
    /** @type {CdpEvent} */
    const ev = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId ?? null, seq };
    for (const fn of [...this.listeners]) {
      try {
        fn(ev);
      } catch {
        // one listener's bug must not starve the others of events
      }
    }
  }

  /** @param {string} why */
  closed(why) {
    if (this.closedWhy) return;
    this.closedWhy = why;
    for (const p of this.pending.values()) p.reject(new SdkError('disconnected', `${p.method}: ${why} before it was answered; its effect is unknown`));
    this.pending.clear();
  }

  /** Send a command; resolves with the result and the reply's sequence number.
   * @param {string} method @param {Record<string, any>} [params] @param {string | null} [sessionId] @param {{ timeoutMs?: number }} [o]
   * @returns {Promise<{ result: any, seq: number }>} */
  request(method, params = {}, sessionId = null, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.closedWhy) return Promise.reject(new SdkError('disconnected', `${method} not sent: ${this.closedWhy}`));
    const id = ++this.ids;
    this.sent.set(method, (this.sent.get(method) ?? 0) + 1);
    /** @type {Record<string, any>} */
    const body = { id, method, params };
    if (sessionId) body.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new SdkError('result_unknown', `${method} got no answer within ${Math.round(timeoutMs / 1000)}s: it may have run; not retried`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.transport.send(JSON.stringify(body));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new SdkError('result_unknown', `${method} could not be delivered cleanly (${e instanceof Error ? e.message : 'error'}); not retried`));
      }
    });
  }

  /** @param {string} method @param {Record<string, any>} [params] @param {string | null} [sessionId] @param {{ timeoutMs?: number }} [o] */
  async call(method, params = {}, sessionId = null, o = {}) {
    return (await this.request(method, params, sessionId, o)).result;
  }

  close() {
    this.closed('the client closed the connection');
    try { this.transport.close(); } catch { /* already closed */ }
  }
}
