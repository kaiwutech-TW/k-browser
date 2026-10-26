// @ts-check
// The side panel: which program opened which tabs and what it did, and four ways to step in; where
// Kav's decisions go; the decision dataset and each client's sites, screenshots and eval.
// Everything shown comes from the bridge; page titles, URLs, labels and reasons are shown as plain text only
// (textContent), cut to a length: a hostile title cannot add markup, trigger anything or pose as another entry.
// Labels and reasons are marked as client-provided; wait_for results as judged by the SDK, never as verified.

const MAX = { title: 120, url: 200, label: 200, reason: 200, entries: 200 };
const statusEl = /** @type {HTMLElement} */ (document.getElementById('status'));
const gapEl = /** @type {HTMLElement} */ (document.getElementById('gap'));
const clientsEl = /** @type {HTMLElement} */ (document.getElementById('clients'));
const aboutEl = /** @type {HTMLElement} */ (document.getElementById('about'));
const configuredEl = /** @type {HTMLElement} */ (document.getElementById('configured'));
const modelBoxEl = /** @type {HTMLElement} */ (document.getElementById('modelBox'));
const modelEl = /** @type {HTMLElement} */ (document.getElementById('model'));
const decisionsBoxEl = /** @type {HTMLElement} */ (document.getElementById('decisionsBox'));
const decisionsEl = /** @type {HTMLElement} */ (document.getElementById('decisions'));

/** about / configured: versions and the clients set up on this machine, idle or not; bridges older than 0.2 send neither
 * @type {{ clients: any[], tabs: any[], handoffs: any[], about?: any, configured?: any[] }} */
let state = { clients: [], tabs: [], handoffs: [] };
/** @type {Map<string, Map<number, any>>} principal -> entry id -> entry */
const entries = new Map();
/** @type {chrome.runtime.Port | null} */
let port = null;
let received = 0;
/** revoke asks twice: principal -> until when the second click counts */
const confirming = new Map();
/** the JEV agreement is open (choosing JEV here means reading it and agreeing) */
let agreeing = false;
/** names of the configured clients whose settings are open */
const settingsOpen = new Set();
const BACKENDS = { kev: msg('backendKev'), jev: msg('backendJev'), off: msg('backendOff') };
const PROBLEMS = { cloud_not_enabled: msg('problemCloud'), jev_key_missing: msg('problemKey'), config_unreadable: msg('problemConfig') };
const onOff = (/** @type {unknown} */ b) => msg(b ? 'on' : 'off');
/** a clock time in the panel's language, not the system's @param {number} t */
const time = (t) => new Date(t).toLocaleTimeString(msg('lang'));

/** @param {string} tag @param {string} [text] @param {string} [cls] */
function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
/** @param {unknown} s @param {number} n */
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };
/** @param {number} t */
const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? msg('agoSec', s) : s < 3600 ? msg('agoMin', Math.round(s / 60)) : msg('agoHour', Math.round(s / 3600)); };
/** @param {Record<string, any>} m */
const send = (m) => port?.postMessage({ type: 'cmd', ...m });

/** @param {any} e */
function entryRow(e) {
  if (e.kind === 'label') {
    const row = el('div', clip(e.label, MAX.label), 'entry label');
    row.append(el('span', msg('tagClient'), 'tag'));
    return row;
  }
  if (e.kind === 'result') {
    const row = el('div', `${msg('verdict', e.verdict)}${e.level ? ` · ${e.level}` : ''}${e.recordIds?.length ? ` · ${msg('records', e.recordIds.join(', '))}` : ''}`, 'entry');
    row.append(el('span', msg('tagSdk'), 'tag'));
    return row;
  }
  const text = `${time(e.t)} ${e.method}${e.count > 1 ? ` ×${e.count}` : ''}${e.url ? ` ${clip(e.url, MAX.url)}` : ''}`
    + (e.outcome === 'ok' ? '' : e.outcome === 'refused' ? msg('outcomeRefused') : msg('outcomeError'));
  return el('div', text, `entry ${e.outcome}`);
}

