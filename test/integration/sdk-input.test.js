// @ts-check
// In Chrome for Testing: SDK input through the real bridge and extension (chrome.debugger) on local fixtures:
// the self-check page, a page that changes the target on the first mousemove, clicks through same-process iframes,
// OOPIFs and nested OOPIFs, transformed OOPIFs, shadow DOM, typing and a native <select>. Run: npm run test:chrome

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as auth from '../../src/auth.js';
import { Browser, SdkError } from '../../src/sdk/index.js';
import { startBridge } from '../../src/server.js';
import { sleep, until } from '../fakes.js';
import { findChrome, fixtures, launchChrome, TRANSFORMS } from './cft.js';

const CHROME = findChrome();
const skip = CHROME ? false : 'Chrome for Testing not found (set KBROWSER_TEST_CHROME)';

/** @type {Awaited<ReturnType<typeof startBridge>>} */ let bridge;
/** @type {Awaited<ReturnType<typeof launchChrome>>} */ let chrome;
/** @type {Awaited<ReturnType<typeof fixtures>>} */ let site;
/** @type {Browser} */ let browser;

before(async () => {
  if (skip) return;
  process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-sdk-input-'));
  const token = auth.addClient('sdk-input');
  site = await fixtures();
  chrome = await launchChrome({ chrome: /** @type {string} */ (CHROME) });
  bridge = await startBridge({ port: 0, log: () => {} });
  await chrome.pair(/** @type {string} */ (auth.pairKey({ create: true })), bridge.port);
  assert.ok(await until(() => bridge.relay.ext !== null, 15000), 'the extension connected');
  browser = await Browser.connect(`${bridge.base}/c/${token}`);
});

after(async () => {
  if (skip) return;
  browser?.close();
  await bridge?.close();
  await chrome?.close();
  await site?.close();
});

/** @param {string} p */
async function tabAt(p) {
  const tab = await browser.newTab(site.url(p));
  await sleep(300);
  await tab.settled();
  return tab;
}

/** @param {{ refs: { ref: string, name: string }[] }} snap @param {string} name */
function refOf(snap, name) {
  const r = snap.refs.find((x) => x.name === name);
  assert.ok(r, `a ref for "${name}"`);
  return r.ref;
}

/** @param {() => Promise<unknown>} fn @param {string} code */
async function failsWith(fn, code) {
  await assert.rejects(fn, (e) => e instanceof SdkError && e.code === code ? true : assert.fail(`expected ${code}, got ${e instanceof SdkError ? e.code : ''} ${e}`));
}

/** document.body.dataset of a frame, read from the isolated world. @param {import('../../src/sdk/index.js').Tab} tab @param {string} [frameId] */
const marks = (tab, frameId) => tab.evaluate(() => ({ ...document.body.dataset }), [], frameId ? { frameId } : {});

test('the self-check page: natives intact, no globals, no DOM changes, only trusted events, a path of moves, real key codes', { skip }, async () => {
  const tab = await tabAt('/footprint');
  try {
    const snap = await tab.snapshot();
    await tab.click(refOf(snap, 'go'));
    await tab.type(refOf(snap, 'name'), 'Ab1');
    await tab.click(refOf(snap, 'send report'));
    assert.ok(await until(() => site.reports.length > 0, 5000), 'the page sent its report');
    const r = site.reports.at(-1);
    assert.deepEqual(r.natives, { fetch: true, XMLHttpRequest: true, addEventListener: true, toString: true });
    assert.deepEqual(r.newGlobals, []);
    assert.deepEqual(r.mutations, [], 'the SDK changed nothing in the DOM');
    assert.equal(r.untrustedMoves, 0);
    assert.deepEqual(r.events.filter((/** @type {any} */ e) => !e.trusted), [], 'every input event is trusted');
    // >= 5 moves holds for this controlled fixture (fixed distances, in the foreground), not for any page (C⑩)
    assert.ok(r.movesBeforeFirstClick >= 5, `${r.movesBeforeFirstClick} mousemoves before the first click`);
    const downs = r.events.filter((/** @type {any} */ e) => e.type === 'keydown').map((/** @type {any} */ e) => `${e.code}/${e.key}/${e.keyCode}`);
    assert.deepEqual(downs, ['ShiftLeft/Shift/16', 'KeyA/A/65', 'KeyB/b/66', 'Digit1/1/49']);
    assert.equal(r.value, 'Ab1');
    assert.equal(r.visibility, 'visible', 'focus emulation (a known, visible change) keeps the background tab visible');
    for (const m of ['Runtime.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Runtime.addBinding']) assert.equal(browser.client.sent.get(m) ?? 0, 0, `${m} never sent`);
  } finally {
    await tab.close();
  }
});

