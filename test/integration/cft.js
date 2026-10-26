// @ts-check
// Chrome for Testing with the real unpacked extension, for the integration tests.
//
// Branded Chrome no longer honours --load-extension (Chrome 137+), so tests use Chrome for Testing in a throwaway
// profile; the user's own Chrome is never touched. A separate test-only DevTools port is the "control channel": it
// attaches ONLY to the extension's service worker (to write the pairing code, or reload the extension), never to a
// page, so it cannot be mistaken for, or collide with, K-Browser's own chrome.debugger attachments.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { EXTENSION_ID } from '../../src/version.js';
import { sleep, until } from '../fakes.js';

const EXTENSION_DIR = path.resolve(new URL('../../extension', import.meta.url).pathname);

/** The Chrome for Testing binary: KBROWSER_TEST_CHROME, or the newest one Playwright downloaded. */
export function findChrome() {
  if (process.env.KBROWSER_TEST_CHROME) return process.env.KBROWSER_TEST_CHROME;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  if (!fs.existsSync(cache)) return null;
  const dirs = fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const d of dirs) {
    const bin = path.join(cache, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

/** A minimal CDP client on the control channel. */
class Control {
  /** @param {string} url */
  constructor(url) {
    this.ws = new WebSocket(url);
    this.ids = 0;
    /** @type {Map<number, (m: any) => void>} */ this.waiting = new Map();
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      const w = this.waiting.get(m.id);
      if (w) { this.waiting.delete(m.id); w(m); }
    });
  }
  open() { return new Promise((r, j) => { this.ws.once('open', r); this.ws.once('error', j); }); }
  /** @param {string} method @param {Record<string, any>} [params] @param {string} [sessionId] @returns {Promise<any>} */
  call(method, params = {}, sessionId) {
    const id = ++this.ids;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.ws.close(); }
}

/**
 * @param {{ chrome: string, profile?: string, headless?: boolean }} o  pass profile to relaunch on an existing one (a Chrome restart);
 *   KBROWSER_TEST_HEADED=1 runs the suites in a headed window
 */