function render() {
  clientsEl.replaceChildren();
  for (const c of state.clients) {
    const box = el('div', undefined, 'client');
    const head = el('div');
    head.append(el('strong', clip(c.name, 40)), el('span', ` #${String(c.principal).slice(0, 6)}`, 'muted'),
      el('div', `${msg(c.connections === 1 ? 'connection1' : 'connections', c.connections)}${c.lastActive ? ` · ${msg('lastActive', ago(c.lastActive))}` : ''}`, 'muted'));
    box.append(head);

    for (const h of state.handoffs.filter((x) => x.principal === c.principal)) {
      const hb = el('div', undefined, 'handoff');
      hb.append(el('div', msg('handoffWaiting', clip(h.reason, MAX.reason))), el('span', msg('tagClient'), 'tag'), el('div', msg('handoffSince', ago(h.since)), 'muted'));
      const show = el('button', msg('btnShow'), 'small');
      show.addEventListener('click', () => send({ op: 'show', principal: c.principal, targetId: h.targetId }));
      const back = el('button', msg('btnReturn'), 'primary small');
      back.addEventListener('click', () => send({ op: 'return', principal: c.principal, handoffId: h.handoffId }));
      hb.append(show, back);
      box.append(hb);
    }

    const tabs = state.tabs.filter((t) => t.principal === c.principal);
    if (tabs.length) box.append(el('h2', msg('tabsHeading', tabs.length)));
    for (const t of tabs) {
      const row = el('div', undefined, 'tab');
      row.append(el('div', `${clip(t.title || msg('untitled'), MAX.title)}${t.openedBy ? msg('openedByPopup') : ''}${t.background ? msg('backgroundTab') : ''}`), el('div', clip(t.url, MAX.url), 'url'));
      row.addEventListener('click', () => send({ op: 'show', principal: c.principal, targetId: t.targetId }));
      box.append(row);
    }

    const close = el('button', msg('closeTabs'), 'small');
    close.addEventListener('click', () => send({ op: 'closeTabs', principal: c.principal }));
    const revoke = el('button', (confirming.get(c.principal) ?? 0) > Date.now() ? msg('revokeConfirm') : msg('revoke'), 'danger small');
    revoke.addEventListener('click', () => {
      if ((confirming.get(c.principal) ?? 0) > Date.now()) {
        confirming.delete(c.principal);
        send({ op: 'revoke', principal: c.principal });
      } else {
        confirming.set(c.principal, Date.now() + 5000);
        setTimeout(render, 5100);
      }
      render();
    });
    box.append(close, revoke);

    const list = [...(entries.get(c.principal)?.values() ?? [])].sort((a, b) => a.id - b.id).slice(-MAX.entries);
    if (list.length) box.append(el('h2', msg('actionLog')));
    for (const e of list.reverse()) box.append(entryRow(e));
    clientsEl.append(box);
  }
  if (!state.clients.length) clientsEl.append(el('div', msg('noClients'), 'muted'));

  const a = state.about;
  aboutEl.textContent = a ? msg('about', clip(a.version, 20), clip(a.extension ?? '?', 20), msg(a.launchd ? 'startedLaunchd' : 'startedManual'), onOff(a.decisionLog)) : '';
  configuredEl.replaceChildren();
  for (const c of state.configured ?? []) {
    const row = el('div', undefined, 'cfg');
    row.append(el('span', clip(c.name, 40)), el('span', msg(c.connected ? 'connected' : 'idle'), c.connected ? 'tag on' : 'tag'));
    const bits = [c.allowList ? msg('allowListOnly') : msg('blockedN', Number(c.blocked) || 0), msg('screenshotState', onOff(c.screenshot)), msg('evalState', onOff(c.eval))];
    row.append(el('div', bits.join(' · '), 'muted'));
    // bridges older than 0.3.8 send no categories: they take none of the settings commands
    if (Array.isArray(a?.categories)) {
      const open = settingsOpen.has(c.name);
      const btn = el('button', msg(open ? 'settingsClose' : 'settingsOpen'), 'ghost small');
      btn.addEventListener('click', () => { if (open) settingsOpen.delete(c.name); else settingsOpen.add(c.name); render(); });
      row.append(btn);
      if (open) row.append(settingsBox(c, a.categories));
    }
    configuredEl.append(row);
  }
  if (state.configured && !state.configured.length) configuredEl.append(el('div', msg('noConfigured'), 'muted'));
  renderModel(a?.model);
  renderDecisions(a);
}

