// @ts-check
// The CDP relay: emulates the browser-level Target domain on top of chrome.tabs, forwards session-scoped commands
// through the extension's chrome.debugger after an exact-allowlist policy check, and enforces tab ownership per
// client principal.
//
// State lives here, never in the extension (it is a stateless forwarder that may restart at any time).
// Ownership: a tab belongs to the principal that created it, or to the owner of the owned tab that opened it.
// Other principals cannot see, attach to or close it. v0 session model: one operating root session per target.
//
// Generations: every extension connection is reconciled under an epoch. Work that awaits the extension
// (reconciliation, adoption, createTarget, attach) re-checks after each await that its link is still the current
// one and that the target / connection it acts for still exists; stale work never commits and never sends
// commands to a newer link.

import { randomBytes } from 'node:crypto';
import { LIFECYCLE_EVENTS } from '../extension/protocol.js';
import { Activity, Feed, readConfig } from './activity.js';
import * as auth from './auth.js';
import * as files from './files.js';
import * as model from './model.js';
import { Handoffs } from './handoff.js';
import { Observer } from './observe.js';
import * as policy from './policy.js';
import { CATEGORIES, categoriesIn, withCategory } from './sites.js';
import { VERSION } from './version.js';

export const DEFAULT_CONTEXT = 'k-browser-default';
const EXT_TIMEOUT_MS = 120_000;
const MAX_IN_FLIGHT = 1000; // commands awaiting the extension at once
const OUTBOX_MESSAGES = 10_000; // messages queued for one client before it is considered stuck
const OUTBOX_BYTES = 64 * 1024 * 1024;
export const SESSION_NOT_FOUND = { code: -32001, message: 'Session with given id not found.' };
/** Browser-level methods (no sessionId) the relay answers itself; anything else there is refused. */
export const BROWSER_METHODS = ['Browser.getVersion', 'Target.getTargets', 'Target.getTargetInfo', 'Target.createTarget',
  'Target.closeTarget', 'Target.activateTarget', 'Target.attachToTarget', 'Target.detachFromTarget', 'Target.setDiscoverTargets',
  'Target.getBrowserContexts', 'KBrowser.mark', 'KBrowser.queryNetwork', 'KBrowser.getNavigation',
  'KBrowser.handoff', 'KBrowser.handoffStatus', 'KBrowser.cancelHandoff', 'KBrowser.tabHandoff', 'KBrowser.reportResult',
  'KBrowser.closeUnlessHandedOff'];
/** Bookkeeping reads a client repeats all the time: not worth a line in the activity record. */
const QUIET = new Set(['Browser.getVersion', 'Target.getTargets', 'Target.getTargetInfo', 'Target.setDiscoverTargets', 'Target.getBrowserContexts',
  'KBrowser.queryNetwork', 'KBrowser.getNavigation', 'KBrowser.tabHandoff', 'KBrowser.handoffStatus']);
/** Events a reconnecting extension may send before the bridge has reconciled it: applied afterwards. */
const BUFFERED = new Set([...LIFECYCLE_EVENTS, 'panel.open', 'panel.close']);
const LIFECYCLE = new Set(LIFECYCLE_EVENTS);

/** A hand-off as clients see it. Unknown (a restarted bridge, or someone else's) reads as invalidated.
 * @param {(import('./handoff.js').Handoff & { existing?: boolean }) | null} h @param {unknown} [id] */
function view(h, id) {
  if (!h) return { handoffId: String(id ?? ''), state: 'invalidated', why: 'this bridge does not know it (it may have restarted)' };
  const { owner, tabId, ...rest } = h;
  return rest;
}

/** The command was not sent: no extension is connected. */
export class ExtensionOffline extends Error {}
/** The command may have reached Chrome but no answer came back: it may or may not have run. Never retried. */
export class ResultUnknown extends Error {}
export class ExtensionError extends Error {}
export class CdpError extends Error {
  /** @param {string} message @param {number} [code] @param {{ refused?: boolean }} [o] refused: by K-Browser's policy */
  constructor(message, code = -32000, { refused = false } = {}) {
    super(message);
    this.code = code;
    this.refused = refused;
  }
}

/** @param {unknown} e */
const isExpected = (e) => e instanceof ExtensionError || e instanceof ExtensionOffline || e instanceof ResultUnknown;

/** @typedef {{ id: string, name: string }} Principal */
/** @typedef {(text: string) => Promise<void>} Send */

/** A tiny async mutex. */
class Lock {
  #tail = Promise.resolve();
  /** callers queued or running (observable, so tests can prove a waiter is really queued) */
  queued = 0;
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  run(fn) {
    this.queued += 1;
    const result = this.#tail.then(fn).finally(() => { this.queued -= 1; });
    this.#tail = result.then(() => {}, () => {});
    return result;
  }
}

/** One authenticated extension websocket: request/response with ids, never retried. */
export class ExtensionLink {
  /** @param {Send} send @param {Record<string, any>} hello @param {() => void} closeWs */
  constructor(send, hello, closeWs) {
    this.send = send;
    this.closeWs = closeWs;
    this.hello = hello;
    /** @type {string} */
    this.bootId = hello.bootId ?? '';
    /** @type {string | null} the pairing key this link proved; a rotated key drops the link */
    this.key = null;
    this.ids = 0;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
    this.pending = new Map();
    this.closed = false;
  }

  /** @param {string} op @param {Record<string, any>} [args] @param {number} [timeoutMs] @returns {Promise<any>} */
  async call(op, args = {}, timeoutMs = EXT_TIMEOUT_MS) {
    if (this.closed) throw new ExtensionOffline('K-Browser extension is not connected');
    if (this.pending.size >= MAX_IN_FLIGHT) throw new ExtensionError(`${MAX_IN_FLIGHT} commands already waiting on the extension; ${op} not sent`);
    const id = ++this.ids;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const answer = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    // Observed now, awaited below: close() may reject it while the send is still pending, and that must not become an
    // unhandled rejection (which ends the process).
    answer.catch(() => {});
    // The deadline covers sending as well as the answer.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ResultUnknown(`${op} got no answer within ${Math.round(timeoutMs / 1000)}s: it may have run; not retried`)), timeoutMs);
    });
    try {
      const sent = this.send(JSON.stringify({ t: 'cmd', id, op, args })).catch((e) => {
        // A transport failure mid-send: some bytes may have left.
        throw new ResultUnknown(`${op} could not be delivered cleanly (${e?.name ?? 'error'}): its effect is unknown; not retried`);
      });
      await Promise.race([sent, deadline]);
      return await Promise.race([answer, deadline]);
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  /** @param {Record<string, any>} msg */
  resolve(msg) {
    const p = Number.isInteger(msg.id) ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new ExtensionError(String(msg.error || 'extension error')));
  }

  /** Fail every in-flight command as unknown (it was sent; Chrome may still run it) and close the socket. @param {string} why */
  close(why) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      p.reject(new ResultUnknown(`K-Browser extension ${why} while the command was in flight: its effect is unknown; not retried`));
    }
    this.pending.clear();
    try { this.closeWs(); } catch { /* already closed */ }
  }
}

