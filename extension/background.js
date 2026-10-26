// @ts-check
// K-Browser extension: a stateless forwarder between the k-browser bridge (127.0.0.1) and chrome.debugger / chrome.tabs.
// No content scripts, no DOM changes, nothing injected into pages. Only tabs the bridge marked as owned are reported.
// All state that matters lives in the bridge; this worker may be restarted by Chrome at any time.

import { isIdent, mac, PROTOCOL, randomHex, transcript } from './protocol.js';

const VERSION = chrome.runtime.getManifest().version;

// Chrome 125+ debuggee with a child session (OOPIF / worker). @types/chrome predates the sessionId field.
/** @typedef {{ tabId?: number, sessionId?: string }} Debuggee */
const PING_MS = 20000;

/**
 * One socket and everything that belongs to it. A command's result can only ever leave through the socket that
 * carried the command, and only while that socket is the current, authenticated one.
 * @typedef {{ sock: WebSocket, authed: boolean, script: string | null, chain: Promise<void>, ping: ReturnType<typeof setInterval> | undefined }} Conn
 */

/** @type {Conn | null} */
let current = null;
/** @type {Set<number>} */
let owned = new Set();
/** Popups an owned page opened that the bridge has not adopted (or refused) yet: their removal must still be
 * reported, or an adoption in flight would register a tab that is already gone. @type {Set<number>} */
let pending = new Set();
let retryMs = 1000;
/** Advances whenever a new connection attempt supersedes older ones (settings changed, reconnect asked): an attempt
 * that finds it is no longer the latest after an await gives up instead of overwriting `current`. */
let attempt = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let retryTimer = null;

// ---------- status (read by the popup) ----------

/** @param {string} state @param {string} [detail] */
async function setStatus(state, detail = '') {
  try { await chrome.storage.local.set({ status: { state, detail, at: Date.now() } }); } catch { /* storage unavailable */ }
}

// profileId: this Chrome profile, for good (storage.local). bootId: this extension lifetime — storage.session is
// cleared when the browser restarts and when the extension is disabled, reloaded or updated, but survives a
// service-worker restart. The bridge treats a new bootId as "tab ids may now name other pages".
async function identity() {
  let { profileId } = await chrome.storage.local.get('profileId');
  if (!isIdent(profileId)) { profileId = randomHex(16); await chrome.storage.local.set({ profileId }); }
  let { bootId } = await chrome.storage.session.get('bootId');
  if (!isIdent(bootId)) { bootId = randomHex(16); await chrome.storage.session.set({ bootId }); }
  return { profileId, bootId };
}

// ---------- connection ----------

/** Events go to the current authenticated socket only. @param {Record<string, any>} obj */
function sendEvent(obj) {
  const c = current;
  if (c && c.authed && c.sock.readyState === WebSocket.OPEN) c.sock.send(JSON.stringify(obj));
}

/** A reply leaves through the socket the command came on, and only while it is still current and authenticated.
 * A reconnect in between drops it: the bridge reports that command as "effect unknown".
 * @param {Conn} conn @param {Record<string, any>} obj */
function reply(conn, obj) {
  if (conn === current && conn.authed && conn.sock.readyState === WebSocket.OPEN) conn.sock.send(JSON.stringify(obj));
}

function scheduleReconnect() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, retryMs);
  retryMs = Math.min(retryMs * 2, 10000);
}

async function connect() {
  if (current && (current.sock.readyState === WebSocket.CONNECTING || current.sock.readyState === WebSocket.OPEN)) return;
  const mine = ++attempt;
  const { pairKey, port = 9444 } = await chrome.storage.local.get(['pairKey', 'port']);
  if (mine !== attempt || current) return; // superseded while reading settings (they may be the old ones)
  if (!pairKey) { await setStatus('unpaired', chrome.i18n.getMessage('bgUnpaired')); return; }
  let sock;
  try { sock = new WebSocket(`ws://127.0.0.1:${port}/ext`); } catch { scheduleReconnect(); return; }
  /** @type {Conn} */
  const conn = { sock, authed: false, script: null, chain: Promise.resolve(), ping: undefined };
  current = conn;
  // Messages are handled one after another while authenticating (the welcome check awaits crypto, and the first
  // command can arrive right behind it); once authenticated, commands run concurrently.
  sock.onmessage = (e) => { conn.chain = conn.chain.then(() => onMessage(conn, pairKey, e.data)).catch(() => {}); };
  sock.onclose = async () => {
    clearInterval(conn.ping);
    if (current !== conn) return;
    current = null;
    const { status } = await chrome.storage.local.get('status');
    if (!status || status.state === 'online' || status.state === 'connecting') await setStatus('offline', 'bridge not reachable; retrying');
    scheduleReconnect();
  };
  sock.onerror = () => {};
}