for (const [mode, code] of /** @type {const} */ ([['replace', 'stale_ref'], ['cover', 'occluded'], ['rename', 'target_changed'], ['move', 'occluded']])) {
  test(`the page changes the target on the first mousemove (${mode}): stops before pressing (${code})`, { skip }, async () => {
    const tab = await tabAt(`/swap?mode=${mode}`);
    try {
      const ref = refOf(await tab.snapshot(), 'target');
      await failsWith(() => tab.click(ref), code);
      await sleep(200);
      assert.equal(await tab.evaluate(() => document.title), 'swap', 'the page saw no mousedown at all');
    } finally {
      await tab.close();
    }
  });
}

test('clicks land in the main frame, a same-process iframe, an OOPIF and a nested OOPIF (borders, padding, scrolling)', { skip }, async () => {
  const tab = await tabAt('/act');
  try {
    let snap = await tab.snapshot();
    const frameOf = (/** @type {string} */ name) => snap.refs.find((r) => r.name === name)?.stamp.frameId;
    for (const [name, cross] of /** @type {const} */ ([['top button', 0], ['same button', 0], ['oop button', 1], ['inner button', 2]])) {
      const r = await tab.click(refOf(snap, name));
      assert.equal(r.crossFrames, cross, `${name}: OOPIF boundaries crossed`);
      const m = await marks(tab, frameOf(name));
      assert.deepEqual([m.last, m.clickTrusted], [name, 'true'], `${name} got a trusted click`);
    }
    // the main page scrolled, then a button below the fold of the OOPIF (the OOPIF scrolls itself into view)
    await tab.evaluate(() => scrollTo(0, 25));
    snap = await tab.snapshot();
    await tab.click(refOf(snap, 'deep button'));
    assert.equal((await marks(tab, frameOf('deep button'))).last, 'deep button');
    assert.ok(await tab.evaluate(() => scrollY, [], { frameId: frameOf('deep button') }) > 0, 'the OOPIF scrolled');
    // and one far below the main page's fold
    await tab.click(refOf(snap, 'far button'));
    assert.equal((await marks(tab)).last, 'far button');
    // typing into a field inside the OOPIF
    await tab.type(refOf(snap, 'oop field'), 'ok');
    assert.equal((await tab.read(refOf(snap, 'oop field'))).text, 'ok');
  } finally {
    await tab.close();
  }
});

for (const name of Object.keys(TRANSFORMS)) {
  const ok = name === 'translate';
  test(`an OOPIF shown with ${name}: ${ok ? 'the click lands' : 'unsupported_transform, nothing pressed'}`, { skip }, async () => {
    const tab = await tabAt(`/act-t-${name}`);
    try {
      const snap = await tab.snapshot();
      const ref = refOf(snap, 'tbutton');
      const frameId = snap.refs.find((r) => r.name === 'tbutton')?.stamp.frameId;
      if (ok) {
        await tab.click(ref);
        assert.equal((await marks(tab, frameId)).last, 'tbutton');
      } else {
        await failsWith(() => tab.click(ref), 'unsupported_transform');
        assert.equal((await marks(tab, frameId)).mousedown, undefined, 'nothing pressed inside the frame');
      }
    } finally {
      await tab.close();
    }
  });
}

