// @ts-check
// Unit tests: key table, input lock, and every branch of the check right before a press, against a scripted
// CDP wire. Each test names the completion condition it covers.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SdkError } from '../src/sdk/cdp.js';
import { Input } from '../src/sdk/input.js';
import { keyEvent, keyForChar, parseCombo } from '../src/sdk/keys.js';
import { axDoc, MAIN, open, refOf, rejectsWith, tick, Wire } from './wire.js';

/** @param {[number, number, number, number]} box x, y, w, h */
const quad = ([x, y, w, h]) => [x, y, x + w, y, x + w, y + h, x, y + h];

/**
 * A wire that can act: a page whose nodes have boxes, roles and names, a hit test, and page-world helpers.
 * @param {{ nodes?: Record<number, { box: [number, number, number, number], role: string, name: string }> }} [o]
 */
function actWire({ nodes = { 7: { box: [100, 100, 80, 30], role: 'button', name: 'go' } } } = {}) {
  const w = new Wire();
  const page = {
    nodes,
    /** session -> scroll offset @type {Record<string, { x: number, y: number }>} */
    scroll: {},
    /** what the hit test finds (default: the node whose box holds the point) @type {(sid: string | null, x: number, y: number) => { backendNodeId: number, frameId: string } | null} */
    hit: (sid, x, y) => {
      for (const [id, n] of Object.entries(nodes)) {
        const [bx, by, bw, bh] = n.box;
        if (x >= bx && x < bx + bw && y >= by && y < by + bh) return { backendNodeId: Number(id), frameId: MAIN };
      }
      return null;
    },
    connected: true,
    within: false,
    context: true,
    focused: true,
    allSelected: true,
    readOnly: false,
    mac: true,
    /** @type {string[]} */ transform: [],
    viewport: [300, 150],
  };
  w.ax.set(MAIN, axDoc(MAIN, Object.entries(nodes).map(([id, n]) => [n.role, n.name, Number(id)])));
  w.on('DOM.getContentQuads', (p) => ({ quads: nodes[p.backendNodeId] ? [quad(nodes[p.backendNodeId].box)] : [] }));
  w.on('Page.getLayoutMetrics', (_, sid) => {
    const s = page.scroll[String(sid)] ?? { x: 0, y: 0 };
    return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: s.x, pageY: s.y } };
  });
  w.on('DOM.getNodeForLocation', (p, sid) => {
    const s = page.scroll[String(sid)] ?? { x: 0, y: 0 };
    const h = page.hit(sid, p.x - s.x, p.y - s.y);
    if (!h) throw new Error('No node found at given location');
    return h;
  });
  w.on('Accessibility.getPartialAXTree', (p) => {
    const n = nodes[p.backendNodeId];
    return { nodes: n ? [{ nodeId: 'x', role: { value: n.role }, name: { value: n.name }, backendDOMNodeId: p.backendNodeId }] : [] };
  });
  w.on('Runtime.callFunctionOn', (p) => {
    const f = String(p.functionDeclaration);
    const value = f.includes('kbConnected') ? page.connected : f.includes('kbWithin') ? page.within : f.includes('kbContextHas') ? page.context
      : f.includes('kbTransformProblems') ? page.transform : f.includes('kbFocused') ? page.focused
        : f.includes('kbAllSelected') ? page.allSelected : f.includes('kbReadOnly') ? page.readOnly : f.includes('kbIsMac') ? page.mac : true;
    return { result: { value } };
  });
  w.on('Runtime.evaluate', (p) => ({ result: { value: String(p.expression).includes('kbViewport') ? page.viewport : 'ran' } }));
  w.on('Input.dispatchMouseEvent', () => ({}));
  w.on('Input.dispatchKeyEvent', () => ({}));
  w.on('Input.insertText', () => ({}));
  w.on('DOM.scrollIntoViewIfNeeded', () => ({}));
  w.on('DOM.focus', () => ({}));
  return { w, page };
}

/** @param {Wire} w */
async function ready(w) {
  const tab = await open(w);
  tab.input.sleep = async () => {};
  return tab;
}

/** @param {Wire} w @param {string} type */
const mouse = (w, type) => w.sent.filter((m) => m.method === 'Input.dispatchMouseEvent' && m.params.type === type);

// ---------- keys ----------