/** @param {Conn} conn @param {string} key @param {any} data */
async function onMessage(conn, key, data) {
  if (conn !== current) return; // a retired socket's queued messages die with it: nothing of it runs any more
  let m;
  try { m = JSON.parse(String(data)); } catch { return; }
  if (conn.authed) {
    if (m.t === 'cmd') void handle(conn, m);
    return;
  }
  if (m.t === 'hello') {
    if (m.v !== PROTOCOL) { await setStatus('error', `bridge protocol ${m.v}, extension ${PROTOCOL}: update both`); conn.sock.close(); return; }
    if (!isIdent(m.nonce)) { conn.sock.close(); return; }
    const myNonce = randomHex(16);
    conn.script = transcript(m.nonce, myNonce);
    const { profileId, bootId } = await identity();
    const product = (navigator.userAgent.match(/Chrome\/[\d.]+/) || ['Chrome'])[0];
    const proof = await mac(key, 'ext', conn.script);
    if (conn !== current) return;
    conn.sock.send(JSON.stringify({ t: 'hello', v: PROTOCOL, nonce: myNonce, mac: proof,
      profileId, bootId, version: VERSION, userAgent: navigator.userAgent, product }));
  } else if (m.t === 'welcome') {
    // The bridge must prove it knows the pairing key too: whoever grabbed the port first gets nothing.
    const expected = conn.script ? await mac(key, 'bridge', conn.script) : null;
    if (conn !== current) return; // superseded while we checked: this socket never becomes authenticated
    if (!expected || m.mac !== expected) {
      await setStatus('error', 'the server on this port is not your k-browser bridge');
      conn.sock.close();
      return;
    }
    conn.authed = true;
    retryMs = 1000;
    conn.ping = setInterval(() => { if (conn.sock.readyState === WebSocket.OPEN) conn.sock.send('{"t":"ping"}'); }, PING_MS);
    await setStatus('online', `bridge ${m.version}`);
    // a side panel already open: the bridge (new, or restarted) starts sending it updates again
    if (panels.size) sendEvent({ t: 'ev', ev: 'panel.open' });
  } else if (m.t === 'error') {
    await setStatus('error', m.message || m.code);
  }
}

// ---------- commands ----------