test('shadow DOM: open and closed shadow trees click; a cover inside the same shadow tree, or a click that would fall through to the host, stop', { skip }, async () => {
  const tab = await tabAt('/act-shadow');
  try {
    const snap = await tab.snapshot();
    await tab.click(refOf(snap, 'shadow ok'));
    await tab.click(refOf(snap, 'closed ok'));
    await failsWith(() => tab.click(refOf(snap, 'shadow covered')), 'occluded');
    await failsWith(() => tab.click(refOf(snap, 'shadow ghost')), 'occluded');
    // review ⑥: a hit on slotted light-DOM text is inside the button; a field in a closed shadow tree takes typing
    await tab.click(refOf(snap, 'slotted text'));
    await tab.type(refOf(snap, 'closed field'), 'xy');
    assert.equal((await tab.read(refOf(snap, 'closed field'))).text, 'xy');
    const m = await marks(tab);
    assert.deepEqual([m.ok, m.closed, m.covered, m.ghost, m.slotted], ['true', 'true', undefined, undefined, 'true']);
  } finally {
    await tab.close();
  }
});

test('typing, a double click, and a native <select> chosen with trusted keys only', { skip }, async () => {
  const tab = await tabAt('/act-form');
  try {
    const snap = await tab.snapshot();
    const typed = await tab.type(refOf(snap, 'name'), 'Hi 台北');
    assert.deepEqual([typed.keys, typed.inserted], [3, 2]);
    assert.match(String(typed.note), /Input\.insertText/);
    assert.equal((await tab.read(refOf(snap, 'name'))).text, 'Hi 台北');
    await tab.dblclick(refOf(snap, 'double me'));
    assert.equal((await marks(tab)).dblclick, '1');

    const station = refOf(snap, 'station');
    const value = () => tab.evaluate(() => /** @type {HTMLSelectElement} */ (document.querySelector('select')).value);
    for (const [want, expect] of /** @type {const} */ ([[{ label: 'Banana split' }, 'bs'], [{ value: 'b' }, 'b'], [{ label: 'Apple' }, 'a']])) {
      const r = await tab.select(station, want);
      assert.equal(r.changed, true);
      assert.equal(await value(), expect, `chose ${JSON.stringify(want)}`);
    }
    const m = await marks(tab);
    assert.deepEqual([m.inputTrusted, m.changeTrusted], ['true', 'true'], 'input and change came from trusted keys');
    if (process.platform === 'darwin') {
      // not on a US keyboard, and arrow keys open the native menu on macOS: refused, not set from script
      await failsWith(() => tab.select(station, { label: '台北' }), 'unsupported');
      assert.equal(await value(), 'a');
    }
    await failsWith(() => tab.select(station, { label: 'Cherry' }), 'bad_argument');

    // review ③: a covered select is not chosen; typing stops when a handler moves the focus elsewhere
    await failsWith(() => tab.select(refOf(snap, 'hidden station'), { label: 'Banana' }), 'occluded');
    assert.equal(await tab.evaluate(() => /** @type {HTMLSelectElement} */ (document.querySelectorAll('select')[1]).value), 'Apple');
    // "A" went in before the focus moved: not a plain "not done"
    await failsWith(() => tab.type(refOf(snap, 'first'), 'AB'), 'result_unknown');
    assert.deepEqual([(await tab.read(refOf(snap, 'first'))).text, (await tab.read(refOf(snap, 'second'))).text], ['A', '']);
    // review ⑦: replace selects the whole field, all lines
    await tab.type(refOf(snap, 'notes'), 'new', { replace: true });
    assert.equal((await tab.read(refOf(snap, 'notes'))).text, 'new');
    // re-review A: the field moves the focus away on the Shift keydown: "A" goes nowhere
    await failsWith(() => tab.type(refOf(snap, 'shifty'), 'A'), 'not_focused');
    assert.deepEqual([(await tab.read(refOf(snap, 'shifty'))).text, (await tab.read(refOf(snap, 'second'))).text], ['', '']);
  } finally {
    await tab.close();
  }
});