test('the key table: key, code and windowsVirtualKeyCode agree like a US keyboard (no `keyCode` field)', () => {
  assert.deepEqual(keyForChar('a'), { key: 'a', code: 'KeyA', keyCode: 65, text: 'a' });
  assert.deepEqual(keyForChar('A'), { key: 'A', code: 'KeyA', keyCode: 65, text: 'A', shift: true });
  assert.deepEqual(keyForChar('1'), { key: '1', code: 'Digit1', keyCode: 49, text: '1' });
  assert.deepEqual(keyForChar('!'), { key: '!', code: 'Digit1', keyCode: 49, text: '!', shift: true });
  assert.deepEqual(keyForChar('?'), { key: '?', code: 'Slash', keyCode: 191, text: '?', shift: true });
  assert.equal(keyForChar(' ')?.code, 'Space');
  assert.equal(keyForChar('中'), null);
  assert.equal(keyForChar('é'), null);
  const down = keyEvent('keyDown', /** @type {any} */ (keyForChar('A')), 8);
  assert.deepEqual(down, { type: 'keyDown', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 8, text: 'A', unmodifiedText: 'A' });
  assert.equal('keyCode' in down, false);
  assert.equal('text' in keyEvent('keyUp', /** @type {any} */ (keyForChar('a')), 0), false, 'only keyDown carries text');
  const tab = parseCombo('Shift+Tab');
  assert.deepEqual([tab.modifiers, tab.key.code, tab.key.keyCode], [['Shift'], 'Tab', 9]);
  assert.equal(parseCombo('Control++').key.key, '+');
  assert.throws(() => parseCombo('Hyper+a'));
  assert.throws(() => parseCombo('Nope'));
});

test('typing: Shift is pressed around shifted characters, and text outside the table goes in with insertText, counted', async () => {
  const w = new Wire();
  w.on('Input.dispatchKeyEvent', () => ({}));
  w.on('Input.insertText', () => ({}));
  const input = new Input(w.client, 'S', { sleep: async () => {} });
  const r = await input.type('aB中文!', { fast: true });
  assert.deepEqual(r, { keys: 3, inserted: 2 });
  const seq = w.sent.map((m) => (m.method === 'Input.insertText' ? `insert:${m.params.text}` : `${m.params.type}:${m.params.code}:${m.params.modifiers}${m.params.text ? `:${m.params.text}` : ''}`));
  assert.deepEqual(seq, [
    'keyDown:KeyA:0:a', 'keyUp:KeyA:0',
    'rawKeyDown:ShiftLeft:8', 'keyDown:KeyB:8:B', 'keyUp:KeyB:8', 'keyUp:ShiftLeft:0',
    'insert:中文',
    'rawKeyDown:ShiftLeft:8', 'keyDown:Digit1:8:!', 'keyUp:Digit1:8', 'keyUp:ShiftLeft:0',
  ]);
  for (const m of w.sent.filter((x) => x.method === 'Input.dispatchKeyEvent')) assert.equal(typeof m.params.windowsVirtualKeyCode, 'number');
});

test('a shortcut (Control / Meta / Alt held) types no text', async () => {
  const w = new Wire();
  w.on('Input.dispatchKeyEvent', () => ({}));
  const input = new Input(w.client, 'S', { sleep: async () => {} });
  await input.key('Control+a', { fast: true });
  const a = w.sent.find((m) => m.params.code === 'KeyA' && m.params.type !== 'keyUp');
  assert.deepEqual([a?.params.type, a?.params.modifiers, 'text' in (a?.params ?? {})], ['rawKeyDown', 2, false]);
});

// ---------- pointer ----------

test('the pointer travels: at least 5 mouseMoved events, ending inside the target away from its edges, before the press', async () => {
  const { w } = actWire();
  const tab = await ready(w);
  const ref = refOf(tab, await tab.snapshot(), 'go');
  // the extremes of the random draw land 15% inside the box, never on its edge
  for (const [draw, x, y] of /** @type {const} */ ([[0, 100 + 80 * 0.15, 100 + 30 * 0.15], [0.999999, 100 + 80 * 0.85, 100 + 30 * 0.85]])) {
    const before = w.sent.length;
    tab.input.rand = () => draw;
    const r = await tab.click(ref, { fast: true });
    const sent = w.sent.slice(before);
    const moves = sent.filter((m) => m.params.type === 'mouseMoved');
    assert.ok(moves.length >= 5, `${moves.length} moves (also for the short second trip)`);
    assert.equal(r.moves, moves.length);
    const press = sent.find((m) => m.params.type === 'mousePressed')?.params;
    assert.ok(press, 'pressed');
    const last = moves.at(-1)?.params;
    assert.deepEqual([press.x, press.y], [last?.x, last?.y], 'pressed where the pointer arrived');
    assert.ok(Math.abs(press.x - x) < 0.01 && Math.abs(press.y - y) < 0.01, `at ${press.x},${press.y}, expected ${x},${y}`);
    // never a jump: each step is a small part of the trip
    const pts = moves.map((m) => m.params);
    for (let i = 1; i < pts.length; i++) assert.ok(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) < 400 / 3);
  }
  assert.equal(mouse(w, 'mouseReleased').length, 2);
});

test('dblclick: two press/release pairs with clickCount 1 then 2', async () => {
  const { w } = actWire();
  const tab = await ready(w);
  await tab.dblclick(refOf(tab, await tab.snapshot(), 'go'), { fast: true });
  assert.deepEqual(w.sent.filter((m) => m.method === 'Input.dispatchMouseEvent' && m.params.type !== 'mouseMoved').map((m) => `${m.params.type}:${m.params.clickCount}`),
    ['mousePressed:1', 'mouseReleased:1', 'mousePressed:2', 'mouseReleased:2']);
});