/** @param {number} tabId */
async function targetIdFor(tabId) {
  for (let i = 0; i < 40; i++) {
    const t = (await chrome.debugger.getTargets()).find((x) => x.tabId === tabId);
    if (t) return t.id;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no debugger target for tab ${tabId}`);
}

/** @param {chrome.tabs.Tab} tab */
async function tabInfo(tab) {
  const tabId = /** @type {number} */ (tab.id);
  const targetId = await targetIdFor(tabId);
  // Read the tab again, as late as possible: a fast page can set its title while the tab is being created, before it is
  // owned (its onUpdated is not reported) or before the bridge has registered it (the update is dropped there), and the
  // bridge would keep an empty title until the next change (seen in CfT: panel.test's background-tab case)
  const now = await chrome.tabs.get(tabId).catch(() => tab);
  return { tabId, windowId: now.windowId, targetId, url: now.pendingUrl || now.url || '', title: now.title || '', active: now.active === true };
}

// Commands that need the page rendered: a minimized window's pages take no input and give no screenshot
// (measured in a headed Chrome). Checked on the tab's ACTUAL window: a popup may have opened its own window,
// or the user may have dragged the tab out.
const NEEDS_RENDERING = new Set(['Page.captureScreenshot', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText']);

// On macOS the restored window comes back on top of every window, but the keyboard stays with the user's app
// (measured; accepted: the user minimized it, it pops up once, the agent never stalls).
/** @param {number} tabId */
async function ensureNotMinimized(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (win && win.state === 'minimized') await chrome.windows.update(tab.windowId, { state: 'normal', focused: false });
}

/** @type {Record<string, (args: any) => Promise<any>>} */
const OPS = {
  async 'tabs.alive'({ tabIds }) {
    // tabId -> current debugger targetId, so the bridge can tell "same page" from "tab id reused".
    const targets = await chrome.debugger.getTargets();
    /** @type {Record<string, string>} */
    const alive = {};
    for (const id of tabIds) {
      const t = targets.find((x) => x.tabId === id);
      if (t) alive[String(id)] = t.id;
    }
    return alive;
  },
  async 'own.sync'({ tabIds }) {
    // Set the owned set first, so a tab closing from now on is reported as tab.removed; then report owned tabs that
    // are already gone. Sessions never survive a reconnect: detach every tab this extension left attached, whether or
    // not the bridge still remembers it (a restarted bridge remembers nothing).
    owned = new Set(tabIds);
    pending = new Set();
    const targets = await chrome.debugger.getTargets();
    for (const t of targets) {
      if (t.attached && t.tabId != null) await chrome.debugger.detach({ tabId: t.tabId }).catch(() => {});
    }
    const present = new Set(targets.map((t) => t.tabId).filter((x) => x != null));
    return { missing: tabIds.filter((/** @type {number} */ id) => !present.has(id)) };
  },
  async own({ tabId, owned: on }) {
    pending.delete(tabId);
    if (on) owned.add(tabId); else owned.delete(tabId);
    return true;
  },
  async 'tabs.create'({ url, active, windowId }) {
    // All K-Browser tabs live in one window of their own, never focused, never minimized: a minimized
    // window's pages cannot be screenshotted and their timers are throttled (measured in a headed Chrome).
    // Background tabs in it are hidden; the bridge turns on focus emulation per session, which makes them visible
    // to input (without it, CDP input to a hidden background tab hangs).
    let tab;
    const win = windowId == null ? null : await chrome.windows.get(windowId).catch(() => null);
    if (win) {
      if (win.state === 'minimized') await chrome.windows.update(windowId, { state: 'normal', focused: false });
      tab = await chrome.tabs.create({ windowId, url, active: !!active });
    } else {
      // Never focused, whatever the client asked: an agent must not take the keyboard from the
      // user. `active` only picks the tab inside the K-Browser window.
      const w = await chrome.windows.create({ url, focused: false, type: 'normal', width: 1280, height: 900 });
      tab = /** @type {chrome.tabs.Tab[]} */ (w?.tabs)[0];
    }
    owned.add(/** @type {number} */ (tab.id));
    return tabInfo(tab);
  },
  async 'tabs.get'({ tabId }) { return tabInfo(await chrome.tabs.get(tabId)); },
  async 'tabs.close'({ tabId }) { await chrome.tabs.remove(tabId); return true; },
  async 'tabs.activate'({ tabId }) {
    await chrome.tabs.update(tabId, { active: true }); // within its window only; the window is never focused
    return true;
  },
  async 'dbg.attach'({ tabId }) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      // Left attached by a previous worker lifetime: start clean so stale scripts and bindings go away.
      if (!String(e instanceof Error ? e.message : e).includes('already attached')) throw e;
      await chrome.debugger.detach({ tabId }).catch(() => {});
      await chrome.debugger.attach({ tabId }, '1.3');
    }
    return true;
  },
  async 'dbg.detach'({ tabId }) { await chrome.debugger.detach({ tabId }).catch(() => {}); return true; },
  async 'panel.push'(batch) {
    // updates for the side panels: answered only once every open panel has taken them (it acks), so a stuck panel
    // makes the bridge's own bounded queue drop and mark a gap, instead of updates piling up here
    const gate = /** @type {any} */ (globalThis).kbPanelGate; // a test can hold them here, as a slow worker would
    if (gate) await gate;
    await Promise.all([...panels].map((port) => toPanel(port, batch)));
    return true;
  },
  async 'tabs.show'({ tabId }) {
    // the user clicked the tab in the side panel (the bridge checked it is that client's)
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true, state: 'normal' });
    await chrome.tabs.update(tabId, { active: true });
    return true;
  },
  async 'handoff.sync'({ items }) {
    // The hand-offs waiting for the user (src/handoff.js): the popup lists them, the badge counts them.
    const list = Array.isArray(items) ? items : [];
    await chrome.storage.session?.set({ handoffs: list });
    await chrome.action?.setBadgeBackgroundColor?.({ color: '#d93025' });
    await chrome.action?.setBadgeText?.({ text: list.length ? String(list.length) : '' });
    return true;
  },
  async 'dbg.send'({ tabId, sessionId, method, params }) {
    if (NEEDS_RENDERING.has(method)) await ensureNotMinimized(tabId);
    /** @type {Debuggee} */
    const target = sessionId ? { tabId, sessionId } : { tabId };
    return (await chrome.debugger.sendCommand(/** @type {chrome.debugger.Debuggee} */ (target), method, params || {})) || {};
  },
};

/** @param {Conn} conn @param {Record<string, any>} m */
async function handle(conn, m) {
  if (conn !== current || !conn.authed) return; // not started yet and already retired: do not touch Chrome
  const op = OPS[m.op];
  if (!op) { reply(conn, { t: 'res', id: m.id, ok: false, error: `unknown op ${m.op}` }); return; }
  try {
    reply(conn, { t: 'res', id: m.id, ok: true, result: await op(m.args || {}) });
  } catch (e) {
    reply(conn, { t: 'res', id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

// ---------- events (owned tabs only) ----------

chrome.debugger.onEvent.addListener((src, method, params) => {
  const source = /** @type {Debuggee} */ (src);
  if (source.tabId == null || !owned.has(source.tabId)) return;
  sendEvent({ t: 'ev', ev: 'dbg.event', tabId: source.tabId, sessionId: source.sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null || !owned.has(source.tabId)) return;
  sendEvent({ t: 'ev', ev: 'dbg.detach', tabId: source.tabId, reason });
});

// Popups opened BY an owned page (window.open, target=_blank): the bridge decides whether to adopt them.
// tabs.onCreated's openerTabId is not used: Chrome sets it to the window's active tab for any new tab, including one
// the user opens with Ctrl+T, which would hand the user's tab to an agent.
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  if (!owned.has(d.sourceTabId)) return;
  pending.add(d.tabId); // watched from now on, so a close before adoption completes is reported
  sendEvent({ t: 'ev', ev: 'tab.created', tabId: d.tabId, openerTabId: d.sourceTabId });
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (owned.has(tabId) && (change.url || change.title)) sendEvent({ t: 'ev', ev: 'tab.updated', tabId, url: tab.url, title: tab.title });
});

// which owned tab is the one shown in its window (the panel marks the others as background tabs). Read from
// Chrome each time, not remembered: a restarted service worker would have forgotten which tab was shown before
chrome.tabs.onActivated?.addListener(({ windowId }) => {
  chrome.tabs.query({ windowId }).then((tabs) => {
    for (const t of tabs) if (t.id != null && owned.has(t.id)) sendEvent({ t: 'ev', ev: 'tab.updated', tabId: t.id, active: t.active === true });
  }).catch(() => {});
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  // Prerender activation / discard swaps the tab: the bridge retires the old target and adopts the new tab.
  if (!owned.has(removedTabId) && !pending.has(removedTabId)) return;
  owned.delete(removedTabId);
  pending.delete(removedTabId);
  pending.add(addedTabId); // the replacement is watched until the bridge adopts (or refuses) it
  sendEvent({ t: 'ev', ev: 'tab.replaced', addedTabId, removedTabId });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!owned.has(tabId) && !pending.has(tabId)) return;
  owned.delete(tabId);
  pending.delete(tabId);
  sendEvent({ t: 'ev', ev: 'tab.removed', tabId });
});

// ---------- hand-offs (the user's side) ----------

/** The user gave a tab back: only the popup calls this, on the user's click. @param {string} handoffId */
function returnHandoff(handoffId) {
  sendEvent({ t: 'ev', ev: 'handoff.return', handoffId: String(handoffId) });
  return true;
}
/** @type {any} */ (globalThis).kbReturnHandoff = returnHandoff; // what the popup's button does, reachable by tests

/** Bring a waiting tab to the front: only on the user's click in the popup (never take the focus on our own).
 * @param {number} tabId */
async function showHandoff(tabId) {
  const { handoffs = [] } = (await chrome.storage.session?.get('handoffs')) ?? {};
  if (!handoffs.some((/** @type {any} */ h) => h.tabId === tabId)) return false;
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true, state: 'normal' });
  await chrome.tabs.update(tabId, { active: true });
  return true;
}

// ---------- the side panel ----------

/** @type {Set<chrome.runtime.Port>} open side panels */
const panels = new Set();
const PANEL_ACK_MS = 5000;
let panelAcks = 0;
/** @type {Map<number, () => void>} */
const waitingAcks = new Map();

/** @param {chrome.runtime.Port} port */
function dropPanel(port) {
  if (!panels.delete(port)) return;
  if (panels.size === 0) sendEvent({ t: 'ev', ev: 'panel.close' });
}

/** Hand a batch to one panel and wait until it says it took it. @param {chrome.runtime.Port} port @param {any} batch */
function toPanel(port, batch) {
  const n = ++panelAcks;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waitingAcks.delete(n);
      // a stuck panel gets nothing more: it is let go, and reconnects (with a fresh snapshot) once it runs again
      dropPanel(port);
      try { port.disconnect(); } catch { /* gone */ }
      reject(new Error('the panel did not take the update in time'));
    }, PANEL_ACK_MS);
    waitingAcks.set(n, () => { clearTimeout(timer); waitingAcks.delete(n); resolve(undefined); });
    try {
      port.postMessage({ type: 'push', batch, ack: n });
    } catch (e) {
      clearTimeout(timer);
      waitingAcks.delete(n);
      reject(e);
    }
  });
}
const PANEL_OPS = new Set(['show', 'return', 'closeTabs', 'revoke', 'model', 'decisionLog', 'sites', 'screenshot', 'eval']);
/** settings of one client, named as the panel showed it: name (as on disk, at most 32 characters) and principal */
const CLIENT_OPS = new Set(['sites', 'screenshot', 'eval']);

/** Is this our own panel document (not a web page, another extension, or another of our pages)? It may be the side
 * panel or panel.html in a tab: no web page can open it (it is not web-accessible). @param {any} sender */
function fromPanel(sender) {
  return Boolean(chrome.runtime.id) && sender?.id === chrome.runtime.id && sender?.url === chrome.runtime.getURL?.('panel.html');
}

/** One of the panel's commands: the model choice, the decision dataset, a client's settings, or one of four by
 * principal id (never by name); only well-typed fields go on, and the bridge checks each again. @param {any} m */
function panelCommand(m) {
  if (!m || m.type !== 'cmd' || !PANEL_OPS.has(m.op)) return false;
  if (m.op === 'model') {
    if (!['kev', 'jev', 'off'].includes(m.backend)) return false;
    sendEvent({ t: 'ev', ev: 'panel.cmd', op: 'model', backend: m.backend, ...(Number.isInteger(m.consentVersion) ? { consentVersion: m.consentVersion } : {}) });
    return true;
  }
  if (m.op === 'decisionLog') {
    if (typeof m.on !== 'boolean') return false;
    sendEvent({ t: 'ev', ev: 'panel.cmd', op: 'decisionLog', on: m.on });
    return true;
  }
  if (CLIENT_OPS.has(m.op)) {
    const short = (/** @type {unknown} */ v, /** @type {number} */ n) => typeof v === 'string' && v.length > 0 && v.length <= n;
    if (!short(m.name, 32) || !short(m.principal, 64) || typeof m.on !== 'boolean') return false;
    if (m.op === 'eval' && m.on) return false; // the panel only turns eval off
    if (m.op === 'sites' && !short(m.category, 32)) return false;
    sendEvent({ t: 'ev', ev: 'panel.cmd', op: m.op, name: m.name, principal: m.principal, on: m.on, ...(m.op === 'sites' ? { category: m.category } : {}) });
    return true;
  }
  if (typeof m.principal !== 'string') return false;
  sendEvent({ t: 'ev', ev: 'panel.cmd', op: m.op, principal: m.principal.slice(0, 64),
    ...(typeof m.targetId === 'string' ? { targetId: m.targetId.slice(0, 64) } : {}),
    ...(typeof m.handoffId === 'string' ? { handoffId: m.handoffId.slice(0, 64) } : {}) });
  return true;
}

chrome.runtime.onConnect?.addListener((port) => {
  if (port.name !== 'panel' || !fromPanel(port.sender)) { port.disconnect(); return; }
  panels.add(port);
  if (panels.size === 1) sendEvent({ t: 'ev', ev: 'panel.open' });
  port.onMessage.addListener((m) => {
    if (m && m.type === 'ack' && Number.isInteger(m.ack)) waitingAcks.get(m.ack)?.();
    else panelCommand(m);
  });
  port.onDisconnect.addListener(() => dropPanel(port));
});

// ---------- lifecycle ----------

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  // from this extension's own popup or panel document only, never from a tab's content or another extension
  const own = Boolean(chrome.runtime.id) && sender?.id === chrome.runtime.id
    && ['popup.html', 'panel.html'].some((p) => sender?.url === chrome.runtime.getURL?.(p));
  if (own && msg?.type === 'handoff.return') { respond(returnHandoff(msg.handoffId)); return false; }
  if (own && msg?.type === 'handoff.show') { void showHandoff(Number(msg.tabId)).then(respond, () => respond(false)); return true; }
  if (msg && msg.type === 'reconnect') {
    attempt += 1;
    const c = current;
    current = null;
    if (c) { try { c.sock.close(); } catch { /* closed */ } }
    retryMs = 1000;
    void connect().then(() => respond(true));
    return true;
  }
  return false;
});

// A new pairing code (or port) takes effect at once, whoever wrote it.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.pairKey || changes.port)) return;
  attempt += 1; // any attempt still reading the old settings is now stale
  const c = current;
  current = null;
  if (c) { try { c.sock.close(); } catch { /* closed */ } }
  retryMs = 1000;
  void connect();
});

chrome.alarms.create('k-browser-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'k-browser-reconnect') void connect(); });
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
void connect();