test('a <select> the page rebuilds on change is reported as maybe done (result_unknown), never as not done; a read-only field is refused before any key', { skip }, async () => {
  const tab = await tabAt('/act-form');
  try {
    const snap = await tab.snapshot();
    // "2025": the first key "2" already moves 2024 -> 2025, the page rebuilds the calendar, the next key has no select
    await assert.rejects(() => tab.select(refOf(snap, 'year'), { label: '2025' }),
      (e) => e instanceof SdkError && e.code === 'result_unknown' && /input event\(s\) had already gone in/.test(e.message) ? true : assert.fail(String(e)));
    assert.equal((await marks(tab)).year, '2025', 'the choice did take effect');
    await failsWith(() => tab.type(refOf(snap, 'date'), '2025/10/24'), 'unsupported');
    // the field locks itself after the first character: "A" went in, "B" could not: maybe done, never "done" (KB-H1)
    await failsWith(() => tab.type(refOf(snap, 'locks'), 'AB'), 'result_unknown');
    assert.equal(await tab.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector('[aria-label=locks]')).value), 'A');
    assert.equal(await tab.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector('[aria-label=date]')).value), '2026/04/28', 'nothing typed');
  } finally {
    await tab.close();
  }
});

test('contenteditable replace: select-all is verified; whatever is left outside the selection must provably be nothing', { skip }, async () => {
  const tab = await tabAt('/act-editors');
  try {
    const snap = await tab.snapshot();
    // re-review C: contenteditable replace is checked; a page that collapses the selection is refused
    await tab.type(refOf(snap, 'editor'), 'new', { replace: true });
    assert.equal((await tab.read(refOf(snap, 'editor'))).text, 'new');
    await failsWith(() => tab.type(refOf(snap, 'sneaky editor'), 'new', { replace: true }), 'unsupported');
    assert.equal((await tab.read(refOf(snap, 'sneaky editor'))).text, 'old');
    // round 3 C: a selection reaching beyond the field, or blank lines left unselected, are not "all selected"
    await failsWith(() => tab.type(refOf(snap, 'wide editor'), 'new', { replace: true }), 'unsupported');
    assert.equal((await tab.read(refOf(snap, 'wide editor'))).text, 'old');
    await failsWith(() => tab.type(refOf(snap, 'blank editor'), 'new', { replace: true }), 'unsupported');
    await tab.type(refOf(snap, 'lines editor'), 'new', { replace: true });
    assert.equal((await tab.read(refOf(snap, 'lines editor'))).text, 'new');
    // round 4: white space that is content (&nbsp;, pre-wrap) must be selected too; HTML indentation is not content
    await failsWith(() => tab.type(refOf(snap, 'spaced editor'), 'new', { replace: true }), 'unsupported');
    assert.equal((await tab.read(refOf(snap, 'spaced editor'))).text, '\u00a0\u00a0old\u00a0\u00a0');
    await failsWith(() => tab.type(refOf(snap, 'pre editor'), 'new', { replace: true }), 'unsupported');
    assert.equal((await tab.read(refOf(snap, 'pre editor'))).text, '   ');
    await tab.type(refOf(snap, 'indented editor'), 'new', { replace: true });
    assert.equal((await tab.read(refOf(snap, 'indented editor'))).text, 'new');
    // the trailing <br> is a placeholder, not content: Chrome's own select-all leaves it, as it does for a person
    await tab.type(refOf(snap, 'br editor'), 'new', { replace: true });
    const html = (/** @type {string} */ name) => tab.onNode(refOf(snap, name), /** @this {Element} */ function () { return this.innerHTML; });
    assert.equal(await html('br editor'), 'new<br>');
    // round 5: left-out blank lines (a second <br>, pre-wrap newlines) and zero-width characters are content
    await tab.type(refOf(snap, 'two br editor'), 'new', { replace: true });
    assert.equal(await html('two br editor'), 'new', 'native select-all takes both breaks');
    for (const name of ['two br sneaky', 'newline editor', 'shy editor']) {
      const before = await html(name);
      await failsWith(() => tab.type(refOf(snap, name), 'new', { replace: true }), 'unsupported');
      assert.equal(await html(name), before, `${name} unchanged`);
    }
  } finally {
    await tab.close();
  }
});