class Target {
  /** @param {string} targetId @param {number} tabId @param {string} owner @param {string} [url] @param {string} [title] @param {string | null} [openerId] */
  constructor(targetId, tabId, owner, url = 'about:blank', title = '', openerId = null) {
    /** @type {string} */ this.targetId = targetId;
    /** @type {number} */ this.tabId = tabId;
    /** @type {string} principal id */ this.owner = owner;
    /** @type {string} */ this.url = url;
    /** @type {string} */ this.title = title;
    /** @type {string | null} */ this.openerId = openerId;
    /** a close was sent: no hand-off may start on it any more */
    this.closing = false;
    /** whether it is the tab its window shows (null: not known yet) @type {boolean | null} */
    this.active = null;
  }

  /** @param {boolean} attached */
  info(attached) {
    /** @type {Record<string, any>} */
    const d = { targetId: this.targetId, type: 'page', title: this.title, url: this.url, attached, canAccessOpener: false, browserContextId: DEFAULT_CONTEXT };
    if (this.openerId) d.openerId = this.openerId;
    return d;
  }
}

/** @typedef {{ sid: string, conn: CdpConn, tabId: number, child: string | null, parent: string | null }} Session */

/**
 * One client websocket speaking CDP. Session ids are scoped to the connection.
 * Everything the relay sends goes through one bounded outbox (messages and bytes), drained in order, so a slow
 * client never stalls the extension reader and replies keep their order relative to events. A stuck or failed
 * writer closes the connection; the bridge then cleans up its sessions.
 */
export class CdpConn {
  /** @param {Principal} principal @param {Send} send @param {() => void} close
   * @param {{ limit?: number, limitBytes?: number, log?: (line: string) => void }} [opts] */
  constructor(principal, send, close, { limit = OUTBOX_MESSAGES, limitBytes = OUTBOX_BYTES, log = (l) => console.error(l) } = {}) {
    this.log = log;
    this.principal = principal;
    this.client = principal.id;
    this.send = send;
    this.closeWs = close;
    this.discover = false;
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    this.closed = false;
    this.limit = limit;
    this.limitBytes = limitBytes;
    /** @type {{ text: string, bytes: number }[]} */
    this.outbox = [];
    this.bytes = 0;
    this.draining = false;
  }

  /** @param {Record<string, any>} msg */
  post(msg) {
    if (this.closed) return;
    const text = JSON.stringify(msg);
    const bytes = Buffer.byteLength(text, 'utf8'); // what the socket carries, not UTF-16 code units
    if (this.outbox.length >= this.limit || this.bytes + bytes > this.limitBytes) {
      this.log(`k-browser: client ${this.principal.name} is not reading: disconnecting it`);
      this.close();
      return;
    }
    this.outbox.push({ text, bytes });
    this.bytes += bytes;
    if (!this.draining) this.#drain();
  }

  async #drain() {
    this.draining = true;
    try {
      while (this.outbox.length && !this.closed) {
        const item = this.outbox[0]; // stays counted (messages and bytes) until the socket has taken it
        try {
          await this.send(item.text);
        } catch {
          this.close(); // the socket is gone or broken: end the connection, never keep a dead writer
          return;
        }
        this.outbox.shift();
        this.bytes -= item.bytes;
      }
    } finally {
      this.draining = false;
    }
  }

  /** @param {string} method @param {Record<string, any>} params @param {string | null} [sessionId] */
  emit(method, params, sessionId = null) {
    /** @type {Record<string, any>} */
    const msg = { method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.post(msg);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.outbox = [];
    try { this.closeWs(); } catch { /* already closed */ }
  }
}

/** @typedef {(line: string) => void} Log */
/** @type {Log} */
const stderr = (line) => console.error(line);