test('the input lock: two actions on one tab never interleave their events', async () => {
  const { w } = actWire({ nodes: { 7: { box: [50, 50, 40, 20], role: 'button', name: 'a' }, 8: { box: [600, 400, 40, 20], role: 'button', name: 'b' } } });
  const tab = await ready(w);
  const snap = await tab.snapshot();
  await Promise.all([tab.click(refOf(tab, snap, 'a'), { fast: true }), tab.click(refOf(tab, snap, 'b'), { fast: true })]);
  const seq = w.sent.filter((m) => m.method === 'Input.dispatchMouseEvent').map((m) => m.params.type);
  const firstRelease = seq.indexOf('mouseReleased');
  assert.deepEqual(seq.slice(0, firstRelease + 1).filter((t) => t !== 'mouseMoved'), ['mousePressed', 'mouseReleased'],
    'the first action pressed and released before the second moved');
  assert.equal(seq.indexOf('mousePressed'), firstRelease - 1, 'nothing between the first press and its release');
  assert.ok(seq.lastIndexOf('mouseMoved') > firstRelease, 'the second action moved after the first finished');
});

// ---------- the check before pressing ----------

test('the check runs after the pointer arrives and before the press', async () => {
  const { w } = actWire();
  const tab = await ready(w);
  await tab.click(refOf(tab, await tab.snapshot(), 'go'), { fast: true });
  const at = (/** @type {(m: any) => boolean} */ f) => w.sent.findIndex(f);
  const lastMove = w.sent.findLastIndex((m) => m.params.type === 'mouseMoved');
  const hit = w.sent.findLastIndex((m) => m.method === 'DOM.getNodeForLocation');
  const ax = w.sent.findLastIndex((m) => m.method === 'Accessibility.getPartialAXTree');
  const press = at((m) => m.params.type === 'mousePressed');
  assert.ok(lastMove < ax && ax < press && lastMove < hit && hit < press, `move ${lastMove} < check ${ax},${hit} < press ${press}`);
});

/** Runs a click and asserts it failed with `code` and nothing was pressed. @param {Wire} w @param {import('../src/sdk/index.js').Tab} tab @param {string} code @param {Record<string, any>} [o] */
async function refused(w, tab, code, o = {}) {
  const ref = refOf(tab, await tab.snapshot(), 'go');
  await rejectsWith(() => tab.click(ref, { fast: true, ...o }), code);
  assert.equal(mouse(w, 'mousePressed').length, 0, 'nothing pressed');
}

test('stale_ref: the frame navigates while the pointer is on its way: no press', async () => {
  const { w } = actWire();
  const tab = await ready(w);
  let n = 0;
  w.on('Input.dispatchMouseEvent', () => { if (++n === 2) setImmediate(() => w.event('Page.frameNavigated', { frame: { id: MAIN, url: 'https://a.test/2' } })); return {}; });
  await refused(w, tab, 'stale_ref');
});

test('target_changed: the node now has another name (or role): no press', async () => {
  const { w } = actWire();
  const tab = await ready(w);
  const ref = refOf(tab, await tab.snapshot(), 'go');
  w.on('Accessibility.getPartialAXTree', (p) => ({ nodes: [{ role: { value: 'button' }, name: { value: 'Delete all' }, backendDOMNodeId: p.backendNodeId }] }));
  await rejectsWith(() => tab.click(ref, { fast: true }), 'target_changed');
  assert.equal(mouse(w, 'mousePressed').length, 0);
});

test('target_changed: the context text is no longer next to the node (virtual list reuse): no press', async () => {
  const { w, page } = actWire();
  const tab = await ready(w);
  page.context = false;
  await refused(w, tab, 'target_changed', { context: 'Order #1234' });
});

test('stale_ref: the node is no longer connected to the document: no press', async () => {
  const { w, page } = actWire();
  const tab = await ready(w);
  page.connected = false;
  await refused(w, tab, 'stale_ref');
});

test('not_visible: no box (or Chrome cannot compute one): no move, no press', async () => {
  const { w } = actWire();
  const tab = await ready(w);
  w.on('DOM.getContentQuads', () => ({ quads: [] }));
  await refused(w, tab, 'not_visible');
  w.on('DOM.getContentQuads', () => ({ quads: [[100, 100, 100, 100, 100, 100, 100, 100]] })); // zero area (display: contents, collapsed)
  await refused(w, tab, 'not_visible');
  w.on('DOM.getContentQuads', () => { throw new Error('Could not compute content quads.'); });
  await refused(w, tab, 'not_visible');
  assert.equal(mouse(w, 'mouseMoved').length, 0);
});