/** One client's settings: blocked site categories, screenshots on or off, eval off only (turning it
 * on stays in a terminal). They are read when that program's k-browser MCP server starts, so they apply after a
 * reconnect; the JEV refusal of a client with any blocking is read per request. @param {any} c @param {any[]} cats */
function settingsBox(c, cats) {
  const box = el('div', undefined, 'consent settings');
  const who = { name: String(c.name), principal: String(c.principal) };
  if (c.allowList) {
    box.append(el('div', msg('allowListNote'), 'muted'));
  } else if (!c.sites) {
    box.append(el('div', msg('blockedNotList'), 'refused'));
  } else {
    box.append(el('div', msg('categoriesHint'), 'hint'));
    for (const k of cats) {
      const on = Array.isArray(c.sites.on) && c.sites.on.includes(k.id);
      const part = Array.isArray(c.sites.part) && c.sites.part.includes(k.id);
      const label = chrome.i18n.getMessage(`cat_${k.id}`) || k.label; // the bridge's label (Chinese) for a category this extension does not know
      const btn = el('button', `${on ? '✓ ' : ''}${clip(label, 30)}${part ? msg('partial') : ''}`, on ? 'chip on' : part ? 'chip part' : 'chip');
      btn.ariaPressed = on ? 'true' : 'false';
      btn.addEventListener('click', () => send({ op: 'sites', ...who, category: String(k.id), on: !on }));
      box.append(btn);
    }
    if (Number(c.sites.other) > 0) box.append(el('div', msg('otherSites', Number(c.sites.other)), 'muted'));
    box.append(el('div', msg('anyBlockNoJev'), 'muted'));
  }
  const shot = el('div', msg('screenshotLabel', onOff(c.screenshot)), 'setting');
  const shotBtn = el('button', msg(c.screenshot ? 'screenshotOff' : 'screenshotOn'), 'small');
  shotBtn.addEventListener('click', () => send({ op: 'screenshot', ...who, on: !c.screenshot }));
  shot.append(shotBtn);
  box.append(shot);
  if (c.eval) {
    const ev = el('div', msg('evalOnLabel'), 'setting');
    const evBtn = el('button', msg('evalOff'), 'small');
    evBtn.addEventListener('click', () => send({ op: 'eval', ...who, on: false }));
    ev.append(evBtn);
    box.append(ev);
  } else {
    box.append(el('div', msg('evalOffNote', clip(c.name, 40)), 'setting'));
  }
  box.append(el('div', msg('settingsApply'), 'muted'));
  return box;
}

/** The decision dataset (src/decisions.js): on or off here; deleting it stays in a terminal. Hidden for bridges older
 * than 0.3.8 (no categories: they take no settings commands). @param {any} a */
function renderDecisions(a) {
  decisionsBoxEl.hidden = !Array.isArray(a?.categories);
  decisionsEl.replaceChildren();
  if (decisionsBoxEl.hidden) return;
  decisionsEl.append(el('div', msg('current', onOff(a.decisionLog)), `cfg current ${a.decisionLog ? 'ok' : 'idle'}`),
    el('div', msg('decisionsExplain'), 'muted'));
  const btn = el('button', msg(a.decisionLog ? 'decisionsOff' : 'decisionsOn'), 'small');
  btn.addEventListener('click', () => send({ op: 'decisionLog', on: !a.decisionLog }));
  decisionsEl.append(btn, el('div', msg('decisionsPurge'), 'muted'));
}

/** Where Kav's decisions go: kev and off at one click; JEV only after reading the agreement here, and
 * only with a key already imported in a terminal (the key never passes through the browser). Bridges older than 0.3.8
 * send no model: the section stays hidden. @param {any} m */
