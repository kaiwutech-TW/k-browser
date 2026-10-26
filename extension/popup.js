// @ts-check
/** @type {Record<string, string>} */
const LABELS = { online: msg('stateOnline'), offline: msg('stateOffline'), unpaired: msg('stateUnpaired'), error: msg('stateError'), connecting: msg('stateConnecting') };
const stateEl = /** @type {HTMLElement} */ (document.getElementById('state'));
const codeEl = /** @type {HTMLInputElement} */ (document.getElementById('code'));
const saveEl = /** @type {HTMLButtonElement} */ (document.getElementById('save'));
const pairingEl = /** @type {HTMLElement} */ (document.getElementById('pairing'));
const repairEl = /** @type {HTMLButtonElement} */ (document.getElementById('repair'));

// The pairing field shows itself only when pairing is what is missing: not paired yet, or the bridge refused (a
// wrong or rotated code gives "error"). Connected, connecting or a bridge that is not running: a new code would not
// help, so the field stays folded behind "Pair again…" and cannot be pasted into by mistake.
const NEEDS_PAIRING = new Set(['unpaired', 'error']);
let unfolded = false;

async function render() {
  const { status } = await chrome.storage.local.get('status');
  const s = status || { state: 'connecting', detail: '' };
  stateEl.className = 'state ' + s.state;
  stateEl.textContent = (LABELS[s.state] || s.state) + (s.detail ? ' — ' + s.detail : '');
  const show = unfolded || NEEDS_PAIRING.has(s.state);
  pairingEl.hidden = !show;
  repairEl.hidden = show;
}

repairEl.addEventListener('click', () => {
  unfolded = true;
  void render().then(() => codeEl.focus());
});

// chrome.sidePanel.open must run inside the user's click, before any await: the window id is fetched beforehand.
/** @type {number | undefined} */
let windowId;
void chrome.windows.getCurrent().then((w) => { windowId = w.id; });
document.getElementById('panel')?.addEventListener('click', () => {
  if (windowId !== undefined) void chrome.sidePanel.open({ windowId }).then(() => window.close(), () => {});
});

saveEl.addEventListener('click', async () => {
  const code = codeEl.value.trim();
  if (!code) return;
  await chrome.storage.local.set({ pairKey: code, status: { state: 'connecting', detail: '', at: Date.now() } });
  codeEl.value = ''; // the worker reconnects on its own when pairKey changes
  unfolded = false; // folds again once connected; a refused code brings it back ("error")
  setTimeout(render, 500);
});

const handoffsEl = /** @type {HTMLElement} */ (document.getElementById('handoffs'));
const listEl = /** @type {HTMLElement} */ (document.getElementById('handoff-list'));

// Tabs an agent handed to you (needs_human): Show brings it to the front, Return gives control back to the agent.
// Returning it does not mean the task succeeded; the agent looks again.
async function renderHandoffs() {
  const { handoffs = [] } = (await chrome.storage.session.get('handoffs')) ?? {};
  listEl.replaceChildren();
  for (const h of /** @type {any[]} */ (handoffs)) {
    const row = document.createElement('div');
    row.className = 'handoff';
    const text = document.createElement('div');
    text.textContent = `${h.reason}`; // text only: the reason comes from the agent
    const title = document.createElement('div');
    title.className = 'muted';
    title.textContent = h.title || '';
    const show = document.createElement('button');
    show.textContent = msg('btnShow');
    show.addEventListener('click', () => void chrome.runtime.sendMessage({ type: 'handoff.show', tabId: h.tabId }));
    const back = document.createElement('button');
    back.textContent = msg('btnReturn');
    back.addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'handoff.return', handoffId: h.handoffId }); });
    row.append(text, title, show, back);
    listEl.append(row);
  }
  handoffsEl.hidden = handoffs.length === 0;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (changes.status) void render();
  if (area === 'session' && changes.handoffs) void renderHandoffs();
});
void render();
void renderHandoffs();