test('not_visible: still outside the viewport after scrolling it into view', async () => {
  const { w } = actWire({ nodes: { 7: { box: [100, 2000, 80, 30], role: 'button', name: 'go' } } });
  const tab = await ready(w);
  await refused(w, tab, 'not_visible');
  assert.equal(w.count('DOM.scrollIntoViewIfNeeded'), 1, 'it tried scrolling once');
});

test('occluded: something else is at the press point: no press', async () => {
  const { w, page } = actWire();
  const tab = await ready(w);
  page.hit = () => ({ backendNodeId: 99, frameId: MAIN });
  page.within = false;
  await refused(w, tab, 'occluded');
});

test('occluded by something with no name (a menu backdrop): the message gives its tag and class and how to clear it', async () => {
  const { w, page } = actWire();
  const tab = await ready(w);
  page.hit = () => ({ backendNodeId: 99, frameId: MAIN });
  page.within = false;
  w.on('DOM.describeNode', (p) => ({ node: p.backendNodeId === 99 ? { localName: 'div', attributes: ['class', 'dialogBackdrop dialogBackdropOpened'] } : { frameId: MAIN } }));
  const ref = refOf(tab, await tab.snapshot(), 'go');
  await assert.rejects(() => tab.click(ref, { fast: true }), (e) => {
    assert.match(String(/** @type {any} */ (e).message), /covered by <div class="dialogBackdrop dialogBackdropOpened"> \(it has no name: .*Escape/);
    return true;
  });
});

test('a hit on a node inside the target (a span in the button, a node in its shadow tree) passes', async () => {
  const { w, page } = actWire();
  const tab = await ready(w);
  page.hit = () => ({ backendNodeId: 99, frameId: MAIN });
  page.within = true;
  await tab.click(refOf(tab, await tab.snapshot(), 'go'), { fast: true });
  assert.equal(mouse(w, 'mousePressed').length, 1);
  const within = w.sent.find((m) => String(m.params.functionDeclaration ?? '').includes('kbWithin'));
  assert.deepEqual([within?.params.objectId, within?.params.arguments], ['obj-99', [{ objectId: 'obj-7' }]], 'asked whether the hit node is inside the target');
});

test('occluded: a hit in another frame (a same-process iframe over the target) does not count as the target', async () => {
  const { w, page } = actWire();
  const tab = await ready(w);
  page.hit = () => ({ backendNodeId: 7, frameId: 'OTHER' });
  page.within = true; // only the frame comparison stands in the way
  await refused(w, tab, 'occluded');
});

// ---------- OOPIFs ----------

/** A tab with an OOPIF X (session S1) whose iframe element (backend 50) has its content box at (360, 70), 300x150. */
async function oopif() {
  const { w, page } = actWire({ nodes: { 8: { box: [30, 25, 100, 30], role: 'button', name: 'go' } } });
  w.ax.set(MAIN, axDoc(MAIN, []));
  w.ax.set('X', axDoc('X', [['button', 'go', 8]]));
  w.on('DOM.getFrameOwner', (p, sid) => { assert.deepEqual([p.frameId, sid], ['X', 'ROOT']); return { backendNodeId: 50 }; });
  w.on('DOM.getBoxModel', () => ({ model: { content: quad([360, 70, 300, 150]) } }));
  page.hit = (sid, x, y) => (sid === 'ROOT'
    ? (x >= 360 && x < 660 && y >= 70 && y < 220 ? { backendNodeId: 50, frameId: MAIN } : null)
    : (x >= 30 && x < 130 && y >= 25 && y < 55 ? { backendNodeId: 8, frameId: 'X' } : null));
  const tab = await ready(w);
  w.attach('S1', 'X');
  await tick();
  await tab.settled();
  return { w, page, tab };
}

test('OOPIF: press point = point in the child + the iframe content box; hit-tested in the root, then in the child with its scroll', async () => {
  const { w, page, tab } = await oopif();
  page.scroll.S1 = { x: 0, y: 100 };
  const r = await tab.click(refOf(tab, await tab.snapshot(), 'go'), { fast: true });
  const p = mouse(w, 'mousePressed')[0].params;
  assert.ok(p.x >= 390 && p.x < 490 && p.y >= 95 && p.y < 125, `pressed at ${p.x},${p.y}`);
  assert.equal(mouse(w, 'mousePressed')[0].sessionId, 'ROOT', 'input goes to the root session');
  const hits = w.sent.filter((m) => m.method === 'DOM.getNodeForLocation');
  assert.deepEqual(hits.map((m) => m.sessionId), ['ROOT', 'S1']);
  assert.equal(hits[1].params.y, Math.round(p.y - 70 + 100), 'the child hit test uses document coordinates (its scroll added)');
  assert.equal(r.crossFrames, 1);
});

test('unsupported_transform: the iframe or an ancestor is scaled / rotated / zoomed (style), even with an upright box', async () => {
  const { w, page, tab } = await oopif();
  page.transform = ['iframe#f transform: matrix(0, 1, -1, 0, 0, 0)'];
  await refused(w, tab, 'unsupported_transform');
  assert.equal(mouse(w, 'mouseMoved').length, 0);
});

test('unsupported_transform: the iframe box is not the size of the page inside it (scale, zoom)', async () => {
  const { w, page, tab } = await oopif();
  page.viewport = [450, 225];
  await refused(w, tab, 'unsupported_transform');
});

test('unsupported_transform: an iframe box that is not an upright rectangle (180° turns it upside down; a skew keeps its size)', async () => {
  const { w, tab } = await oopif();
  w.on('DOM.getBoxModel', () => ({ model: { content: [660, 220, 360, 220, 360, 70, 660, 70] } }));
  await refused(w, tab, 'unsupported_transform');
  w.on('DOM.getBoxModel', () => ({ model: { content: [360, 70, 660, 70, 690, 220, 390, 220] } })); // 300 wide, 150 high, slanted
  await refused(w, tab, 'unsupported_transform');
});

test('occluded: in the root, something covers the iframe at the press point', async () => {
  const { w, page, tab } = await oopif();
  page.hit = (sid) => (sid === 'ROOT' ? { backendNodeId: 77, frameId: MAIN } : { backendNodeId: 8, frameId: 'X' });
  await refused(w, tab, 'occluded');
});

// ---------- typing and select ----------

test('type: nothing is typed when the click did not give the field the keyboard focus', async () => {
  const { w, page } = actWire({ nodes: { 7: { box: [100, 100, 200, 30], role: 'textbox', name: 'go' } } });
  const tab = await ready(w);
  page.focused = false;
  const ref = refOf(tab, await tab.snapshot(), 'go');
  await rejectsWith(() => tab.type(ref, 'hello', { fast: true }), 'not_focused');
  assert.equal(w.count('Input.dispatchKeyEvent') + w.count('Input.insertText'), 0);
});

test('select: never sets the value from script; an option the keyboard cannot reach on macOS is `unsupported`', async () => {
  const { w } = actWire({ nodes: { 7: { box: [100, 100, 120, 24], role: 'combobox', name: 'go' } } });
  const tab = await ready(w);
  const options = [{ value: 'a', label: 'Apple', disabled: false }, { value: 't', label: '台北', disabled: false }];
  w.on('Runtime.callFunctionOn', (p) => {
    const f = String(p.functionDeclaration);
    if (f.includes('kbSelectState')) return { result: { value: { multiple: false, selectedIndex: 0, value: 'a', options } } };
    if (f.includes('kbIsMac')) return { result: { value: true } };
    return { result: { value: true } };
  });
  const ref = refOf(tab, await tab.snapshot(), 'go');
  await rejectsWith(() => tab.select(ref, { label: '台北' }, { fast: true }), 'unsupported');
  assert.equal(w.sent.filter((m) => m.params.code === 'ArrowDown' || m.params.code === 'ArrowUp').length, 0, 'no arrow keys on macOS');
  for (const m of w.sent) {
    assert.ok(!/\.value\s*=|selectedIndex\s*=|dispatchEvent/.test(String(m.params.functionDeclaration ?? m.params.expression ?? '')), `no script sets the value: ${m.method}`);
  }
  await rejectsWith(() => tab.select(ref, { label: 'Nope' }), 'bad_argument');
});

// ---------- race windows reproduced in Chrome ----------

test('① a document replaced after the check (while its objects are released) is known stale: no press', async () => {
  const { w } = actWire();
  const tab = await ready(w);
  const ref = refOf(tab, await tab.snapshot(), 'go');
  // the event arrives before the release is answered: the check itself had passed, the press has not been sent yet
  w.on('Runtime.releaseObject', () => { w.event('Page.documentOpened', { frame: { id: MAIN, url: 'https://a.test/' } }); return {}; });
  await rejectsWith(() => tab.click(ref, { fast: true }), 'stale_ref');
  assert.equal(mouse(w, 'mousePressed').length, 0);
});

test('① dblclick: the second press is checked again (the first click replaced the button): one press only, released; the first went in, so result_unknown (#34)', async () => {
  const { w, page } = actWire();
  const tab = await ready(w);
  const ref = refOf(tab, await tab.snapshot(), 'go');
  w.on('Input.dispatchMouseEvent', (p) => { if (p.type === 'mouseReleased') page.connected = false; return {}; });
  await rejectsWith(() => tab.dblclick(ref, { fast: true }), 'result_unknown');
  assert.deepEqual([mouse(w, 'mousePressed').length, mouse(w, 'mouseReleased').length], [1, 1]);
});

test('② an OOPIF turned, or moved, after the pointer arrived: the geometry is measured again, no press', async () => {
  for (const [change, code] of /** @type {const} */ ([['turn', 'unsupported_transform'], ['move', 'target_changed']])) {
    const { w, page, tab } = await oopif();
    let moved = false;
    w.on('Input.dispatchMouseEvent', () => {
      if (!moved) {
        moved = true;
        if (change === 'turn') page.transform = ['iframe#f transform: matrix(-1, 0, 0, -1, 0, 0)'];
        else w.on('DOM.getBoxModel', () => ({ model: { content: quad([380, 70, 300, 150]) } }));
      }
      return {};
    });
    await refused(w, tab, code);
  }
});

test('③ type: before every key the field must still have the focus (a handler moved it after the first key)', async () => {
  const { w, page } = actWire({ nodes: { 7: { box: [100, 100, 200, 30], role: 'textbox', name: 'go' } } });
  const tab = await ready(w);
  const ref = refOf(tab, await tab.snapshot(), 'go');
  w.on('Input.dispatchKeyEvent', (p) => { if (p.type === 'keyUp') page.focused = false; return {}; });
  // "A" went in before the focus moved: maybe done, not a plain "not done"
  await rejectsWith(() => tab.type(ref, 'AB中', { fast: true }), 'result_unknown');
  const downs = w.sent.filter((m) => m.method === 'Input.dispatchKeyEvent' && m.params.type !== 'keyUp').map((m) => m.params.key);
  assert.deepEqual(downs, ['Shift', 'A'], 'only the first character went in');
  assert.equal(w.count('Input.insertText'), 0);
});

test('③ select: checked like a click target (covered -> occluded, nothing focused or typed); focus lost while waiting -> not_focused', async () => {
  const options = [{ value: 'a', label: 'Apple', disabled: false }, { value: 'b', label: 'Banana', disabled: false }];
  const setup = () => {
    const { w, page } = actWire({ nodes: { 7: { box: [100, 100, 120, 24], role: 'combobox', name: 'go' } } });
    const route = /** @type {any} */ (w.handlers.get('Runtime.callFunctionOn'));
    w.on('Runtime.callFunctionOn', (p, sid) => (String(p.functionDeclaration).includes('kbSelectState')
      ? { result: { value: { multiple: false, selectedIndex: 0, value: 'a', options } } } : route(p, sid)));
    return { w, page };
  };
  {
    const { w, page } = setup();
    const tab = await ready(w);
    page.hit = () => ({ backendNodeId: 99, frameId: MAIN });
    await rejectsWith(async () => tab.select(refOf(tab, await tab.snapshot(), 'go'), { label: 'Banana' }, { fast: true }), 'occluded');
    assert.equal(w.count('DOM.focus') + w.count('Input.dispatchKeyEvent'), 0);
  }
  {
    const { w, page } = setup();
    const tab = await ready(w);
    tab.input.lastKeyAt = Date.now(); // a key a moment ago: select waits out type-to-select ...
    tab.input.sleep = async () => { page.focused = false; }; // ... and the page moves the focus meanwhile
    await rejectsWith(async () => tab.select(refOf(tab, await tab.snapshot(), 'go'), { label: 'Banana' }, { fast: true }), 'not_focused');
    assert.equal(w.count('Input.dispatchKeyEvent'), 0, 'nothing typed into whatever has the focus now');
  }
});

test('④ scroll over a ref: checked once the pointer is there (a cover -> occluded, no wheel); a frame change stops the rest', async () => {
  {
    const { w, page } = actWire();
    const tab = await ready(w);
    page.hit = () => ({ backendNodeId: 99, frameId: MAIN });
    await rejectsWith(async () => tab.scroll({ ref: refOf(tab, await tab.snapshot(), 'go'), dy: 500 }, { fast: true }), 'occluded');
    assert.equal(mouse(w, 'mouseWheel').length, 0);
  }
  {
    const { w } = actWire();
    const tab = await ready(w);
    const ref = refOf(tab, await tab.snapshot(), 'go');
    w.on('Input.dispatchMouseEvent', (p) => { if (p.type === 'mouseWheel') w.event('Page.frameNavigated', { frame: { id: MAIN, url: 'https://a.test/2' } }); return {}; });
    await rejectsWith(() => tab.scroll({ ref, dy: 1000 }, { fast: true }), 'result_unknown'); // the first segment went in (#34)
    assert.equal(mouse(w, 'mouseWheel').length, 1, 'no segment after the frame changed');
  }
});

test('⑤ a failure half way releases what it pressed (button, key, modifier), once; the action is not replayed', async () => {
  {
    const { w } = actWire();
    const tab = await ready(w);
    let failed = false;
    w.on('Input.dispatchMouseEvent', (p) => { if (p.type === 'mouseReleased' && !failed) { failed = true; throw new Error('boom'); } return {}; });
    await rejectsWith(async () => tab.click(refOf(tab, await tab.snapshot(), 'go'), { fast: true }), 'result_unknown'); // the press went in (#34)
    assert.deepEqual([mouse(w, 'mousePressed').length, mouse(w, 'mouseReleased').length], [1, 2], 'one press; its release retried by the cleanup');
    assert.equal(tab.input.button, null);
  }
  {
    // a press whose answer is an error (or never comes) may still have happened: it is released, not replayed
    const { w } = actWire();
    const tab = await ready(w);
    w.on('Input.dispatchMouseEvent', (p) => { if (p.type === 'mousePressed') throw new Error('boom'); return {}; });
    await rejectsWith(async () => tab.click(refOf(tab, await tab.snapshot(), 'go'), { fast: true }), 'result_unknown');
    assert.deepEqual([mouse(w, 'mousePressed').length, mouse(w, 'mouseReleased').length], [1, 1]);
  }
  {
    // a key that took effect before the connection dropped: it went in (#34)
    const { w } = actWire();
    const tab = await ready(w);
    w.on('Input.dispatchKeyEvent', (p) => { if (p.type === 'keyUp') throw new Error('gone'); return {}; });
    await rejectsWith(() => tab.key('Enter', { fast: true }), 'result_unknown');
  }
  {
    // nothing went in: the error keeps its own code
    const { w, page } = actWire();
    const tab = await ready(w);
    page.hit = () => ({ backendNodeId: 99, frameId: MAIN });
    await rejectsWith(async () => tab.dblclick(refOf(tab, await tab.snapshot(), 'go'), { fast: true }), 'occluded');
  }
  {
    const w = new Wire();
    w.on('Input.dispatchKeyEvent', (p) => { if (p.type === 'keyDown' && p.key === 'B') throw new Error('boom'); return {}; });
    const input = new Input(w.client, 'S', { sleep: async () => {} });
    await assert.rejects(input.locked(() => input.type('B', { fast: true })));
    const seq = w.sent.map((m) => `${m.params.type}:${m.params.code}:${m.params.modifiers}`);
    assert.deepEqual(seq, ['rawKeyDown:ShiftLeft:8', 'keyDown:KeyB:8', 'keyUp:KeyB:8', 'keyUp:ShiftLeft:0'],
      'every down got its up, with the modifiers still held at that moment (as on the normal path)');
    assert.equal(input.keys.size, 0);
  }
});

test('the sent count: an event the closed client refused to send is not counted', async () => {
  const w = new Wire();
  w.on('Input.dispatchKeyEvent', () => ({}));
  const input = new Input(w.client, 'S', { sleep: async () => {} });
  await input.locked(() => input.type('a', { fast: true }));
  const n = input.sent;
  assert.ok(n >= 1);
  w.client.closed('test: gone');
  await assert.rejects(input.locked(() => input.type('b', { fast: true })));
  assert.equal(input.sent, n, 'nothing went in');
});

test('⑤ arguments that would never end or are not a click: refused before any input', async () => {
  const { w } = actWire();
  const tab = await ready(w);
  const ref = refOf(tab, await tab.snapshot(), 'go');
  await rejectsWith(() => tab.scroll({ dy: Infinity }, { fast: true }), 'bad_argument');
  await rejectsWith(() => tab.scroll({ dy: NaN }, { fast: true }), 'bad_argument');
  for (const n of [0, 4, 1.5]) await rejectsWith(() => tab.click(ref, { fast: true, clickCount: n }), 'bad_argument');
  assert.equal(w.count('Input.dispatchMouseEvent'), 0);
});

test('⑦ keys: Shift+a types "A", and "A" alone presses Shift, like a keyboard', async () => {
  const w = new Wire();
  w.on('Input.dispatchKeyEvent', () => ({}));
  const input = new Input(w.client, 'S', { sleep: async () => {} });
  await input.key('Shift+a', { fast: true });
  await input.key('A', { fast: true });
  const seq = w.sent.map((m) => `${m.params.type}:${m.params.key}:${m.params.modifiers}${m.params.text ? `:${m.params.text}` : ''}`);
  assert.deepEqual(seq, [
    'rawKeyDown:Shift:8', 'keyDown:A:8:A', 'keyUp:A:8', 'keyUp:Shift:0',
    'rawKeyDown:Shift:8', 'keyDown:A:8:A', 'keyUp:A:8', 'keyUp:Shift:0',
  ]);
});

test('macOS shortcuts run their editing commands; copy, cut and paste never touch the clipboard', async () => {
  const w = new Wire();
  w.on('Input.dispatchKeyEvent', () => ({}));
  const input = new Input(w.client, 'S', { sleep: async () => {} });
  const cmds = async (/** @type {string} */ combo) => {
    w.sent.length = 0;
    await input.key(combo, { fast: true });
    return w.sent.find((m) => m.params.type !== 'keyUp' && !['Meta', 'Shift', 'Alt', 'Control'].includes(m.params.key))?.params.commands;
  };
  const mac = process.platform === 'darwin';
  assert.deepEqual(await cmds('Meta+z'), mac ? ['undo'] : undefined);
  assert.deepEqual(await cmds('Shift+Meta+z'), mac ? ['redo'] : undefined, 'modifiers in any order');
  assert.deepEqual(await cmds('Alt+Shift+ArrowLeft'), mac ? ['moveWordLeftAndModifySelection'] : undefined);
  assert.deepEqual(await cmds('Meta+Backspace'), mac ? ['deleteToBeginningOfLine'] : undefined);
  for (const c of ['Meta+c', 'Meta+x', 'Meta+v', 'Control+a', 'Enter']) assert.equal(await cmds(c), undefined, c);
  w.sent.length = 0;
  await input.key('Meta+a', { fast: true, commands: [] });
  assert.equal(w.sent.find((m) => m.params.code === 'KeyA')?.params.commands, undefined, 'a caller that says none gets none');
});

test('⑦ replace: select-all with the platform shortcut (Meta+A with its selectAll command on macOS) before typing; refused if not all selected', async () => {
  const { w, page } = actWire({ nodes: { 7: { box: [100, 100, 200, 30], role: 'textbox', name: 'go' } } });
  const tab = await ready(w);
  const ref = refOf(tab, await tab.snapshot(), 'go');
  await tab.type(ref, 'x', { fast: true, replace: true });
  const a = w.sent.find((m) => m.method === 'Input.dispatchKeyEvent' && m.params.code === 'KeyA');
  assert.deepEqual([a?.params.type, a?.params.modifiers, a?.params.commands, 'text' in (a?.params ?? {})], ['rawKeyDown', 4, ['selectAll'], false]);
  assert.equal(mouse(w, 'mousePressed').length, 1, 'one click, not a triple click');
  page.allSelected = false;
  const keys = w.count('Input.dispatchKeyEvent');
  await rejectsWith(() => tab.type(ref, 'y', { fast: true, replace: true }), 'unsupported');
  assert.equal(w.sent.slice(-20).filter((m) => m.params.code === 'KeyY').length, 0, 'nothing typed');
  assert.ok(w.count('Input.dispatchKeyEvent') > keys);
});

// ---------- more race windows ----------

test('A: the page reacts to the Shift keydown (moves the focus, replaces the document): the character is not sent; Shift is released', async () => {
  for (const [what, code] of /** @type {const} */ ([['focus', 'not_focused'], ['document', 'stale_ref']])) {
    const { w, page } = actWire({ nodes: { 7: { box: [100, 100, 200, 30], role: 'textbox', name: 'go' } } });
    const tab = await ready(w);
    const ref = refOf(tab, await tab.snapshot(), 'go');
    w.on('Input.dispatchKeyEvent', (p) => {
      if (p.type === 'rawKeyDown' && p.key === 'Shift') {
        if (what === 'focus') page.focused = false;
        else w.event('Page.documentOpened', { frame: { id: MAIN, url: 'https://a.test/' } });
      }
      return {};
    });
    await rejectsWith(() => tab.type(ref, 'A', { fast: true }), code);
    const keys = w.sent.filter((m) => m.method === 'Input.dispatchKeyEvent').map((m) => `${m.params.type}:${m.params.key}:${m.params.modifiers}`);
    assert.deepEqual(keys, ['rawKeyDown:Shift:8', 'keyUp:Shift:0'], `${what}: no "A" sent, Shift released`);
  }
});

test('B: a release that fails keeps the key marked down, and no more input goes to the tab until a release succeeds', async () => {
  const w = new Wire();
  let ups = false;
  w.on('Input.dispatchKeyEvent', (p) => {
    if (p.type === 'keyDown' && p.key === 'B') throw new Error('boom');
    if (p.type === 'keyUp' && !ups) throw new Error('still down');
    return {};
  });
  const input = new Input(w.client, 'S', { sleep: async () => {} });
  await assert.rejects(input.locked(() => input.type('B', { fast: true })));
  assert.deepEqual([...input.keys.keys()], ['ShiftLeft', 'KeyB'], 'unconfirmed releases stay marked');
  const before = w.sent.length;
  await assert.rejects(input.locked(() => input.key('Enter', { fast: true })), (e) => e instanceof SdkError && e.code === 'result_unknown');
  assert.equal(w.sent.slice(before).filter((m) => m.params.type !== 'keyUp').length, 0, 'no new input while a key may be down');
  ups = true;
  await input.locked(() => input.key('Enter', { fast: true }));
  assert.equal(input.keys.size, 0);
  assert.ok(w.sent.some((m) => m.params.key === 'Enter' && m.params.type === 'keyDown'), 'input resumes once the release went through');
});

test('C: replace into a field whose selection cannot be checked is refused, not trusted', async () => {
  const { w, page } = actWire({ nodes: { 7: { box: [100, 100, 200, 30], role: 'textbox', name: 'go' } } });
  const tab = await ready(w);
  page.allSelected = /** @type {any} */ (null);
  await rejectsWith(async () => tab.type(refOf(tab, await tab.snapshot(), 'go'), 'new', { fast: true, replace: true }), 'unsupported');
  assert.equal(w.sent.filter((m) => m.params.code === 'KeyN').length, 0, 'nothing typed');
});