export async function launchChrome({ chrome, profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cft-')), headless = process.env.KBROWSER_TEST_HEADED !== '1' }) {
  fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
  const proc = spawn(chrome, [
    ...(headless ? ['--headless=new'] : []), `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    // never the user's keychain: no "找不到鑰匙圈" prompt on their screen, and the tests cannot wait on one
    '--use-mock-keychain', '--password-store=basic',
    `--load-extension=${EXTENSION_DIR}`, `--disable-extensions-except=${EXTENSION_DIR}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  // Chrome writes the chosen port to DevToolsActivePort in the profile.
  const portFile = path.join(profile, 'DevToolsActivePort');
  if (!await until(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').includes('\n'), 15000)) {
    proc.kill('SIGKILL');
    throw new Error(`Chrome for Testing did not start:\n${stderr.slice(-2000)}`);
  }
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
  const control = new Control(`ws://127.0.0.1:${port}${wsPath}`);
  await control.open();

  /** The extension's service worker session on the control channel. */
  async function worker() {
    for (let i = 0; i < 100; i++) {
      const { targetInfos } = await control.call('Target.getTargets');
      const sw = targetInfos.find((/** @type {any} */ t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`));
      if (sw) return (await control.call('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
      await sleep(100);
    }
    throw new Error('the K-Browser service worker never appeared');
  }

  /** @param {string} expression */
  async function inWorker(expression) {
    const sid = await worker();
    try {
      // A worker that just started (Chrome just launched, or Chrome restarted it) can be evaluated before the extension
      // APIs are bound to it (chrome.storage / chrome.tabs undefined): wait for them, whoever calls (popup.test's first
      // extensionPage hit it)
      for (let i = 0; ; i++) {
        const ready = await control.call('Runtime.evaluate', { expression: 'Boolean(globalThis.chrome && chrome.storage && chrome.tabs)', returnByValue: true }, sid);
        if (ready.result?.value === true) break;
        if (i >= 50) throw new Error('extension APIs never became available in the worker');
        await sleep(100);
      }
      const r = await control.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error(`worker: ${d.text} ${d.exception?.description ?? d.exception?.value ?? ''}`.trim());
      }
      return r.result?.value;
    } finally {
      await control.call('Target.detachFromTarget', { sessionId: sid }).catch(() => {});
    }
  }

  return {
    control,
    /** Write the pairing code and bridge port, as a user pasting the code into the popup would. @param {string} key @param {number} bridgePort */
    async pair(key, bridgePort) {
      return inWorker(`chrome.storage.local.set(${JSON.stringify({ pairKey: key, port: bridgePort })}).then(() => true)`); // inWorker waits for the APIs
    },
    /** Stop the extension's service worker the way Chrome does when it is idle: same extension lifetime (same bootId). */
    async stopWorker() {
      const { targetInfos } = await control.call('Target.getTargets');
      const sw = targetInfos.find((/** @type {any} */ t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`));
      if (!sw) throw new Error('no K-Browser service worker to stop');
      await control.call('Target.closeTarget', { targetId: sw.targetId });
      return sw.targetId;
    },
    /** Run an expression in the extension's worker. @param {string} expression */
    inWorker,
    /**
     * Open one of the extension's own pages in a tab (panel.html), and evaluate in it. The control channel
     * attaches to that extension page only, never to a web page K-Browser drives. @param {string} file
     */
    async extensionPage(file) {
      const url = `chrome-extension://${EXTENSION_ID}/${file}`;
      // only a page that was not there before: a second page of the same file may not be listed yet, and the first
      // one found would then be an older page (two handles on one page, the new one left open)
      const before = new Set((await control.call('Target.getTargets')).targetInfos.map((/** @type {any} */ t) => t.targetId));
      await inWorker(`chrome.tabs.create({ url: ${JSON.stringify(url)}, active: false }).then(() => true)`);
      let target;
      for (let i = 0; i < 100 && !target; i++) {
        target = (await control.call('Target.getTargets')).targetInfos.find((/** @type {any} */ t) => t.type === 'page' && t.url === url && !before.has(t.targetId));
        if (!target) await sleep(100);
      }
      if (!target) throw new Error(`${file} did not open`);
      const { sessionId } = await control.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      return {
        /** @param {string} expression */
        async eval(expression) {
          const r = await control.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
          if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.text}`);
          return r.result?.value;
        },
        close: () => control.call('Target.closeTarget', { targetId: target.targetId }),
      };
    },
    /** What the popup's "交還" button does, in the extension's worker. @param {string} handoffId */
    returnHandoff: (handoffId) => inWorker(`kbReturnHandoff(${JSON.stringify(handoffId)})`),
    /** The hand-offs the extension shows, and its badge. */
    handoffView: () => inWorker(`(async () => ({ items: (await chrome.storage.session.get('handoffs')).handoffs ?? [],
      badge: await chrome.action.getBadgeText({}) }))()`),
    /** The user closes a tab (not through K-Browser). @param {number} tabId */
    userCloses: (tabId) => inWorker(`chrome.tabs.remove(${Number(tabId)}).then(() => true)`),
    /** The user navigates a tab (not through K-Browser). @param {number} tabId @param {string} url */
    userNavigates: (tabId, url) => inWorker(`chrome.tabs.update(${Number(tabId)}, { url: ${JSON.stringify(url)} }).then(() => true)`),
    /** The user zooms a tab (Cmd +/−), by its URL. @param {string} url @param {number} factor */
    userZooms: (url, factor) => inWorker(`chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === ${JSON.stringify(url)}))
      .then((t) => chrome.tabs.setZoom(t.id, ${Number(factor)})).then(() => true)`),
    /** Reload the extension (a new extension lifetime: storage.session, hence bootId, is cleared). */
    reloadExtension: () => inWorker('setTimeout(() => chrome.runtime.reload(), 50), true'),
    /** Open a tab the way the user would (not through K-Browser). @param {string} url */
    async userTab(url) {
      const { targetId } = await control.call('Target.createTarget', { url });
      return targetId;
    },
    /** Is any debugger attached to this page target? (Chrome's view.) @param {string} targetId */
    async attached(targetId) {
      const { targetInfos } = await control.call('Target.getTargets');
      return targetInfos.find((/** @type {any} */ t) => t.targetId === targetId)?.attached ?? null;
    },
    profile,
    /** Quit Chrome but keep the profile (storage.local, i.e. the pairing code, survives; storage.session does not). */
    async quit() {
      control.close();
      proc.kill('SIGTERM');
      await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(5000)]);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    },
    async close() {
      await this.quit();
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

const FIXTURE_DIR = path.resolve(new URL('../fixtures', import.meta.url).pathname);
/** Records input on the page in document.body.dataset (readable from an isolated world): counts, isTrusted, last click. */
const REC = `<script>for (const t of ['mousedown', 'click', 'dblclick', 'input', 'change']) addEventListener(t, (e) => {
  const b = document.body.dataset; b[t] = String((+b[t] || 0) + 1); b[t + 'Trusted'] = String(e.isTrusted);
  if (t === 'click') b.last = (e.target.textContent || '').trim(); }, true)</script>`;
/** How /act-t-<name> shows its OOPIF */
export const TRANSFORMS = {
  translate: 'transform:translate(20px,10px);', scale: 'transform:scale(0.5);transform-origin:0 0;',
  rot90: 'transform:rotate(90deg);transform-origin:0 0;left:520px;', rot180: 'transform:rotate(180deg);',
  rot30: 'transform:rotate(30deg);', zoom: 'zoom:1.5;', scaleProp: 'scale:0.8;',
};

/** Local pages for the tests. The frame host embeds a child from another site (localhost vs 127.0.0.1) -> an OOPIF.
 * POST /report stores a JSON body in `reports` (the self-check page). */
export async function fixtures() {
  /** @type {any[]} */
  const reports = [];
  /** @type {Record<string, (other: number) => string>} */
  const pages = {
    '/page': () => `<!doctype html><title>fixture</title>
      <button id="b" style="position:absolute;left:40px;top:40px;width:120px;height:40px"
        onclick="window.__clicked = event.isTrusted">x</button>`,
    '/opener': () => `<!doctype html><title>opener</title>
      <button id="b" style="position:absolute;left:40px;top:40px;width:120px;height:40px"
        onclick="window.open('/page', '_blank')">open</button>`,
    '/flash': () => `<!doctype html><title>flash</title>
      <button id="b" style="position:absolute;left:40px;top:40px;width:120px;height:40px"
        onclick="const w = window.open('/page', '_blank'); if (w) window.__opened = (window.__opened || 0) + 1; setTimeout(() => w && w.close(), 0)">flash</button>`,
    '/frame-host': (other) => `<!doctype html><title>host</title><iframe src="http://localhost:${other}/child" width="300" height="200"></iframe>`,
    '/child': () => '<!doctype html><title>child</title><p>child</p>',
    // a same-origin iframe, an OOPIF (localhost) that holds a nested OOPIF (back on 127.0.0.1)
    '/frames': (other) => `<!doctype html><title>frames</title><h1>Frames</h1><button>top button</button>
      <iframe id="same" src="/same" width="300" height="120"></iframe>
      <iframe id="oop" src="http://localhost:${other}/oop" width="420" height="260"></iframe>
      <button>bottom button</button>`,
    '/same': () => `<!doctype html><title>same</title><style>p::before { content: "gen " }</style>
      <button>same button</button><p>para</p>`,
    '/same2': () => '<!doctype html><title>same2</title><button>same2 button</button>',
    '/oop': (other) => `<!doctype html><title>oop</title><button>oop button</button>
      <iframe src="http://127.0.0.1:${other}/inner" width="300" height="120"></iframe>`,
    '/inner': () => '<!doctype html><title>inner</title><a href="#x">inner link</a>',
    '/cross': () => '<!doctype html><title>cross</title><button>cross button</button>',
    // the self-check page, and pages for clicking, typing and choosing
    '/footprint': () => fs.readFileSync(path.join(FIXTURE_DIR, 'footprint.html'), 'utf8'),
    // On the first mousemove the page changes the target (?mode=replace|cover|rename|move); mousedowns are counted.
    '/swap': () => `<!doctype html><title>swap</title><style>body{margin:0}</style>
      <button id="t" style="position:absolute;left:200px;top:200px;width:120px;height:40px">target</button>
      <script>
        const mode = new URLSearchParams(location.search).get('mode');
        let done = false;
        addEventListener('mousedown', () => { document.title = 'pressed'; }, true);
        addEventListener('mousemove', () => {
          if (done) return;
          done = true;
          const t = document.getElementById('t');
          if (mode === 'replace') t.replaceWith(t.cloneNode(true));
          if (mode === 'cover') document.body.insertAdjacentHTML('beforeend', '<div style="position:fixed;inset:0;background:rgba(0,0,0,.2)"></div>');
          if (mode === 'rename') t.textContent = 'delete everything';
          if (mode === 'move') t.style.left = '600px';
        }, true);
      </script>`,
    '/act': (other) => `<!doctype html><title>act</title><style>body{margin:0;height:3000px}</style>${REC}
      <button style="position:absolute;left:10px;top:10px;width:100px;height:30px">top button</button>
      <iframe src="/act-same" style="position:absolute;left:10px;top:60px;width:300px;height:150px;border:5px solid red"></iframe>
      <iframe src="http://localhost:${other}/act-oop" style="position:absolute;left:350px;top:60px;width:300px;height:180px;border:7px solid blue;padding:3px"></iframe>
      <button style="position:absolute;left:10px;top:2000px;width:100px;height:30px">far button</button>`,
    '/act-same': () => `<!doctype html><style>body{margin:0}</style>${REC}
      <button style="position:absolute;left:20px;top:20px;width:100px;height:30px">same button</button>`,
    '/act-oop': (other) => `<!doctype html><style>body{margin:0;height:1200px}</style>${REC}
      <button style="position:absolute;left:30px;top:25px;width:100px;height:30px">oop button</button>
      <iframe src="http://127.0.0.1:${other}/act-inner" style="position:absolute;left:20px;top:70px;width:200px;height:60px;border:2px solid green"></iframe>
      <button style="position:absolute;left:30px;top:600px;width:100px;height:30px">deep button</button>
      <input aria-label="oop field" style="position:absolute;left:150px;top:25px;width:120px">`,
    '/act-inner': () => `<!doctype html><style>body{margin:0}</style>${REC}
      <button style="position:absolute;left:5px;top:5px;width:90px;height:22px">inner button</button>`,
    ...Object.fromEntries(Object.entries(TRANSFORMS).map(([name, css]) => [`/act-t-${name}`, (/** @type {number} */ other) => `<!doctype html><style>body{margin:0}</style>
      <iframe id="f" src="http://localhost:${other}/act-tchild" style="position:absolute;left:100px;top:60px;width:300px;height:150px;border:4px solid blue;${css}"></iframe>`])),
    '/act-tchild': () => `<!doctype html><style>body{margin:0}</style>${REC}
      <button style="position:absolute;left:30px;top:25px;width:100px;height:30px">tbutton</button>`,
    '/act-shadow': () => `<!doctype html><title>shadow</title><style>body{margin:0}</style>
      <div id="h1" style="position:absolute;left:10px;top:20px;width:400px;height:60px"></div>
      <div id="h2" style="position:absolute;left:10px;top:120px;width:400px;height:60px"></div>
      <div id="h3" style="position:absolute;left:10px;top:220px;width:400px;height:60px"><span style="font-size:20px">slotted text</span></div>
      <script>
        const mark = (b) => b.addEventListener('click', (e) => { document.body.dataset[b.dataset.k] = String(e.isTrusted); });
        const r1 = document.getElementById('h1').attachShadow({ mode: 'open' });
        r1.innerHTML = '<button data-k="ok" style="position:absolute;left:10px;top:10px;width:100px;height:30px">shadow ok</button>'
          + '<button data-k="covered" style="position:absolute;left:150px;top:10px;width:100px;height:30px">shadow covered</button>'
          + '<div style="position:absolute;left:140px;top:0;width:120px;height:60px;background:rgba(0,0,0,.2)"></div>'
          + '<button data-k="ghost" style="position:absolute;left:290px;top:10px;width:100px;height:30px;pointer-events:none">shadow ghost</button>';
        const r2 = document.getElementById('h2').attachShadow({ mode: 'closed' });
        r2.innerHTML = '<button data-k="closed" style="position:absolute;left:10px;top:10px;width:100px;height:30px">closed ok</button>'
          + '<input aria-label="closed field" style="position:absolute;left:150px;top:10px;width:120px">';
        const r3 = document.getElementById('h3').attachShadow({ mode: 'open' });
        r3.innerHTML = '<button data-k="slotted" style="position:absolute;left:10px;top:10px;width:160px;height:30px"><slot></slot></button>';
        for (const b of [...r1.querySelectorAll('button'), ...r2.querySelectorAll('button'), ...r3.querySelectorAll('button')]) mark(b);
      </script>`,
    '/act-form': () => `<!doctype html><meta charset="utf-8"><title>form</title><style>body{margin:0}</style>${REC}
      <input aria-label="name" style="position:absolute;left:20px;top:20px;width:200px">
      <select aria-label="station" style="position:absolute;left:20px;top:80px">
        <option value="a">Apple</option><option value="b">Banana</option><option value="bs">Banana split</option>
        <option disabled>Cherry</option><option value="tp">台北</option>
      </select>
      <button style="position:absolute;left:20px;top:140px;width:100px;height:30px">double me</button>
      <textarea aria-label="notes" style="position:absolute;left:20px;top:200px;width:200px;height:80px">first
second
third</textarea>
      <select aria-label="hidden station" style="position:absolute;left:300px;top:80px"><option>Apple</option><option>Banana</option></select>
      <div style="position:absolute;left:290px;top:70px;width:200px;height:50px;background:rgba(0,0,0,.2)"></div>
      <input aria-label="first" style="position:absolute;left:300px;top:200px;width:120px"
        oninput="document.querySelector('[aria-label=second]').focus()">
      <input aria-label="second" style="position:absolute;left:300px;top:250px;width:120px">
      <input aria-label="shifty" style="position:absolute;left:300px;top:300px;width:120px"
        onkeydown="if (event.key === 'Shift') document.querySelector('[aria-label=second]').focus()">
      <input aria-label="date" readonly value="2026/04/28" style="position:absolute;left:520px;top:20px;width:120px">
      <input aria-label="locks" oninput="this.readOnly = true" style="position:absolute;left:520px;top:140px;width:120px">
      <div id="cal" style="position:absolute;left:520px;top:80px"></div>
      <script>
        // like jQuery UI's datepicker: a change rebuilds the whole calendar, the <select> included
        const cal = document.getElementById('cal');
        const draw = (y) => {
          cal.innerHTML = '<select aria-label="year">' + ['2024', '2025', '2026'].map((v) => '<option' + (v === y ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>';
          cal.firstChild.addEventListener('change', (e) => { document.body.dataset.year = e.target.value; draw(e.target.value); });
        };
        draw('2024');
      </script>`,
    // contenteditable replace: every editor inside one 800x600 screen, so nothing scrolls between actions
    '/act-editors': () => `<!doctype html><meta charset="utf-8"><title>editors</title><style>body{margin:0}</style>
      <div contenteditable role="textbox" aria-label="editor" style="position:absolute;left:20px;top:20px;width:200px;height:80px">old</div>
      <div contenteditable role="textbox" aria-label="sneaky editor" onkeyup="getSelection().collapseToEnd()"
        style="position:absolute;left:280px;top:20px;width:200px;height:80px">old</div>
      <div contenteditable role="textbox" aria-label="wide editor" onkeyup="getSelection().selectAllChildren(document.body)"
        style="position:absolute;left:540px;top:20px;width:200px;height:80px">old</div>
      <div contenteditable role="textbox" aria-label="blank editor" onkeyup="getSelection().collapseToEnd()"
        style="position:absolute;left:20px;top:130px;width:200px;height:80px"><div><br></div><div><br></div></div>
      <div contenteditable role="textbox" aria-label="lines editor"
        style="position:absolute;left:280px;top:130px;width:200px;height:80px"><div>one</div><div><br></div><div>two</div></div>
      <div contenteditable role="textbox" aria-label="spaced editor" onkeyup="const t = this.firstChild; getSelection().setBaseAndExtent(t, 2, t, 5)"
        style="position:absolute;left:540px;top:130px;width:200px;height:80px">&nbsp;&nbsp;old&nbsp;&nbsp;</div>
      <div contenteditable role="textbox" aria-label="pre editor" onkeyup="getSelection().collapseToEnd()"
        style="position:absolute;left:20px;top:240px;width:200px;height:80px;white-space:pre-wrap">   </div>
      <div contenteditable role="textbox" aria-label="indented editor" style="position:absolute;left:280px;top:240px;width:200px;height:80px">
        <p>old</p>
      </div>
      <div contenteditable role="textbox" aria-label="br editor" style="position:absolute;left:540px;top:240px;width:200px;height:80px">old<br></div>
      <div contenteditable role="textbox" aria-label="two br editor" style="position:absolute;left:20px;top:350px;width:200px;height:80px">old<br><br></div>
      <div contenteditable role="textbox" aria-label="two br sneaky" onkeyup="const t = this.firstChild; getSelection().setBaseAndExtent(t, 0, t, 3)"
        style="position:absolute;left:280px;top:350px;width:200px;height:80px">old<br><br></div>
      <div contenteditable role="textbox" aria-label="newline editor" onkeyup="getSelection().collapseToEnd()"
        style="position:absolute;left:540px;top:350px;width:200px;height:80px;white-space:pre-wrap">

</div>
      <div contenteditable role="textbox" aria-label="shy editor" onkeyup="const t = this.firstChild; getSelection().setBaseAndExtent(t, 0, t, 3)"
        style="position:absolute;left:20px;top:460px;width:200px;height:80px">old­</div>`,
    // a booking form (its API echoes the input), a slow API, a redirect chain, a service worker
    '/book': () => `<!doctype html><meta charset="utf-8"><title>book</title><style>body{margin:0}</style>
      <input aria-label="train" id="train" style="position:absolute;left:20px;top:20px;width:120px">
      <input aria-label="date" id="date" style="position:absolute;left:20px;top:60px;width:120px">
      <button id="go" style="position:absolute;left:20px;top:100px;width:120px;height:30px">book</button>
      <button id="other" style="position:absolute;left:160px;top:100px;width:120px;height:30px">book other</button>
      <button id="slow" style="position:absolute;left:20px;top:150px;width:120px;height:30px">slow</button>
      <button id="redir" style="position:absolute;left:160px;top:150px;width:120px;height:30px">redirect</button>
      <button id="slowredir" style="position:absolute;left:300px;top:150px;width:120px;height:30px" onclick="fetch('/slow-redirect')">slow redirect</button>
      <p id="out" style="position:absolute;left:20px;top:200px">-</p>
      <script>
        const post = (body) => fetch('/api/book', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          .then((r) => r.json()).then((j) => { document.getElementById('out').textContent = 'booked ' + j.train; });
        document.getElementById('go').onclick = () => post({ train: document.getElementById('train').value, date: document.getElementById('date').value });
        document.getElementById('other').onclick = () => post({ train: '999', date: '2026-01-01' });
        document.getElementById('slow').onclick = () => fetch('/api/slow');
        document.getElementById('redir').onclick = () => fetch('/r1');
      </script>`,
    '/sw': () => `<!doctype html><title>sw</title><style>body{margin:0}</style>
      <button style="position:absolute;left:20px;top:20px;width:120px;height:30px" onclick="fetch('/sw-data')">sw fetch</button>
      <script>navigator.serviceWorker.register('/sw.js');</script>`,
    // the first click replaces the button with a "danger" one in the same place
    '/act-replace': () => `<!doctype html><title>replace</title><style>body{margin:0}</style>
      <button id="b" style="position:absolute;left:100px;top:100px;width:120px;height:40px">target</button>
      <script>
        addEventListener('mousedown', (e) => { document.body.dataset.downs = (document.body.dataset.downs || '') + e.target.textContent + ';'; }, true);
        document.getElementById('b').addEventListener('click', (e) => {
          const d = document.createElement('button'); d.textContent = 'danger'; d.style.cssText = e.target.style.cssText; e.target.replaceWith(d);
        });
      </script>`,
    // typing makes the button glide to a new place (the page moving on after typing)
    '/act-glide': () => `<!doctype html><title>glide</title><style>body{margin:0}</style>
      <input aria-label="field" style="position:absolute;left:20px;top:20px;width:200px;height:30px">
      <button id="b" style="position:absolute;left:100px;top:100px;width:120px;height:40px;transition:top 0.4s linear">glider</button>
      <script>
        document.querySelector('input').addEventListener('input', () => { document.getElementById('b').style.top = '400px'; });
        addEventListener('mousedown', (e) => { document.body.dataset.downs = (document.body.dataset.downs || '') + e.target.textContent + ';'; }, true);
      </script>`,
    // the OOPIF is turned 180° once the pointer starts moving (from either document)
    '/act-turn': (other) => `<!doctype html><title>turn</title><style>body{margin:0}</style>
      <iframe id="f" src="http://localhost:${other}/act-turn-child" style="position:absolute;left:100px;top:60px;width:300px;height:150px;border:0"></iframe>
      <script>
        const turn = () => { document.getElementById('f').style.transform = 'rotate(180deg)'; };
        addEventListener('mousemove', turn, { once: true });
        addEventListener('message', (e) => { if (e.data === 'turn') turn(); });
      </script>`,
    '/act-turn-child': () => `<!doctype html><style>body{margin:0}</style>${REC}
      <button style="position:absolute;left:20px;top:20px;width:100px;height:30px">tbutton</button>
      <button style="position:absolute;left:180px;top:100px;width:100px;height:30px">danger</button>
      <script>addEventListener('mousemove', () => parent.postMessage('turn', '*'), { once: true });</script>`,
  };
  /** @param {() => number} other */
  const make = (other) => http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/report') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { reports.push(JSON.parse(body)); res.writeHead(204).end(); });
      return;
    }
    const route = (req.url ?? '').split('?')[0];
    if (route === '/api/book' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const input = JSON.parse(body || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'OK', train: input.train, date: input.date }));
      });
      return;
    }
    if (route === '/api/slow') return void setTimeout(() => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"OK"}'), 800);
    if (route === '/slow-redirect') return void setTimeout(() => res.writeHead(302, { Location: '/api/booked' }).end(), 800);
    if (route === '/api/booked') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"OK","train":"123"}');
    // run_flow: a page Kav reads (rows depend on ?cur=), and a redirect to the other origin (localhost) a test blocks
    if (route === '/rates') {
      const cur = /^[A-Z]{3}$/.test(new URL(req.url ?? '/', 'http://x').searchParams.get('cur') ?? '') ? new URL(req.url ?? '/', 'http://x').searchParams.get('cur') : 'USD';
      return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>rates</title><table>
        <tr><td>(${cur}) 測試幣</td><td>31.50</td><td>32.10</td></tr><tr><td>(TWD) 新台幣</td><td>1.00</td><td>1.00</td></tr></table>`);
    }
    // the decision dataset: a list Kav picks from by meaning (Kev), the shape of Kav's own pick_list.html; and the detail page
    if (route === '/picks') {
      const rows = ['機票訂位', '退費申請表', '請假單', '發票補開'];
      return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>picks</title><h1>清單</h1><div id="list">${
        rows.map((n) => `<div class="row"><span>${n}</span><span>NT$0</span><span><a href="/pick-detail?item=${encodeURIComponent(n)}">查看</a></span></div>`).join('')}</div>`);
    }
    if (route === '/pick-detail') {
      const item = new URL(req.url ?? '/', 'http://x').searchParams.get('item') ?? '';
      return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>detail</title><h1>詳情:${item.replace(/[<&]/g, '')}</h1>`);
    }
    if (route === '/to-other') return void res.writeHead(302, { Location: `http://localhost:${other()}/rates?cur=EUR` }).end();
    if (route === '/r1') return void res.writeHead(302, { Location: '/r2' }).end();
    if (route === '/r2') return void res.writeHead(301, { Location: '/final' }).end();
    if (route === '/final') return void res.writeHead(200, { 'Content-Type': 'text/plain' }).end('final');
    if (route === '/sw-data') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"from":"server"}');
    if (route === '/sw.js') {
      return void res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(`
        self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
        self.addEventListener('fetch', (e) => {
          if (new URL(e.request.url).pathname === '/sw-data') e.respondWith(new Response('{"from":"sw"}', { headers: { 'content-type': 'application/json' } }));
        });`);
    }
    const page = pages[route];
    if (!page) return void res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(other()));
  });
  /** @type {number} */ let portA = 0;
  /** @type {number} */ let portB = 0;
  const a = make(() => portB);
  const b = make(() => portA);
  /** @param {http.Server} s */
  const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(/** @type {import('node:net').AddressInfo} */ (s.address()).port)));
  portA = /** @type {number} */ (await listen(a));
  portB = /** @type {number} */ (await listen(b));
  return {
    url: (/** @type {string} */ p) => `http://127.0.0.1:${portA}${p}`,
    portB,
    reports,
    async close() {
      for (const s of [a, b]) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
    },
  };
}