function renderModel(m) {
  modelBoxEl.hidden = !m;
  modelEl.replaceChildren();
  if (!m) return;
  const now = m.backend ? (BACKENDS[/** @type {keyof typeof BACKENDS} */ (m.backend)] ?? clip(m.backend, 20)) : msg('unknown');
  const problem = m.problem ? PROBLEMS[/** @type {keyof typeof PROBLEMS} */ (m.problem)] ?? clip(m.problem, 60) : '';
  modelEl.append(el('div', msg('current', now), `cfg current ${m.problem ? 'warn' : m.backend === 'off' ? 'idle' : 'ok'}`));
  if (problem) modelEl.append(el('div', problem, 'cfg refused'));
  for (const b of /** @type {const} */ (['kev', 'off'])) {
    if (m.backend === b && !m.problem) continue;
    const btn = el('button', msg(b === 'kev' ? 'useKev' : 'modelOff'), 'small');
    btn.addEventListener('click', () => { agreeing = false; send({ op: 'model', backend: b }); });
    modelEl.append(btn);
  }
  if (m.backend !== 'jev' || m.problem) {
    const btn = el('button', msg('useJev'), 'small');
    btn.addEventListener('click', () => { agreeing = !agreeing; render(); });
    modelEl.append(btn);
  }
  if (!agreeing) return;
  const box = el('div', undefined, 'consent');
  // the agreement in the panel's language when the bridge sends it (0.4.0+); the text agreed to is the same in both
  const text = msg('lang') === 'zh-TW' || !Array.isArray(m.consentTextEn) ? m.consentText : m.consentTextEn;
  for (const line of Array.isArray(text) ? text : []) box.append(el('div', clip(line, 400)));
  if (Array.isArray(m.limited) && m.limited.length) box.append(el('div', msg('jevLimited', m.limited.map((/** @type {string} */ n) => clip(n, 40)).join(msg('listSep'))), 'refused'));
  if (!m.keySet) {
    box.append(el('div', msg('noJevKey'), 'refused'));
  } else {
    const agree = el('button', msg('agreeJev'), 'primary');
    agree.addEventListener('click', () => { agreeing = false; send({ op: 'model', backend: 'jev', consentVersion: m.consentVersion }); });
    box.append(agree);
  }
  const cancel = el('button', msg('cancel'), 'ghost');
  cancel.addEventListener('click', () => { agreeing = false; render(); });
  box.append(cancel);
  modelEl.append(box);
}

/** @param {any} e */
function keep(e) {
  let m = entries.get(e.principal);
  if (!m) entries.set(e.principal, (m = new Map()));
  m.set(e.id, e);
  while (m.size > MAX.entries) m.delete(/** @type {number} */ (m.keys().next().value));
}

/** @param {{ seq: number, gap: boolean, updates: any[] }} batch */
function apply(batch) {
  if (batch.gap) {
    gapEl.hidden = false;
    gapEl.textContent = msg('gap', time(Date.now()));
  }
  received += batch.updates.length;
  document.body.dataset.updates = String(received); // how many updates arrived (tests read it)
  for (const u of batch.updates) {
    if (u.type === 'snapshot') {
      state = u.state;
      entries.clear();
      for (const { entries: list } of u.activity) for (const e of list) keep(e);
    } else if (u.type === 'state') state = u.state;
    else if (u.type === 'entry') keep(u.entry);
    else if (u.type === 'result') {
      statusEl.textContent = u.ok ? msg('cmdDone', u.op) : msg('cmdNotDone', u.op, clip(u.why, 200));
      statusEl.className = u.ok ? 'status ok' : 'status bad';
    }
  }
  render();
}

function connect() {
  port = chrome.runtime.connect({ name: 'panel' });
  statusEl.textContent = msg('panelConnected');
  statusEl.className = 'status ok';
  port.onMessage.addListener((m) => {
    if (!m || m.type !== 'push') return;
    apply(m.batch);
    port?.postMessage({ type: 'ack', ack: m.ack }); // taken: the extension may send the next one
  });
  port.onDisconnect.addListener(() => {
    port = null;
    statusEl.textContent = msg('panelReconnecting');
    statusEl.className = 'status warn';
    // the extension lets go of a panel that fell behind: what came meanwhile is lost; the snapshot on reconnect resyncs
    gapEl.hidden = false;
    gapEl.textContent = msg('gapReconnect', time(Date.now()));
    setTimeout(connect, 1000); // the extension's worker restarted
  });
}

connect();