test('the wheel scrolls in segments', { skip }, async () => {
  const tab = await tabAt('/act');
  try {
    // over a main-page element: the middle of this page is an OOPIF, which would take the wheel itself
    const r = await tab.scroll({ ref: refOf(await tab.snapshot(), 'top button'), dy: 500 });
    assert.ok(r.segments >= 3, `${r.segments} segments`);
    let y = 0;
    for (let i = 0; i < 30 && y < 450; i++) {
      y = await tab.evaluate(() => scrollY);
      await sleep(100);
    }
    assert.ok(y >= 450, `the page scrolled (${y})`);
  } finally {
    await tab.close();
  }
});

test('review ①: a double click whose first click replaced the button does not press the new one; the first went in, so result_unknown (#34)', { skip }, async () => {
  const tab = await tabAt('/act-replace');
  try {
    await failsWith(async () => tab.dblclick(refOf(await tab.snapshot(), 'target')), 'result_unknown');
    assert.equal((await marks(tab)).downs, 'target;', 'one mousedown, on the original button');
  } finally {
    await tab.close();
  }
});

test('a button still gliding after typing is pressed where it ends up, not refused as occluded', { skip }, async () => {
  const tab = await tabAt('/act-glide');
  try {
    const snap = await tab.snapshot();
    await tab.type(refOf(snap, 'field'), 'x', { fast: true });
    await tab.click(refOf(snap, 'glider'), { fast: true });
    assert.equal((await marks(tab)).downs, ';glider;', 'the field, then the button where it ended up');
  } finally {
    await tab.close();
  }
});

test('browser zoom (the user pressed Cmd +/−): the press still lands on the button, zoomed in and out', { skip }, async () => {
  for (const factor of [1.75, 0.6]) {
    const tab = await tabAt('/act-glide');
    try {
      const before = await tab.evaluate(() => devicePixelRatio);
      await chrome.userZooms(site.url('/act-glide'), factor);
      await sleep(300);
      assert.ok(Math.abs(await tab.evaluate(() => devicePixelRatio) - before * factor) < 0.05, 'the zoom took effect');
      await tab.click(refOf(await tab.snapshot(), 'glider'), { fast: true });
      assert.equal((await marks(tab)).downs, 'glider;', `zoom ${factor}`);
    } finally {
      await chrome.userZooms(site.url('/act-glide'), 1); // Chrome keeps a zoom per site
      await tab.close();
    }
  }
});

test('review ②: an OOPIF turned 180° after the pointer started moving: not pressed (neither the target nor its mirror)', { skip }, async () => {
  const tab = await tabAt('/act-turn');
  try {
    const snap = await tab.snapshot();
    const frameId = snap.refs.find((r) => r.name === 'tbutton')?.stamp.frameId;
    await failsWith(() => tab.click(refOf(snap, 'tbutton')), 'unsupported_transform');
    assert.equal((await marks(tab, frameId)).mousedown, undefined);
  } finally {
    await tab.close();
  }
});

test('review ④: a wheel over a ref that something covers once the pointer arrives: no wheel at all', { skip }, async () => {
  const tab = await tabAt('/swap?mode=cover');
  try {
    await failsWith(async () => tab.scroll({ ref: refOf(await tab.snapshot(), 'target'), dy: 400 }), 'occluded');
  } finally {
    await tab.close();
  }
});