export class Relay {
  /** @param {{ log?: Log, handoffTtlMs?: number, activity?: Activity }} [o] every log line goes through here (never a URL or token) */
  constructor({ log = stderr, handoffTtlMs, activity = new Activity() } = {}) {
    this.log = log;
    /** @type {ExtensionLink | null} the ready link */
    this.ext = null;
    /** @type {ExtensionLink | null} a link being reconciled */
    this.candidate = null;
    this.epoch = 0;
    /** @type {Record<string, any>[]} lifecycle events the candidate sent while being reconciled */
    this.buffered = [];
    /** @type {string | null} extension lifetime the current targets belong to */
    this.bootId = null;
    /** @type {Map<string, Target>} */
    this.targets = new Map();
    /** @type {Map<number, Target>} */
    this.byTab = new Map();
    /** @type {Set<CdpConn>} */
    this.conns = new Set();
    /** @type {Set<number>} tabs chrome.debugger is attached to */
    this.attached = new Set();
    /** @type {number | null} the one K-Browser window; the extension opens a new one if it is gone */
    this.windowId = null;
    this.lock = new Lock(); // serialises attach/detach decisions
    this.windowLock = new Lock(); // serialises creating tabs (they share the one K-Browser window)
    /** @type {Set<Promise<void>>} */
    this.tasks = new Set();
    /** @type {Map<number, number>} bumped whenever Chrome says a tab went away, registered or not */
    this.tabGen = new Map();
    /** advances whenever tabGen is reset: work that captured an older one treats every tab as possibly gone */
    this.tabGenEpoch = 0;
    /** @type {Map<number, { owner: string, openerId: string | null }>} popups being adopted (not registered yet) */
    this.pendingAdopt = new Map();
    /** @type {Map<number, { url?: string, title?: string, active?: boolean }>} tab.updated for an owned tab that came before
     * the tab was registered: tabs.create has answered (or its answer is in the same read) but #createTarget has not run on */
    this.early = new Map();
    /** counters for diagnostics and tests */
    this.stats = { adoptionsStarted: 0 };
    /** what the bridge saw of owned tabs' network and navigation (observe.js), read with KBrowser.* */
    this.observe = new Observer();
    /** hand-offs to the user (handoff.js); the extension shows the waiting ones */
    this.handoffs = new Handoffs({ ...(handoffTtlMs ? { ttlMs: handoffTtlMs } : {}), changed: () => this.#syncHandoffs() });
    /** what each client did (activity.js), for the side panel */
    this.activity = activity;
    this.panelResults = 0;
  }

  // ---------- the side panel ----------

  /** Clients, their tabs and waiting hand-offs, as the panel shows them. Titles and URLs are the pages': the panel
   * shows them as plain text; URLs are redacted. */
  panelState() {
    const r = this.activity;
    /** @type {Map<string, { principal: string, name: string, connections: number, lastActive: number | null }>} */
    const clients = new Map();
    const client = (/** @type {string} */ id, /** @type {string} */ name) => {
      let c = clients.get(id);
      if (!c) clients.set(id, (c = { principal: id, name, connections: 0, lastActive: null }));
      return c;
    };
    for (const c of this.conns) client(c.client, c.principal.name).connections += 1;
    for (const t of this.targets.values()) client(t.owner, auth.clientNameOf(t.owner) ?? '(removed)');
    for (const { principal, entries } of r.recent(1)) {
      const c = clients.get(principal);
      if (c && entries.length) c.lastActive = entries[entries.length - 1].t;
    }
    const redact = (/** @type {string} */ u) => r.redactUrl(u);
    const text = (/** @type {string} */ x, /** @type {number} */ n) => r.redactText(String(x).slice(0, n)); // titles and reasons can carry secrets too
    // every client set up on this machine, idle or not, with its settings as counts, switches and site categories only
    // (never a token or a site name): what the panel shows when nothing is connected, and changes (sites: null
    // when blockedOrigins is not a list)
    const configured = [...auth.clients().keys()].sort().map((name) => {
      const rec = auth.clientRecord(name) ?? {};
      const b = rec.blockedOrigins ?? [];
      return { name, principal: typeof rec.principal === 'string' ? rec.principal : null, connected: [...this.conns].some((c) => c.principal.name === name),
        blocked: Array.isArray(rec.blockedOrigins) ? rec.blockedOrigins.length : 0, allowList: Array.isArray(rec.allowedOrigins),
        screenshot: rec.screenshot !== false, eval: rec.eval === true, sites: Array.isArray(b) ? categoriesIn(b) : null };
    });
    return {
      about: { version: VERSION, extension: this.ext?.hello?.version ?? null, launchd: process.env.XPC_SERVICE_NAME === 'com.k-browser.bridge',
        decisionLog: readConfig().decisionLog === 'on', model: model.panelView(),
        categories: Object.entries(CATEGORIES).map(([id, c]) => ({ id, label: c.label })) },
      configured,
      clients: [...clients.values()],
      tabs: [...this.targets.values()].map((t) => ({ principal: t.owner, targetId: t.targetId, title: text(t.title, 300), url: redact(t.url),
        openedBy: t.openerId, attached: this.#hasSessions(t.tabId), background: t.active === false })),
      handoffs: this.handoffs.waiting().map((h) => {
        const full = [...this.handoffs.items.values()].find((x) => x.handoffId === h.handoffId);
        return { handoffId: h.handoffId, principal: full?.owner ?? '', targetId: full?.targetId ?? '', reason: text(h.reason, 200), source: 'client', since: full?.createdAt ?? 0 };
      }),
    };
  }

  /** The panel's view changed (tabs, clients, hand-offs): send the whole state, merged with any not yet delivered. */
  #pushState() {
    this.activity.panel?.push('state', { type: 'state', state: this.panelState() });
  }

  /** A panel opened (or the extension reconnected with one open): a snapshot first, then updates. @param {ExtensionLink} link */
  #panelOpen(link) {
    this.activity.panel = new Feed((batch) => {
      if (this.ext !== link) throw new Error('the extension link changed');
      return link.call('panel.push', batch);
    }, this.activity.limits.queue);
    this.activity.panel.push('snapshot', { type: 'snapshot', state: this.panelState(), activity: this.activity.recent() });
  }

  /**
   * One of the panel's commands. `model` chooses where Kav's decisions go, `decisionLog` turns the decision dataset on
   * or off; `sites`, `screenshot` and `eval` change a client's settings (by name, and only while that name still holds
   * the principal the panel showed); the other four name the client by its principal id (never by name) and are
   * checked again here: the tab must still be that client's, the hand-off still waiting and that client's, the
   * principal still the one on disk under that name.
   * @param {ExtensionLink} link @param {Record<string, any>} msg
   */
  async #panelCmd(link, msg) {
    const { op, principal } = msg;
    /** @param {boolean} ok @param {string} [why] */
    const done = (ok, why) => this.activity.panel?.push(`r${++this.panelResults}`, { type: 'result', op: String(op), ok, ...(why ? { why } : {}) });
    try {
      if (op === 'model') {
        // where Kav's decisions go: kev / off at once; jev only with the agreement text the panel showed (its version
        // comes back) and a key already imported in a terminal (the key never passes through the browser)
        const { backend } = msg;
        if (backend !== 'kev' && backend !== 'off' && backend !== 'jev') return done(false, 'kev, jev or off');
        if (backend === 'jev') {
          if (msg.consentVersion !== model.CONSENT_VERSION) return done(false, 'the agreement shown is not the current one: reopen the panel and read it again');
          if (model.jevKey() === null) return done(false, 'no JEV key: import it in a terminal with `k-browser model jev`');
        }
        model.choose(backend);
        this.log(`k-browser: Kav's model set to ${backend} from the side panel`);
        return done(true);
      }
      if (op === 'decisionLog') {
        // read when each run_flow starts (decisions.enabled): the next run follows; turning it off deletes nothing
        if (typeof msg.on !== 'boolean') return done(false, 'on: true or false');
        model.updateConfig((c) => { c.decisionLog = msg.on ? 'on' : 'off'; });
        this.log(`k-browser: decision dataset ${msg.on ? 'on' : 'off'} from the side panel`);
        return done(true);
      }
      if (op === 'sites' || op === 'screenshot' || op === 'eval') {
        // a client's settings, read when its k-browser MCP server starts: the panel says they apply after a reconnect
        // (the JEV refusal of a client with blocked sites is read per request, so it applies at once)
        const { name, on } = msg;
        const rec = typeof name === 'string' ? auth.clientRecord(name) : null;
        if (!rec || typeof principal !== 'string' || rec.principal !== principal) return done(false, 'no such client (removed, or added again under a new id)');
        if (typeof on !== 'boolean') return done(false, 'on: true or false');
        if (op === 'eval') {
          // the panel only turns eval off; on stays a terminal decision
          if (on) return done(false, `eval is turned on only in a terminal: k-browser client set ${name} --eval on`);
          auth.updateClient(name, { eval: false });
        } else if (op === 'screenshot') {
          auth.updateClient(name, { screenshot: on });
        } else {
          const { category } = msg;
          if (typeof category !== 'string' || !Object.hasOwn(CATEGORIES, category)) return done(false, 'unknown site category');
          // an allow list decides on its own; blocking categories inside it is left to the file
          if (rec.allowedOrigins !== undefined) return done(false, 'this client uses an allow list (allowedOrigins): change its file in a terminal');
          const had = rec.blockedOrigins ?? [];
          if (!Array.isArray(had)) return done(false, 'its blockedOrigins is not a list: fix its file in a terminal');
          auth.updateClient(name, { blockedOrigins: withCategory(had, category, on) });
        }
        this.log(`k-browser: client ${name}: ${op}${op === 'sites' ? ` ${msg.category}` : ''} ${on ? 'on' : 'off'} from the side panel`);
        return done(true);
      }
      if (typeof principal !== 'string' || !principal) return done(false, 'no client named');
      if (op === 'show') {
        const t = this.targets.get(String(msg.targetId));
        if (!t || t.owner !== principal) return done(false, 'not that client\'s tab (any more)');
        await link.call('tabs.show', { tabId: t.tabId });
        return done(true);
      }
      if (op === 'return') {
        const h = this.handoffs.get(principal, msg.handoffId);
        if (!h || h.state !== 'waiting') return done(false, 'that hand-off is not waiting (any more)');
        return done(this.handoffs.returned(h.handoffId, (x) => this.targets.get(x.targetId)?.url ?? ''));
      }
      if (op === 'closeTabs') {
        const tabs = [...this.targets.values()].filter((t) => t.owner === principal);
        for (const t of tabs) await link.call('tabs.close', { tabId: t.tabId }).catch(() => {});
        return done(true);
      }
      if (op === 'revoke') {
        // the name on disk must still hold this principal: a client removed and added again under the same name is
        // another one, and an old confirmation must not revoke it
        const name = auth.clientNameOf(principal);
        if (!name) return done(false, 'no such client (already removed, or added again under a new id)');
        auth.removeClient(name);
        this.revoke(auth.principals());
        this.log(`k-browser: client ${name} revoked from the side panel`);
        return done(true);
      }
      return done(false, 'unknown command');
    } catch (e) {
      return done(false, e instanceof Error ? e.message.slice(0, 200) : 'failed');
    } finally {
      this.#pushState();
    }
  }

  /** Tell the extension which hand-offs wait for the user (its badge and popup). */
  #syncHandoffs() {
    const link = this.ext;
    if (!link) return;
    // the popup shows these: masked like everything else the extension's UI shows
    const items = this.handoffs.waiting().map((h) => ({ ...h, reason: this.activity.redactText(h.reason), title: this.activity.redactText((this.byTab.get(h.tabId)?.title ?? '').slice(0, 300)) }));
    link.call('handoff.sync', { items }).catch(() => {});
    this.#pushState();
  }

  /** @param {number} tabId */
  #bump(tabId) {
    if (this.tabGen.size > 10000) {
      // Dropping the counters loses evidence, so advance the epoch: anything in flight compares both and gives up.
      this.tabGen.clear();
      this.tabGenEpoch += 1;
    }
    this.tabGen.set(tabId, (this.tabGen.get(tabId) ?? 0) + 1);
  }

  /** A stamp of what we know about tabId's removals; compare with #sameTab after an await. @param {number} tabId */
  #tabStamp(tabId) {
    return { epoch: this.tabGenEpoch, gen: this.tabGen.get(tabId) ?? 0 };
  }

  /** @param {number} tabId @param {{ epoch: number, gen: number }} stamp */
  #sameTab(tabId, stamp) {
    return stamp.epoch === this.tabGenEpoch && (this.tabGen.get(tabId) ?? 0) === stamp.gen;
  }

  // ---------- extension side ----------

  /** Reconcile targets with what this extension really has, then make link the ready one. A newer connection
   * supersedes this one at any await; this one then closes itself without committing. @param {ExtensionLink} link */
  async extConnected(link) {
    const epoch = ++this.epoch;
    if (this.candidate && this.candidate !== link) this.candidate.close('was superseded by a newer connection');
    this.candidate = link;
    this.buffered = [];
    if (this.ext) {
      const old = this.ext;
      this.ext = null;
      old.close('was replaced by a new connection');
      this.#dropAllSessions();
    }
    this.attached.clear();
    const stale = () => this.epoch !== epoch || link.closed;
    try {
      if (link.bootId !== this.bootId) {
        // Another extension lifetime (browser restart, extension reload/update) or the first link: tab ids may
        // have been reused, so nothing old is ours any more.
        if (this.bootId !== null) this.handoffs.invalidate(() => true, 'the extension restarted');
        for (const tabId of [...this.byTab.keys()]) this.#targetGone(tabId);
        this.windowId = null; // window ids are per lifetime too
        // Removal records belong to the old lifetime (its tab ids may be reused now): drop them, and advance the epoch
        // so adoption work still in flight from the old lifetime gives up.
        this.tabGen.clear();
        this.tabGenEpoch += 1;
        this.pendingAdopt.clear();
        this.early.clear();
      } else if (this.byTab.size) {
        const alive = await link.call('tabs.alive', { tabIds: [...this.byTab.keys()] });
        if (stale()) return;
        for (const [tabId, t] of [...this.byTab]) {
          if (alive?.[String(tabId)] !== t.targetId) this.#targetGone(tabId); // gone, or the id now names another page
        }
      }
      // own.sync sets the extension's owned set first, then reports owned tabs that no longer exist: a tab closing
      // after that is reported as tab.removed (buffered below), so nothing falls between the two.
      const synced = await link.call('own.sync', { tabIds: [...this.byTab.keys()] });
      if (stale()) return;
      for (const tabId of synced?.missing ?? []) this.#targetGone(tabId);
      this.bootId = link.bootId;
      this.ext = link;
      this.candidate = null;
      this.#syncHandoffs();
      const buffered = this.buffered;
      this.buffered = [];
      for (const msg of buffered) this.#apply(link, msg);
    } catch (e) {
      this.log(`k-browser: extension reconciliation failed (${e instanceof Error ? e.constructor.name : 'error'})`);
      if (this.candidate === link) this.candidate = null;
      link.close('failed to reconcile');
    } finally {
      if (stale() && this.ext !== link) link.close('was superseded by a newer connection');
    }
  }

  /** @param {ExtensionLink} link */
  extDisconnected(link) {
    link.close('disconnected');
    if (this.candidate === link) this.candidate = null;
    if (this.ext !== link) return;
    this.ext = null;
    this.activity.panel = null; // a reconnecting extension says again whether a panel is open
    this.attached.clear();
    this.#dropAllSessions();
  }

  #dropAllSessions() {
    this.observe.newGeneration();
    for (const conn of this.conns) {
      for (const [sid, s] of conn.sessions) {
        if (s.child === null) conn.emit('Target.detachedFromTarget', { sessionId: sid, targetId: this.byTab.get(s.tabId)?.targetId ?? '' });
      }
      conn.sessions.clear();
    }
  }

  /** Called synchronously by the extension reader, so debugger events keep their order. Never awaits an extension
   * call itself: adoption needs one, so it runs detached. @param {ExtensionLink} link @param {Record<string, any>} msg */
  extEvent(link, msg) {
    if (link === this.ext) this.#apply(link, msg);
    else if (link === this.candidate && BUFFERED.has(msg.ev)) this.buffered.push(msg); // no sessions exist yet for debugger events; no commands
    // anything else comes from a replaced link and is dropped
  }

  /** @param {ExtensionLink} link @param {Record<string, any>} msg */
  #apply(link, msg) {
    switch (msg.ev) {
      case 'dbg.event':
        this.#debuggerEvent(msg.tabId, msg.sessionId ?? null, msg.method, msg.params ?? {});
        break;
      case 'dbg.detach':
        this.#debuggerDetached(msg.tabId);
        break;
      case 'tab.created':
        this.#spawn(this.#adopt(link, msg.tabId, msg.openerTabId ?? null));
        break;
      case 'tab.replaced': {
        this.#bump(msg.removedTabId);
        const old = this.byTab.get(msg.removedTabId);
        const adopting = this.pendingAdopt.get(msg.removedTabId); // replaced before its adoption finished
        this.#targetGone(msg.removedTabId);
        if (old) this.#spawn(this.#adopt(link, msg.addedTabId, null, old.owner, old.targetId));
        else if (adopting) this.#spawn(this.#adopt(link, msg.addedTabId, null, adopting.owner, adopting.openerId));
        break;
      }
      case 'tab.updated': {
        const t = this.byTab.get(msg.tabId);
        if (!t && Number.isInteger(msg.tabId)) {
          // owned by the extension, not registered here yet (a tab being created): kept for #createTarget, or the
          // page's title would stay empty until it next changes (CfT panel.test background-tab case)
          const e = this.early.get(msg.tabId) ?? {};
          this.early.delete(msg.tabId);
          if (typeof msg.url === 'string') e.url = msg.url;
          if (typeof msg.title === 'string') e.title = msg.title;
          if (typeof msg.active === 'boolean') e.active = msg.active;
          this.early.set(msg.tabId, e);
          if (this.early.size > 100) this.early.delete(/** @type {number} */ (this.early.keys().next().value));
        }
        if (t) {
          const was = t.active;
          if (typeof msg.active === 'boolean') t.active = msg.active;
          if (msg.url === undefined && msg.title === undefined) {
            if (t.active !== was) this.#pushState(); // only which tab is shown changed: nothing for CDP clients
            break;
          }
          t.url = msg.url ?? t.url;
          t.title = msg.title ?? t.title;
          this.#broadcastTarget(t.owner, 'Target.targetInfoChanged', { targetInfo: t.info(this.#hasSessions(t.tabId)) });
        }
        break;
      }
      case 'tab.removed':
        this.early.delete(msg.tabId);
        this.#bump(msg.tabId);
        this.#targetGone(msg.tabId);
        break;
      case 'handoff.return': // the user pressed Return (交還) in the extension popup
        this.handoffs.returned(msg.handoffId, (h) => this.targets.get(h.targetId)?.url ?? '');
        break;
      case 'panel.open':
        this.#panelOpen(link);
        break;
      case 'panel.close':
        this.activity.panel = null;
        break;
      case 'panel.cmd': // only ever from the current, reconciled link (extEvent)
        this.#spawn(this.#panelCmd(link, msg));
        break;
    }
  }

  /** @param {Promise<void>} p */
  #spawn(p) {
    const task = p.catch((e) => this.log(`k-browser: background task failed (${e?.constructor?.name ?? 'error'})`)).finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }

  /** @param {number} tabId @param {string | null} child @param {string} method @param {Record<string, any>} params */
  #debuggerEvent(tabId, child, method, params) {
    const t = this.byTab.get(tabId);
    if (t) this.observe.event(t.targetId, t.owner, child, method, params);
    if (method === 'Inspector.targetCrashed' && t) {
      this.#broadcastTarget(t.owner, 'Target.targetCrashed', { targetId: t.targetId, status: 'crashed', errorCode: 0 });
    }
    for (const s of this.#sessionsOn(tabId, child)) {
      if (method === 'Target.attachedToTarget' && params.sessionId) {
        const cid = params.sessionId;
        s.conn.sessions.set(cid, { sid: cid, conn: s.conn, tabId, child: cid, parent: s.sid });
      } else if (method === 'Target.detachedFromTarget' && params.sessionId) {
        this.#dropSubtree(s.conn, params.sessionId);
      }
      s.conn.emit(method, params, s.sid);
    }
  }

  /** A session leaving takes every session attached through it (child, grandchild, ...) with it. @param {CdpConn} conn @param {string} sid */
  #dropSubtree(conn, sid) {
    const doomed = new Set();
    const frontier = [sid];
    while (frontier.length) {
      const cur = /** @type {string} */ (frontier.pop());
      if (doomed.has(cur)) continue;
      doomed.add(cur);
      for (const s of conn.sessions.values()) if (s.parent === cur) frontier.push(s.sid);
    }
    for (const d of doomed) conn.sessions.delete(d);
  }

  /** @param {number} tabId */
  #debuggerDetached(tabId) {
    this.attached.delete(tabId);
    const targetId = this.byTab.get(tabId)?.targetId ?? '';
    this.observe.disabled(targetId, undefined, 'the debugger detached');
    for (const conn of this.conns) {
      for (const [sid, s] of [...conn.sessions]) {
        if (s.tabId !== tabId) continue;
        conn.sessions.delete(sid);
        if (s.child === null) conn.emit('Target.detachedFromTarget', { sessionId: sid, targetId });
      }
    }
  }

  /** A popup / new tab opened from an owned tab joins its opener's owner. Nothing else is adopted.
   * @param {ExtensionLink} link @param {number} tabId @param {number | null} openerTab @param {string | null} [owner] @param {string | null} [openerId] */
  async #adopt(link, tabId, openerTab, owner = null, openerId = null) {
    if (owner === null) {
      const opener = openerTab === null ? undefined : this.byTab.get(openerTab);
      if (!opener) return;
      owner = opener.owner;
      openerId = opener.targetId;
    }
    if (this.byTab.has(tabId) || this.ext !== link) return;
    const stamp = this.#tabStamp(tabId);
    this.pendingAdopt.set(tabId, { owner, openerId });
    this.stats.adoptionsStarted += 1;
    let info;
    try {
      info = await link.call('tabs.get', { tabId });
    } catch (e) {
      if (isExpected(e)) return;
      throw e;
    } finally {
      this.pendingAdopt.delete(tabId);
    }
    // The link was replaced (tab ids may now mean other pages), createTarget registered it, or the tab went away
    // while the answer was in flight.
    if (this.ext !== link || this.byTab.has(tabId) || !this.#sameTab(tabId, stamp)) return;
    const adopted = new Target(info.targetId, tabId, owner, info.url ?? '', info.title ?? '', openerId);
    if (typeof info.active === 'boolean') adopted.active = info.active;
    await this.#register(link, adopted);
  }

  /** Returns whether t is still registered afterwards. @param {ExtensionLink} link @param {Target} t */
  async #register(link, t) {
    if (this.ext !== link) return false;
    this.targets.set(t.targetId, t);
    this.byTab.set(t.tabId, t);
    try {
      await link.call('own', { tabId: t.tabId, owned: true });
    } catch (e) {
      if (!isExpected(e)) throw e; // a replaced link: the next reconciliation re-checks this target by targetId
    }
    // Cleared while we waited (new lifetime, tab closed): never announce a target that no longer exists.
    if (this.ext !== link || this.targets.get(t.targetId) !== t) return false;
    this.#broadcastTarget(t.owner, 'Target.targetCreated', { targetInfo: t.info(false) });
    return true;
  }

  /** @param {number} tabId */
  #targetGone(tabId) {
    const t = this.byTab.get(tabId);
    if (!t) return;
    this.byTab.delete(tabId);
    this.targets.delete(t.targetId);
    this.#debuggerDetached(tabId);
    this.observe.forget(t.targetId);
    this.handoffs.invalidate((h) => h.targetId === t.targetId, 'the tab was closed');
    this.#broadcastTarget(t.owner, 'Target.targetDestroyed', { targetId: t.targetId });
  }

  // ---------- client side ----------

  /** @param {CdpConn} conn */
  connOpened(conn) {
    this.conns.add(conn);
    this.#pushState();
  }

  /** @param {CdpConn} conn */
  async connClosed(conn) {
    this.conns.delete(conn);
    this.#pushState();
    const tabs = new Set([...conn.sessions.values()].map((s) => s.tabId));
    for (const tabId of tabs) this.observe.disabled(this.byTab.get(tabId)?.targetId ?? '', undefined, 'the client disconnected');
    conn.sessions.clear();
    for (const tabId of tabs) await this.#maybeDetach(tabId);
  }

  /** Disconnect every client whose principal no longer exists (client removed). Polled by the bridge. @param {Set<string>} live */
  revoke(live) {
    this.handoffs.invalidate((h) => !live.has(h.owner), 'the client was revoked');
    for (const c of [...this.conns]) {
      if (!live.has(c.client)) {
        this.log(`k-browser: client ${c.principal.name} revoked: disconnecting`);
        c.close();
      }
    }
  }

  /** @param {string} why */
  dropExtension(why) {
    for (const link of [this.ext, this.candidate]) if (link) this.extDisconnected(link);
    this.log(`k-browser: extension link dropped: ${why}`);
  }

  /** @param {CdpConn} conn @param {string} raw */
  async handle(conn, raw) {
    if (conn.closed) return; // a revoked or stuck connection runs nothing more, even before the bridge cleans it up
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || !Number.isInteger(msg.id)) return;
    const sid = typeof msg.sessionId === 'string' ? msg.sessionId : null;
    const method = msg.method;
    const params = msg.params ?? {};
    // which tab it is about, known before the command runs (the session may be gone after)
    const s = sid ? conn.sessions.get(sid) : undefined;
    const targetId = s ? this.byTab.get(s.tabId)?.targetId ?? null : typeof params?.targetId === 'string' ? params.targetId : null;
    /** @type {import('./activity.js').Outcome} */ let outcome = 'ok';
    /** @type {Record<string, any>} */
    let reply;
    try {
      if (typeof params !== 'object' || Array.isArray(params)) throw new CdpError('params must be an object');
      const result = sid ? await this.#sessionCommand(conn, sid, method, params) : await this.#browserCommand(conn, method, params);
      reply = { id: msg.id, result };
    } catch (e) {
      outcome = e instanceof CdpError && e.refused ? 'refused' : 'error';
      if (e instanceof CdpError) reply = { id: msg.id, error: { code: e.code, message: e.message } };
      else if (e instanceof ExtensionOffline) {
        const hint = this.candidate ? 'the extension is reconnecting' : 'Open Chrome with the K-Browser extension, then run `k-browser doctor`';
        reply = { id: msg.id, error: { code: -32000, message: `${e.message}. ${hint}.` } };
      } else if (e instanceof ExtensionError || e instanceof ResultUnknown) reply = { id: msg.id, error: { code: -32000, message: e.message } };
      else {
        // never let one command take the connection down
        this.log(`k-browser: internal error handling ${typeof method === 'string' ? method.slice(0, 80) : '?'} (${e instanceof Error ? e.constructor.name : 'error'})`);
        reply = { id: msg.id, error: { code: -32603, message: `K-Browser internal error (${e instanceof Error ? e.constructor.name : 'error'})` } };
      }
    }
    if (sid) reply.sessionId = sid;
    conn.post(reply);
    if (!QUIET.has(method)) {
      try {
        this.activity.command({ principal: conn.client, name: conn.principal.name, method, targetId, outcome, params: typeof params === 'object' && params ? params : {} });
      } catch { /* the record must never break a command */ }
    }
  }

  /** @param {CdpConn} conn @param {string} sid @param {unknown} method @param {Record<string, any>} params */
  async #sessionCommand(conn, sid, method, params) {
    const s = conn.sessions.get(sid);
    if (!s) throw new CdpError(SESSION_NOT_FOUND.message, SESSION_NOT_FOUND.code);
    if (method === 'KBrowser.setFileInput') return this.#setFileInput(conn, s, params);
    const denied = policy.check(method, params);
    if (denied) throw new CdpError(denied, -32000, { refused: true });
    const result = await this.#ext().call('dbg.send', { tabId: s.tabId, sessionId: s.child, method, params });
    // The observation log follows what the session really has on (never switched on by the bridge itself).
    const t = this.byTab.get(s.tabId);
    if (t && conn.sessions.get(sid) === s) {
      if (method === 'Network.enable') this.observe.enabled(t.targetId, t.owner, s.child);
      else if (method === 'Network.disable') this.observe.disabled(t.targetId, s.child, 'Network.disable');
      else if (method === 'Network.getResponseBody') this.observe.body(t.targetId, s.child, String(params.requestId), result ?? {});
    }
    return result;
  }

  /**
   * KBrowser.setFileInput { backendNodeId, name }: put a file from the caller's own file area into a file input.
   * The path is decided here from a plain name (src/files.js); DOM.setFileInputFiles itself stays refused to clients,
   * which could otherwise hand Chrome any local path. @param {CdpConn} conn @param {any} s @param {Record<string, any>} p
   */
  async #setFileInput(conn, s, p) {
    if (!Number.isInteger(p.backendNodeId)) throw new CdpError('backendNodeId: an integer');
    /** @type {string} */ let file;
    try {
      file = files.existing(conn.principal.id, p.name);
    } catch (e) {
      throw new CdpError(e instanceof Error ? e.message : String(e), -32000, { refused: true });
    }
    return this.#ext().call('dbg.send', { tabId: s.tabId, sessionId: s.child, method: 'DOM.setFileInputFiles',
      params: { files: [file], backendNodeId: p.backendNodeId } });
  }

  /** @param {CdpConn} conn @param {string | undefined} targetId */
  #owned(conn, targetId) {
    const t = this.targets.get(targetId ?? '');
    if (!t || t.owner !== conn.client) throw new CdpError(`No target with given id found: ${targetId}`);
    return t;
  }

  #ext() {
    if (!this.ext) throw new ExtensionOffline('K-Browser extension is not connected');
    return this.ext;
  }

  /** Close a tab; from the moment it is asked, no hand-off starts on it (set before the first await). @param {Target} t */
  async #close(t) {
    t.closing = true;
    try {
      await this.#ext().call('tabs.close', { tabId: t.tabId });
    } catch (e) {
      t.closing = false;
      throw e;
    }
  }

  /** @param {CdpConn} conn @param {unknown} method @param {Record<string, any>} p */
  async #browserCommand(conn, method, p) {
    switch (method) {
      case 'Browser.getVersion': {
        const hello = this.ext?.hello ?? {};
        return { protocolVersion: '1.3', product: hello.product ?? 'Chrome', revision: '', userAgent: hello.userAgent ?? '', jsVersion: '' };
      }
      case 'Target.getTargets':
        return { targetInfos: [...this.targets.values()].filter((t) => t.owner === conn.client).map((t) => t.info(this.#hasSessions(t.tabId, conn))) };
      case 'Target.getTargetInfo': {
        if (!p.targetId) return { targetInfo: { targetId: 'browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } };
        const t = this.#owned(conn, p.targetId);
        return { targetInfo: t.info(this.#hasSessions(t.tabId, conn)) };
      }
      case 'Target.createTarget':
        return this.#createTarget(conn, p);
      case 'Target.closeTarget':
        await this.#close(this.#owned(conn, p.targetId));
        return { success: true };
      case 'KBrowser.closeUnlessHandedOff': {
        // the check and the close are one step: no hand-off can start between them
        const t = this.#owned(conn, p.targetId);
        const h = this.handoffs.waitingFor(conn.client, t.targetId);
        if (h) return { closed: false, handoffId: h.handoffId };
        await this.#close(t);
        return { closed: true };
      }
      case 'Target.activateTarget': {
        const t = this.#owned(conn, p.targetId);
        await this.#ext().call('tabs.activate', { tabId: t.tabId });
        return {};
      }
      case 'Target.attachToTarget':
        return this.#attach(conn, p);
      case 'Target.detachFromTarget':
        return this.#detach(conn, p);
      case 'Target.setDiscoverTargets':
        conn.discover = Boolean(p.discover);
        if (conn.discover) {
          for (const t of this.targets.values()) {
            if (t.owner === conn.client) conn.emit('Target.targetCreated', { targetInfo: t.info(this.#hasSessions(t.tabId, conn)) });
          }
        }
        return {};
      case 'KBrowser.mark':
        return this.#mark(conn, p);
      case 'KBrowser.queryNetwork': {
        const t = this.#owned(conn, p.targetId);
        try {
          return this.observe.query(conn.client, t.targetId, p);
        } catch (e) {
          throw new CdpError(e instanceof Error ? e.message : String(e));
        }
      }
      case 'KBrowser.handoff': {
        const t = this.#owned(conn, p.targetId);
        if (t.closing) throw new CdpError('the tab is being closed: no hand-off');
        try {
          return view(this.handoffs.request(conn.client, t, p.reason));
        } catch (e) {
          throw new CdpError(e instanceof Error ? e.message : String(e));
        }
      }
      case 'KBrowser.handoffStatus':
        return view(this.handoffs.get(conn.client, p.handoffId), p.handoffId);
      case 'KBrowser.cancelHandoff':
        return view(this.handoffs.cancel(conn.client, p.handoffId), p.handoffId);
      case 'KBrowser.reportResult': {
        // what the client's wait_for found: kept as judged by the SDK, never as verified by the bridge
        const t = this.#owned(conn, p.targetId);
        try {
          this.activity.result({ principal: conn.client, name: conn.principal.name, targetId: t.targetId, verdict: p.verdict, level: p.level, recordIds: p.recordIds });
        } catch (e) {
          throw new CdpError(e instanceof Error ? e.message : String(e));
        }
        return {};
      }
      case 'KBrowser.tabHandoff': {
        const t = this.#owned(conn, p.targetId);
        const h = this.handoffs.waitingFor(conn.client, t.targetId);
        return h ? view(h) : { handoffId: null };
      }
      case 'KBrowser.getNavigation': {
        const t = this.#owned(conn, p.targetId);
        const nav = this.observe.navigation(t.targetId);
        return { ...nav, url: nav.url || t.url };
      }
      case 'Target.getBrowserContexts':
        return { browserContextIds: [] };
      case 'Target.createBrowserContext':
        throw new CdpError("K-Browser cannot create isolated browser contexts: tabs share the user's Chrome profile");
      case 'Target.disposeBrowserContext':
        throw new CdpError('K-Browser has no isolated browser contexts');
      // Browser-level Target.setAutoAttach is deliberately absent: it would have to succeed without doing anything.
      // New targets are announced through setDiscoverTargets; child frames through session-level setAutoAttach.
      default:
        throw new CdpError(`'${String(method)}' is not supported by K-Browser`, -32601, { refused: true });
    }
  }

  /**
   * KBrowser.mark: a point in the target's observation log that later queries count from. Before taking it, one
   * harmless command goes through the tab's debugger and back: Chrome delivers a session's events before the answer
   * to a later command, and the extension forwards both in order, so every event Chrome sent before the mark is in
   * the log by then (a request already under way is "before", not "after").
   * @param {CdpConn} conn @param {Record<string, any>} p
   */
  async #mark(conn, p) {
    const t = this.#owned(conn, p.targetId);
    if (p.label !== undefined && typeof p.label !== 'string') throw new CdpError('label must be a string');
    if (this.ext && this.attached.has(t.tabId)) {
      await this.ext.call('dbg.send', { tabId: t.tabId, sessionId: null, method: 'Page.getFrameTree', params: {} }).catch(() => {});
    }
    if (this.targets.get(t.targetId) !== t) throw new CdpError(`No target with given id found: ${t.targetId}`);
    const m = this.observe.mark(conn.client, t.targetId, p.label ?? '');
    this.activity.label({ principal: conn.client, name: conn.principal.name, targetId: t.targetId, label: m.label });
    return { actionId: m.actionId, t: m.t, label: m.label, source: m.source };
  }

  /** @param {CdpConn} conn @param {Record<string, any>} p */
  async #createTarget(conn, p) {
    if (p.browserContextId && p.browserContextId !== DEFAULT_CONTEXT) {
      throw new CdpError("K-Browser has no isolated browser contexts: tabs share the user's Chrome profile");
    }
    const url = p.url || 'about:blank';
    const bad = policy.checkUrl(url);
    if (bad) throw new CdpError(bad);
    const link = this.#ext();
    const epoch = this.tabGenEpoch;
    // One K-Browser window: "is it there / create it / publish its id" runs one at a time, or two first tabs created
    // at once would open two windows. Everything else about tabs stays concurrent.
    const r = await this.windowLock.run(async () => {
      // It may have gone stale while waiting for the lock: then no tab is opened that nobody would register.
      if (conn.closed || !this.conns.has(conn) || this.ext !== link) {
        throw new CdpError('this client was closed (or the extension reconnected) before the tab was created; no tab was opened');
      }
      const answer = await link.call('tabs.create', { url, active: !p.background, windowId: this.windowId });
      if (this.ext === link) this.windowId = answer.windowId ?? this.windowId;
      return answer;
    });
    if (this.ext !== link || conn.closed) {
      throw new ResultUnknown('the extension reconnected (or this client was closed) while the tab was being created: '
        + 'the tab may exist but is not registered; not retried');
    }
    // The new tab's id was unknown before the answer, so any removal recorded for it means it is already gone.
    if (epoch !== this.tabGenEpoch || this.tabGen.has(r.tabId)) {
      throw new ResultUnknown('the new tab was closed before it could be registered; not retried');
    }
    let t = this.byTab.get(r.tabId);
    if (!t) {
      t = new Target(r.targetId, r.tabId, conn.client, r.url ?? '', r.title ?? '');
      if (typeof r.active === 'boolean') t.active = r.active;
      // updates the extension sent once the tab was owned, before this point: they are no older than the answer
      const early = this.early.get(r.tabId);
      this.early.delete(r.tabId);
      if (early) {
        if (early.url !== undefined) t.url = early.url;
        if (early.title !== undefined) t.title = early.title;
        if (early.active !== undefined) t.active = early.active;
      }
      if (!await this.#register(link, t)) {
        throw new ResultUnknown('the tab went away (or the extension reconnected) while it was being registered; not retried');
      }
    }
    return { targetId: t.targetId };
  }

  /** @param {CdpConn} conn @param {Record<string, any>} p */
  async #attach(conn, p) {
    if (!p.flatten) throw new CdpError('K-Browser supports only flattened sessions (attachToTarget with flatten: true)');
    const t = this.#owned(conn, p.targetId);
    const link = this.#ext();
    const valid = () => this.ext === link && this.targets.get(t.targetId) === t && !conn.closed && this.conns.has(conn);
    /** @type {{ sid: string } | { gone: true } | { focusFailed: string }} */
    const outcome = await this.lock.run(async () => {
      if (!valid()) return { gone: true }; // it may have gone stale while waiting for the lock: then Chrome is not touched
      const holder = [...this.conns].flatMap((c) => [...c.sessions.values()]).find((s) => s.tabId === t.tabId && s.child === null);
      if (holder) {
        throw new CdpError(`target ${t.targetId} already has an operating session${holder.conn === conn ? ' on this connection' : ''}; K-Browser v0 allows one per target`);
      }
      if (!this.attached.has(t.tabId)) {
        await link.call('dbg.attach', { tabId: t.tabId });
        this.attached.add(t.tabId);
        this.observe.attached(t.targetId, t.owner);
      }
      if (!valid()) return { gone: true };
      // Part of attaching: K-Browser tabs share one window, so most are background tabs, which
      // Chrome hides and then ignores CDP input to; focus emulation makes them visible to input (measured in
      // a headed Chrome). It is page-observable (visibility, hasFocus). Kav sets the same itself;
      // a client may turn it off, and gets it back on its next root attach. If it cannot be set, the attach fails:
      // a session that silently cannot take input would be worse.
      try {
        await link.call('dbg.send', { tabId: t.tabId, sessionId: null, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } });
      } catch (e) {
        if (!isExpected(e)) throw e;
        return { focusFailed: e instanceof Error ? e.message : String(e) };
      }
      // Everything may have changed while Chrome attached and set it up: the link, the target, this connection.
      if (!valid()) return { gone: true };
      const id = randomBytes(16).toString('hex').toUpperCase();
      conn.sessions.set(id, { sid: id, conn, tabId: t.tabId, child: null, parent: null });
      return { sid: id };
    });
    if (!('sid' in outcome)) {
      await this.#maybeDetach(t.tabId);
      if ('focusFailed' in outcome) {
        throw new CdpError(`target ${t.targetId}: could not enable focus emulation (${outcome.focusFailed}); attach refused, `
          + 'as a background tab would not take input');
      }
      throw new CdpError(`target ${t.targetId} went away (or the extension reconnected) while attaching`);
    }
    const sid = outcome.sid;
    conn.emit('Target.attachedToTarget', { sessionId: sid, targetInfo: t.info(true), waitingForDebugger: false });
    return { sessionId: sid };
  }

  /** @param {CdpConn} conn @param {Record<string, any>} p */
  async #detach(conn, p) {
    const s = conn.sessions.get(p.sessionId ?? '');
    if (!s || s.child !== null) throw new CdpError(SESSION_NOT_FOUND.message, SESSION_NOT_FOUND.code);
    // One root per target: every child session on this tab hangs off this root and ends with it.
    for (const [sid, other] of [...conn.sessions]) if (other.tabId === s.tabId) conn.sessions.delete(sid);
    this.observe.disabled(this.byTab.get(s.tabId)?.targetId ?? '', undefined, 'the session detached');
    conn.emit('Target.detachedFromTarget', { sessionId: s.sid, targetId: this.byTab.get(s.tabId)?.targetId ?? '' });
    await this.#maybeDetach(s.tabId);
    return {};
  }

  // ---------- helpers ----------

  /** @param {number} tabId @param {string | null} child */
  #sessionsOn(tabId, child) {
    return [...this.conns].flatMap((c) => [...c.sessions.values()]).filter((s) => s.tabId === tabId && s.child === child);
  }

  /** @param {number} tabId @param {CdpConn} [conn] */
  #hasSessions(tabId, conn) {
    const conns = conn ? [conn] : [...this.conns];
    return conns.some((c) => [...c.sessions.values()].some((s) => s.tabId === tabId));
  }

  /** Public for tests. @param {number} tabId */
  hasSessions(tabId) {
    return this.#hasSessions(tabId);
  }

  /** No session left on a tab: detach chrome.debugger so session state (scripts, bindings) ends with it, as it would
   * in Chrome, and the 'being debugged' bar goes away. @param {number} tabId */
  async #maybeDetach(tabId) {
    await this.lock.run(async () => {
      if (this.attached.has(tabId) && !this.#hasSessions(tabId) && this.ext) {
        this.attached.delete(tabId);
        try {
          await this.ext.call('dbg.detach', { tabId });
        } catch (e) {
          if (!isExpected(e)) throw e;
        }
      }
    });
  }

  /** @param {string} owner @param {string} method @param {Record<string, any>} params */
  #broadcastTarget(owner, method, params) {
    for (const c of this.conns) if (c.client === owner && c.discover) c.emit(method, params);
    this.#pushState();
  }
}
