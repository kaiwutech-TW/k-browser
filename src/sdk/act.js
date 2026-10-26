// @ts-check
// Acting on a ref: locate -> move the pointer -> re-check -> press -> release, for every press.
//
// The re-check runs after the pointer has arrived, not before it set off: a page can swap the target, lay a cover
// over it, or move / turn the frame it is in on the first mousemove. It narrows the race, it cannot close it (the
// page can still change between the check and the press). Before every press:
//   1. the node is still connected (stale_ref), its role and name are what the snapshot showed and an optional
//      context text is still around it (target_changed);
//   2. the OOPIF boundaries on the way are measured again: still only translated, and not moved (geometry);
//   3. a hit test at the press point finds the target or a node inside it (shadow trees and slots included),
//      level by level through OOPIFs; anything else is occluded;
//   4. right before the send, synchronously: the frames' stamps are unchanged (stale_ref). What is already known
//      to be stale is never sent.
// Keys typed into a ref are bound to it the same way: before each key, the ref's frame is unchanged and the
// keyboard focus is still in it (not_focused). A wheel over a ref is checked once before its first segment (the
// node may scroll away from under the pointer after that, as it does for a person), each segment is stamp-guarded.
//
// Coordinates (measured in Chrome for Testing 149):
// - A same-process iframe needs nothing: the root session's quads are main-frame viewport coordinates, and its hit
//   test returns the node inside the iframe.
// - An OOPIF's quads are relative to its own viewport. Adding the content box of its iframe element (in the parent's
//   coordinates) is exact under borders, padding, translation and scrolling, and wrong under scale, rotation and CSS
//   zoom. So those are refused (unsupported_transform), detected from the iframe element and its ancestors' computed
//   style plus the content box against the child's viewport size. An axis-aligned box proves nothing on its own
//   (a 90° or 180° rotation keeps it axis-aligned).
// - The root session's hit test over an OOPIF returns the iframe element: the test continues in the child session.
// - DOM.getNodeForLocation takes document coordinates (viewport + that frame's scroll offset), Input takes viewport
//   coordinates.

import { SdkError } from './cdp.js';
import { Handle } from './world.js';

/** @typedef {import('./snapshot.js').RefEntry} RefEntry */
/** @typedef {import('./frames.js').Stamp} Stamp */
/** @typedef {import('./input.js').Point} Point */
/** A frame owned by another session than its parent's (an OOPIF), with how to get from its coordinates to the parent's.
 * @typedef {{ stamp: Stamp, parent: Stamp, owner: number, origin: Point, width: number, height: number }} Boundary */
/** @typedef {{ quad: number[], local: Point, main: Point, boundaries: Boundary[], viewport: { width: number, height: number } }} Located */
/** @typedef {{ context?: string, fast?: boolean }} ActOptions */
/** @typedef {import('./index.js').Tab} Tab */

const PICK_TRIES = 8;
const STILL_MS = 40; // a little over two frames at 60 Hz
const STILL_TRIES = 12; // about half a second at most
const MOVED_PX = 0.5; // an OOPIF boundary that moved more than this after the pointer arrived: not pressed

/** @param {any} n */
const axRole = (n) => String(n?.role?.value ?? '');
/** @param {any} n */
const axName = (n) => String(n?.name?.value ?? '');

// --- functions run in the isolated world (named, so tests can tell them apart) ---

/** @this {Node} */
function kbConnected() {
  return this.isConnected;
}

/**
 * Is `this` (the hit node) the target or inside it in the composed tree? Up through slots (a slotted node's parent
 * there is its slot), shadow roots (to their hosts) and parents. A slot in a closed shadow tree hides itself from
 * `assignedSlot`, so the target's own slots are also asked what they hold.
 * @this {Node} @param {Node} target
 */
function kbWithin(target) {
  /** @type {any} */ let n = this;
  while (n) {
    if (n === target) return true;
    n = n.assignedSlot || n.parentNode || (n.nodeType === 11 ? n.host : null);
  }
  /** @type {any} */ const t = target;
  const slots = t.nodeType === 1 ? [...(t.localName === 'slot' ? [t] : []), ...t.querySelectorAll('slot')] : [];
  for (const s of slots) {
    for (const a of s.assignedNodes({ flatten: true })) if (a === this || a.contains(this)) return true;
  }
  return false;
}

/** Text near the node: its row / list item / option, else its parent. @this {Element} @param {string} text */
function kbContextHas(text) {
  const el = this.nodeType === 1 ? this : this.parentElement;
  const scope = el && (el.closest('tr, [role="row"], li, [role="listitem"], [role="option"], [role="treeitem"], [role="article"]') || el.parentElement || el);
  const norm = (/** @type {string} */ s) => s.replace(/\s+/g, ' ').trim();
  return !!scope && norm(scope.textContent || '').includes(norm(text));
}

/** Why the iframe element (this) is not just translated: transforms, scale, rotate or zoom on it or an ancestor. @this {Element} */
function kbTransformProblems() {
  const pure2d = /^matrix\(1, 0, 0, 1, [-\d.e]+, [-\d.e]+\)$/;
  const pure3d = /^matrix3d\(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, [-\d.e]+, [-\d.e]+, [-\d.e]+, 1\)$/;
  const out = [];
  /** @type {any} */ let el = this;
  while (el) {
    const cs = getComputedStyle(el);
    const label = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '');
    if (cs.transform && cs.transform !== 'none' && !pure2d.test(cs.transform) && !pure3d.test(cs.transform)) out.push(`${label} transform: ${cs.transform}`);
    if (cs.scale && cs.scale !== 'none') out.push(`${label} scale: ${cs.scale}`);
    if (cs.rotate && cs.rotate !== 'none') out.push(`${label} rotate: ${cs.rotate}`);
    if (cs.zoom && cs.zoom !== '1' && cs.zoom !== 'normal') out.push(`${label} zoom: ${cs.zoom}`);
    const p = el.assignedSlot || el.parentNode;
    el = p && p.nodeType === 11 ? p.host : p && p.nodeType === 1 ? p : null;
  }
  return out;
}

function kbViewport() {
  return [innerWidth, innerHeight];
}

/** Has the node (or something inside it, shadow trees included, closed ones too) got the keyboard focus? @this {Element} */
function kbFocused() {
  if (!document.hasFocus()) return false;
  if (this.matches(':focus, :focus-within')) return true;
  /** @type {any} */ let a = this.ownerDocument.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  for (/** @type {any} */ let n = a; n; n = n.assignedSlot || n.parentNode || (n.nodeType === 11 ? n.host : null)) if (n === this) return true;
  return false;
}

/** @this {any} */
function kbSelectState() {
  if (this.tagName !== 'SELECT') return null;
  return { multiple: this.multiple, selectedIndex: this.selectedIndex, value: this.value,
    options: [...this.options].map((/** @type {any} */ o) => ({ value: o.value, label: o.label, disabled: o.disabled })) };
}

/**
 * Is all of the field's content selected? Text inputs and textareas by their selection offsets. A contenteditable:
 * both ends of the selection inside the field, and what is left outside it is provably nothing:
 *   - text: only collapsible white space (space, tab, newline) under `white-space: normal` or `nowrap`. Anything
 *     else counts, &nbsp;, pre-wrap white space and zero-width characters (soft hyphen, word joiner) included;
 *   - elements: empty ones that show nothing, and at most one <br>, as the field's last leaf (the placeholder that
 *     Chrome's own select-all leaves out). A second <br> is a blank line; an image or a control is content.
 * Rendering is not used to decide: zero width does not mean no content (a blank line's box is 0 wide, 22 px high),
 * and Chrome's innerText and Selection.toString() disagree on blank lines. null when it cannot tell.
 * @this {any}
 */
function kbAllSelected() {
  if (typeof this.value === 'string' && typeof this.selectionStart === 'number') {
    return this.value.length === 0 || (this.selectionStart === 0 && this.selectionEnd === this.value.length);
  }
  if (!this.isContentEditable) return null;
  const root = this.getRootNode();
  const sel = root !== document && root.getSelection ? root.getSelection() : document.getSelection();
  if (!sel || sel.rangeCount !== 1) return false;
  const r = sel.getRangeAt(0);
  const inside = (/** @type {Node} */ n) => n === this || this.contains(n);
  if (!inside(r.startContainer) || !inside(r.endContainer)) return false; // reaches beyond the field
  /** @type {Node[]} */ const leaves = [];
  const walk = (/** @type {Node} */ n) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) leaves.push(c);
      else if (c.nodeType === 1) { if (c.childNodes.length) walk(c); else leaves.push(c); }
    }
  };
  walk(this);
  const REPLACED = /^(img|svg|video|audio|canvas|iframe|object|embed|input|textarea|select|button|hr|math|picture)$/;
  const index = (/** @type {Node} */ n) => Array.prototype.indexOf.call(n.parentNode?.childNodes ?? [], n);
  let outsideBreaks = 0;
  for (let i = 0; i < leaves.length; i++) {
    const n = leaves[i];
    if (n.nodeType === 3) {
      const t = /** @type {Text} */ (n);
      let rest = t.data;
      if (r.intersectsNode(t)) {
        const a = r.startContainer === t ? r.startOffset : 0;
        const b = r.endContainer === t ? r.endOffset : t.data.length;
        rest = t.data.slice(0, a) + t.data.slice(b);
      }
      if (!rest) continue;
      const ws = t.parentElement ? getComputedStyle(t.parentElement).whiteSpace : 'normal';
      if (!/^[ \t\n\r\f]*$/.test(rest) || !/^(normal|nowrap)$/.test(ws)) return false;
    } else {
      const p = /** @type {Node} */ (n.parentNode);
      const covered = r.comparePoint(p, index(n)) === 0 && r.comparePoint(p, index(n) + 1) === 0;
      if (covered) continue;
      const name = /** @type {Element} */ (n).localName;
      if (REPLACED.test(name)) return false;
      if (name === 'br') {
        outsideBreaks += 1;
        if (outsideBreaks > 1 || i !== leaves.length - 1) return false;
      }
    }
  }
  return true;
}

/** @this {any} A field that takes no typing: an <input> / <textarea> readonly or disabled, or an element made
 * contenteditable="false". Keys would go nowhere. */
function kbReadOnly() {
  if (this.localName === 'input' || this.localName === 'textarea') return this.readOnly === true || this.disabled === true;
  return this.hasAttribute('contenteditable') && !this.isContentEditable;
}

function kbIsMac() {
  // @ts-ignore userAgentData is not in every lib
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  return /mac/i.test(p);
}

// click, dblclick, key and scroll go through it too: a first press that rebuilt the button, a wheel
// segment that navigated, a keydown that took effect before the connection dropped all went in.
// Stops K-Browser makes itself: their code already tells the caller not to go on (the tab is with the user, a dialog
// is open), so it is kept and only the count of what went in is added.
const STOPS = new Set(['handed_off', 'dialog_open']);

/**
 * Run the part of an action that sends input. If it stops after some input already went in (the field or the
 * <select> was replaced by the page, the focus moved), what went in may have taken effect: that is result_unknown,
 * never a plain "not done" an agent would repeat.
 * @template T @param {Tab} tab @param {() => Promise<T>} fn @returns {Promise<T>}
 */
async function sending(tab, fn) {
  const before = tab.input.sent;
  try {
    return await fn();
  } catch (e) {
    const n = tab.input.sent - before;
    if (n === 0 || !(e instanceof SdkError) || e.code === 'result_unknown') throw e;
    const gone = `${n} input event(s) had already gone in, so it may have taken effect: read the page before doing it again`;
    if (STOPS.has(e.code)) {
      e.message += ` (${gone})`;
      throw e;
    }
    throw new SdkError('result_unknown', `${e.message} — but ${gone}`);
  }
}

// --- locating ---

/** @param {Tab} tab @param {string} frameId */
function stampOrGone(tab, frameId) {
  const s = tab.tree.stamp(frameId);
  if (!s) throw new SdkError('stale_ref', `frame ${frameId} is gone or changing process; take a new snapshot`);
  return s;
}

/** The OOPIF boundaries between a frame and the main frame, innermost first, with their offsets and checks.
 * @param {Tab} tab @param {string} frameId @returns {Promise<Boundary[]>} */
async function boundariesOf(tab, frameId) {
  /** @type {Boundary[]} */
  const out = [];
  for (let f = tab.tree.frames.get(frameId); f?.parentId;) {
    const parent = tab.tree.frames.get(f.parentId);
    if (!parent) throw new SdkError('stale_ref', `frame ${f.id} lost its parent; take a new snapshot`);
    if (f.sessionId !== parent.sessionId) out.push(await boundary(tab, stampOrGone(tab, f.id), stampOrGone(tab, parent.id)));
    f = parent;
  }
  return out;
}

/** @param {Tab} tab @param {Stamp} stamp @param {Stamp} parent @returns {Promise<Boundary>} */
async function boundary(tab, stamp, parent) {
  const { client, worlds } = tab;
  const owner = await client.call('DOM.getFrameOwner', { frameId: stamp.frameId }, parent.sessionId)
    .catch((e) => { throw new SdkError('stale_ref', `the iframe element of frame ${stamp.frameId} is gone (${e.message}); take a new snapshot`); });
  const box = await client.call('DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, parent.sessionId)
    .catch((e) => { throw new SdkError('not_visible', `the iframe element of frame ${stamp.frameId} has no box (${e.message})`); });
  const c = /** @type {number[]} */ (box.model.content);
  const objectId = await worlds.resolve(parent, owner.backendNodeId);
  let problems;
  try {
    problems = /** @type {string[]} */ (await worlds.callOn(parent, objectId, kbTransformProblems));
  } finally {
    await worlds.release(parent, objectId);
  }
  const [width, height] = /** @type {number[]} */ (await worlds.run(stamp.frameId, kbViewport));
  const axisAligned = Math.abs(c[1] - c[3]) < 0.5 && Math.abs(c[2] - c[4]) < 0.5 && Math.abs(c[5] - c[7]) < 0.5 && Math.abs(c[6] - c[0]) < 0.5
    && c[2] > c[0] && c[7] > c[1];
  if (!axisAligned) problems.push(`its box is not an upright rectangle (${c.map(Math.round).join(',')})`);
  else if (Math.abs(c[2] - c[0] - width) > 1 || Math.abs(c[7] - c[1] - height) > 1) {
    problems.push(`its box is ${Math.round(c[2] - c[0])}x${Math.round(c[7] - c[1])} but its page is ${width}x${height} (scaled)`);
  }
  if (problems.length) {
    throw new SdkError('unsupported_transform', `the target is in a cross-site frame shown scaled, rotated or zoomed (${problems.join('; ')}); `
      + 'K-Browser does not guess click points there');
  }
  return { stamp, parent, owner: owner.backendNodeId, origin: { x: c[0], y: c[1] }, width, height };
}

/** @param {Tab} tab @param {RefEntry} e @returns {Promise<number[]>} the biggest content quad, in its session's viewport */
async function quadOf(tab, e) {
  let r;
  try {
    r = await tab.client.call('DOM.getContentQuads', { backendNodeId: e.backendNodeId }, e.stamp.sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // a node taken out of the document has no box either: say it is gone, not hidden
    if (/compute/i.test(msg) && await connected(tab, e)) throw new SdkError('not_visible', `${describe(e)} has no visible box (${msg})`);
    throw new SdkError('stale_ref', `${describe(e)} is gone (${msg}); take a new snapshot`);
  }
  const quads = /** @type {number[][]} */ (r.quads ?? []).filter((q) => area(q) >= 1);
  if (!quads.length) throw new SdkError('not_visible', `${describe(e)} has no visible box`);
  return quads.reduce((a, b) => (area(b) > area(a) ? b : a));
}

/** Is the node still in its document? false when it cannot be told (gone with its frame). @param {Tab} tab @param {RefEntry} e */
async function connected(tab, e) {
  try {
    const obj = await tab.worlds.resolve(e.stamp, e.backendNodeId);
    try {
      return await tab.worlds.callOn(e.stamp, obj, kbConnected) === true;
    } finally {
      await tab.worlds.release(e.stamp, obj);
    }
  } catch {
    return false;
  }
}

/** @param {Tab} tab */
async function mainViewport(tab) {
  const m = await tab.client.call('Page.getLayoutMetrics', {}, tab.sessionId);
  return { width: m.cssLayoutViewport.clientWidth, height: m.cssLayoutViewport.clientHeight };
}

/** A local point -> main-frame viewport, or null if some frame on the way does not show it.
 * @param {Point} local @param {Boundary[]} boundaries @param {{ width: number, height: number }} viewport */
function toMain(local, boundaries, viewport) {
  let p = local;
  for (const b of boundaries) {
    if (p.x < 0 || p.y < 0 || p.x >= b.width || p.y >= b.height) return null;
    p = { x: p.x + b.origin.x, y: p.y + b.origin.y };
  }
  if (p.x < 0 || p.y < 0 || p.x >= viewport.width || p.y >= viewport.height) return null;
  return p;
}

/** @param {Tab} tab @param {RefEntry} e @returns {Promise<Located | null>} */
async function measure(tab, e) {
  const boundaries = await boundariesOf(tab, e.stamp.frameId);
  const quad = await quadOf(tab, e);
  const viewport = await mainViewport(tab);
  for (let i = 0; i < PICK_TRIES; i++) {
    const local = tab.input.pointIn(quad);
    const main = toMain(local, boundaries, viewport);
    if (main) return { quad, local, main, boundaries, viewport };
  }
  return null;
}

/** Wait briefly while the node's box is still moving (a page scrolling smoothly after typing, an animation), so the point
 * is picked where it will be, not where it was. One that keeps moving is measured anyway: the hit test
 * before the press still refuses a point that something else now covers. @param {Tab} tab @param {RefEntry} e */
async function still(tab, e) {
  let q = await quadOf(tab, e);
  for (let i = 0; i < STILL_TRIES; i++) {
    await tab.input.sleep(STILL_MS);
    const n = await quadOf(tab, e);
    if (n.every((v, k) => Math.abs(v - q[k]) < 1)) return;
    q = n;
  }
}

/** Where to press: a random point inside the node that every frame on the way shows (scrolled into view if needed).
 * @param {Tab} tab @param {RefEntry} e @returns {Promise<Located>} */
export async function locate(tab, e) {
  await still(tab, e);
  const first = await measure(tab, e);
  if (first) return first;
  await tab.client.call('DOM.scrollIntoViewIfNeeded', { backendNodeId: e.backendNodeId }, e.stamp.sessionId)
    .catch((err) => { throw new SdkError('not_visible', `${describe(e)} could not be scrolled into view (${err.message})`); });
  const again = await measure(tab, e);
  if (!again) throw new SdkError('not_visible', `${describe(e)} is outside the visible part of the page even after scrolling it into view`);
  return again;
}

// --- the checks ---

/** @param {RefEntry} e */
function describe(e) {
  return `${e.role} ${JSON.stringify(e.name)}`;
}

/** A synchronous check for right before a send: the ref and every frame on the way are still the same documents.
 * @param {Tab} tab @param {string} ref @param {Boundary[]} [boundaries] @returns {import('./input.js').Guard} */
function guardFor(tab, ref, boundaries = []) {
  return () => {
    tab.entry(ref);
    for (const b of boundaries) {
      if (!tab.tree.same(b.stamp) || !tab.tree.same(b.parent)) throw new SdkError('stale_ref', `ref ${ref}: a frame on the way to it has changed; not sent; take a new snapshot`);
    }
  };
}

/** What is at a point of a session's viewport: { backendNodeId, frameId } or null.
 * @param {Tab} tab @param {string} sessionId @param {Point} p */
async function hitAt(tab, sessionId, p) {
  const m = await tab.client.call('Page.getLayoutMetrics', {}, sessionId);
  const v = m.cssLayoutViewport;
  try {
    return await tab.client.call('DOM.getNodeForLocation', { x: Math.round(p.x + v.pageX), y: Math.round(p.y + v.pageY) }, sessionId);
  } catch (err) {
    if (err instanceof SdkError && err.code === 'cdp_error') return null; // "No node found at given location"
    throw err;
  }
}

/** What was hit, for the error message: its role and name; when it has no name (a backdrop, an overlay), also its tag,
 * id and class, and a hint, so the caller can tell a leftover menu backdrop from the page really covering the target.
 * @param {Tab} tab @param {string} sessionId @param {any} hit */
async function whatIs(tab, sessionId, hit) {
  if (!hit) return 'nothing (outside the page)';
  /** @type {{ role: string, name: string } | null} */ let ax = null;
  try {
    const r = await tab.client.call('Accessibility.getPartialAXTree', { backendNodeId: hit.backendNodeId, fetchRelatives: false }, sessionId);
    const n = (r.nodes ?? []).find((/** @type {any} */ x) => x.backendDOMNodeId === hit.backendNodeId) ?? r.nodes?.[0];
    if (n && axRole(n)) ax = { role: axRole(n), name: axName(n) };
  } catch { /* fall through */ }
  if (ax?.name) return `${ax.role} ${JSON.stringify(ax.name.slice(0, 80))}`;
  let tag = '';
  try {
    const d = await tab.client.call('DOM.describeNode', { backendNodeId: hit.backendNodeId }, sessionId);
    /** @type {string[]} */ const at = d.node?.attributes ?? [];
    const attr = (/** @type {string} */ k) => { const i = at.indexOf(k); return i >= 0 && i % 2 === 0 ? String(at[i + 1] ?? '').replace(/["<>]/g, '').slice(0, 60) : ''; };
    if (d.node?.localName) tag = `<${d.node.localName}${attr('id') ? ` id="${attr('id')}"` : ''}${attr('class') ? ` class="${attr('class')}"` : ''}>`;
  } catch { /* fall through */ }
  const what = [ax ? `${ax.role} ""` : '', tag].filter(Boolean).join(' ') || 'another element';
  return `${what} (it has no name: maybe the backdrop of a menu or dialog that is still open; press Escape, or take a new snapshot to see what is on top)`;
}

/**
 * Everything that must still hold right before a press (steps 1-3 at the top of this file). Throws; returns nothing.
 * The caller sends with guardFor() for step 4.
 * @param {Tab} tab @param {string} ref @param {Located} loc @param {ActOptions} o
 */
export async function verify(tab, ref, loc, o) {
  const { client, worlds } = tab;
  const e = tab.entry(ref);
  guardFor(tab, ref, loc.boundaries)();

  // 2. the frames on the way: measured again now that the pointer is there
  const now = await boundariesOf(tab, e.stamp.frameId);
  for (let i = 0; i < loc.boundaries.length; i++) {
    const was = loc.boundaries[i];
    const is = now[i];
    if (!is || is.stamp.frameId !== was.stamp.frameId || is.owner !== was.owner
      || Math.abs(is.origin.x - was.origin.x) > MOVED_PX || Math.abs(is.origin.y - was.origin.y) > MOVED_PX) {
      throw new SdkError('target_changed', `ref ${ref}: the frame it is in moved after the pointer arrived; not pressed`);
    }
  }
  if (now.length !== loc.boundaries.length) throw new SdkError('stale_ref', `ref ${ref}: the frames on the way to it changed; take a new snapshot`);

  const target = await worlds.resolve(e.stamp, e.backendNodeId);
  /** @type {string | null} */ let hitObject = null;
  try {
    // 1. the node itself
    if (await worlds.callOn(e.stamp, target, kbConnected) !== true) {
      throw new SdkError('stale_ref', `ref ${ref}: the node is no longer in the document; take a new snapshot`);
    }
    const ax = await client.call('Accessibility.getPartialAXTree', { backendNodeId: e.backendNodeId, fetchRelatives: false }, e.stamp.sessionId);
    if (!tab.tree.same(e.stamp)) throw new SdkError('stale_ref', `ref ${ref}: the frame changed during the check; take a new snapshot`);
    const n = (ax.nodes ?? []).find((/** @type {any} */ x) => x.backendDOMNodeId === e.backendNodeId);
    if (!n || axRole(n) !== e.role || axName(n) !== e.name) {
      throw new SdkError('target_changed', `ref ${ref} was ${describe(e)} and is now ${n ? `${axRole(n)} ${JSON.stringify(axName(n))}` : 'not in the accessibility tree'}; not pressed`);
    }
    if (o.context !== undefined && await worlds.callOn(e.stamp, target, kbContextHas, [o.context]) !== true) {
      throw new SdkError('target_changed', `ref ${ref}: ${JSON.stringify(o.context)} is no longer next to ${describe(e)}; not pressed`);
    }

    // 3. hit test, from the main frame down through each OOPIF to the target's frame
    let p = loc.main;
    let sid = tab.sessionId;
    for (const b of [...now].reverse()) {
      const hit = await hitAt(tab, sid, p);
      if (!hit || hit.backendNodeId !== b.owner || hit.frameId !== b.parent.frameId) {
        throw new SdkError('occluded', `${describe(e)} is covered by ${await whatIs(tab, sid, hit)} at (${Math.round(loc.main.x)}, ${Math.round(loc.main.y)}); not pressed`);
      }
      p = { x: p.x - b.origin.x, y: p.y - b.origin.y };
      sid = b.stamp.sessionId;
    }
    const hit = await hitAt(tab, sid, p);
    let inside = !!hit && hit.frameId === e.stamp.frameId && hit.backendNodeId === e.backendNodeId;
    if (!inside && hit && hit.frameId === e.stamp.frameId) {
      hitObject = await worlds.resolve(e.stamp, hit.backendNodeId);
      inside = await worlds.callOn(e.stamp, hitObject, kbWithin, [new Handle(target)]) === true;
    }
    if (!inside) {
      throw new SdkError('occluded', `${describe(e)} is covered by ${await whatIs(tab, sid, hit)} at (${Math.round(loc.main.x)}, ${Math.round(loc.main.y)}); not pressed`);
    }
  } finally {
    await worlds.release(e.stamp, target);
    if (hitObject) await worlds.release(e.stamp, hitObject);
  }
}

/** Throws not_focused unless the ref's node (or something in it) has the keyboard focus. @param {Tab} tab @param {string} ref */
async function assertFocused(tab, ref) {
  const e = tab.entry(ref);
  if (await tab.onNode(ref, kbFocused) !== true) throw new SdkError('not_focused', `${describe(e)} does not have the keyboard focus; nothing more typed`);
}

// focused and still editable, in one call per key (a second round trip per key would slow typing down)
const kbFocusedEditable = `function () { if ((${kbFocused}).call(this) !== true) return false; return (${kbReadOnly}).call(this) ? 'read-only' : true; }`;

/** Before each key of `type`: the field still has the focus, and still takes typing. @param {Tab} tab @param {string} ref */
async function assertTypable(tab, ref) {
  const e = tab.entry(ref);
  const r = await tab.onNode(ref, kbFocusedEditable);
  if (r === 'read-only') throw new SdkError('unsupported', `${describe(e)} became read-only while typing; nothing more typed`);
  if (r !== true) throw new SdkError('not_focused', `${describe(e)} does not have the keyboard focus; nothing more typed`);
}

// --- actions (each holds the tab's input lock for its whole run; whatever it left pressed is released) ---

/** locate -> move -> (check -> press -> release) x clicks. Caller holds the lock.
 * @param {Tab} tab @param {string} ref @param {ActOptions} o @param {number} clicks */
async function pointAndPress(tab, ref, o, clicks) {
  if (!Number.isInteger(clicks) || clicks < 1 || clicks > 3) throw new SdkError('bad_argument', `clickCount must be 1, 2 or 3, not ${clicks}`);
  const fast = !!o.fast;
  const e = tab.entry(ref);
  const loc = await locate(tab, e);
  const moves = await tab.input.moveTo(loc.main, { fast, viewport: loc.viewport });
  await tab.input.pause(40, 120, fast);
  const guard = guardFor(tab, ref, loc.boundaries);
  for (let i = 1; i <= clicks; i++) {
    try {
      await verify(tab, ref, loc, o);
    } catch (err) {
      if (i > 1 && err instanceof SdkError) err.message += ` (after ${i - 1} of ${clicks} presses)`;
      throw err;
    }
    await tab.input.press(i, { guard });
    await tab.input.pause(40, 90, fast);
    await tab.input.release(i);
    if (i < clicks) await tab.input.pause(60, 110, fast);
  }
  return { ref, role: e.role, name: e.name, frameId: e.stamp.frameId, point: { x: Math.round(loc.main.x), y: Math.round(loc.main.y) },
    moves, crossFrames: loc.boundaries.length };
}

/** @param {Tab} tab @param {string} ref @param {ActOptions & { clickCount?: number }} [o] */
export function click(tab, ref, o = {}) {
  return tab.input.locked(async () => ({ action: 'click', ...await sending(tab, () => pointAndPress(tab, ref, o, o.clickCount ?? 1)) }));
}

/** Two press/release pairs (clickCount 1 then 2), each checked before it is pressed.
 * @param {Tab} tab @param {string} ref @param {ActOptions} [o] */
export function dblclick(tab, ref, o = {}) {
  return tab.input.locked(async () => ({ action: 'dblclick', ...await sending(tab, () => pointAndPress(tab, ref, o, 2)) }));
}

/**
 * Click the field, then type; before every key the field must still have the keyboard focus. `replace: true`
 * selects all of the field's text first with the platform's select-all shortcut (Meta+A on macOS, Control+A
 * elsewhere), so the typing replaces it.
 * @param {Tab} tab @param {string} ref @param {string} text @param {ActOptions & { replace?: boolean }} [o]
 */
export function type(tab, ref, text, o = {}) {
  return tab.input.locked(async () => {
    const fast = !!o.fast;
    if (await tab.onNode(ref, kbReadOnly) === true) {
      throw new SdkError('unsupported', `${describe(tab.entry(ref))} is read-only (readonly or disabled): nothing typed; if a date picker or a button sets it, use that`);
    }
    const r = await pointAndPress(tab, ref, o, 1);
    // before every key: still focused, and still editable (a page may lock the field after the first character;
    // the rest would go nowhere while the next step, a submit, goes on)
    const check = () => assertTypable(tab, ref);
    const guard = guardFor(tab, ref);
    if (o.replace) {
      const mac = await tab.onNode(ref, kbIsMac) === true;
      await tab.input.key(mac ? 'Meta+a' : 'Control+a', { fast, check, guard, commands: ['selectAll'] });
      const all = await tab.onNode(ref, kbAllSelected);
      if (all !== true) {
        throw new SdkError('unsupported', `${describe(tab.entry(ref))}: ${all === false ? 'select-all did not select the whole field' : 'cannot tell whether select-all selected the whole field'}; nothing typed`);
      }
    }
    const typed = await sending(tab, () => tab.input.type(text, { fast, check, guard }));
    return { action: 'type', ...r, ...typed,
      ...(typed.inserted ? { note: `${typed.inserted} character(s) were inserted as text (Input.insertText), not typed as keys` } : {}) };
  });
}

/** Press a key or combination on whatever has focus ("Enter", "Shift+Tab"). Not bound to a ref.
 * @param {Tab} tab @param {string} combo @param {{ fast?: boolean }} [o] */
export function key(tab, combo, o = {}) {
  return tab.input.locked(async () => {
    try {
      await sending(tab, () => tab.input.key(combo, o));
    } catch (e) {
      if (e instanceof SdkError) throw e;
      throw new SdkError('bad_argument', e instanceof Error ? e.message : String(e));
    }
    return { action: 'key', key: combo };
  });
}

const TYPE_AHEAD_MS = 1000; // Chrome forgets type-to-select keys after 1 s (TypeAhead kTypeAheadTimeout)

/**
 * Choose an option of a native <select> with the keyboard, never by setting its value from script. The select is
 * checked like a click target first (role, name, context, nothing covering it), focused, and every key goes in only
 * while it still has the focus:
 *   1. type the option's label (the browser's type-to-select; it first waits out keys typed in the last second,
 *      which the browser would otherwise prepend);
 *   2. else type its first character again and again (type-to-select cycles through options starting with it);
 *   3. else arrow keys, except on macOS, where an arrow key opens the native menu instead of moving the selection.
 * Whatever cannot be reached this way is `unsupported` (e.g. a label that is not on a US keyboard, on macOS).
 * A custom drop-down is not a <select>: click it and its options instead.
 * @param {Tab} tab @param {string} ref @param {{ value?: string, label?: string }} want @param {ActOptions} [o]
 */
export function select(tab, ref, want, o = {}) {
  return tab.input.locked(async () => {
    const fast = !!o.fast;
    const e = tab.entry(ref);
    const state = await tab.onNode(ref, kbSelectState);
    if (!state) throw new SdkError('bad_argument', `${describe(e)} is not a native <select>; click it and then its option instead`);
    if (state.multiple) throw new SdkError('bad_argument', `${describe(e)} is a multiple-choice list; click its options instead`);
    const index = state.options.findIndex((/** @type {any} */ x) => (want.value !== undefined ? x.value === want.value : x.label === want.label));
    if (index < 0) throw new SdkError('bad_argument', `${describe(e)} has no option with ${want.value !== undefined ? `value ${JSON.stringify(want.value)}` : `label ${JSON.stringify(want.label)}`}`);
    if (state.options[index].disabled) throw new SdkError('bad_argument', `option ${JSON.stringify(state.options[index].label)} is disabled`);
    const label = String(state.options[index].label);
    const report = { action: 'select', ref, role: e.role, name: e.name, value: state.options[index].value, label };
    if (state.selectedIndex === index) return { ...report, changed: false };

    const loc = await locate(tab, e);
    await verify(tab, ref, loc, o);
    const guard = guardFor(tab, ref, loc.boundaries);
    guard();
    await tab.client.call('DOM.focus', { backendNodeId: e.backendNodeId }, e.stamp.sessionId);
    const check = () => assertFocused(tab, ref);
    await check();
    const now = async () => /** @type {any} */ (await tab.onNode(ref, kbSelectState))?.selectedIndex;
    const quiet = async () => {
      const wait = TYPE_AHEAD_MS + 100 - (Date.now() - tab.input.lastKeyAt);
      if (wait > 0) await tab.input.sleep(wait);
    };
    const typeable = (/** @type {string} */ s) => s.length > 0 && [...s].every((ch) => /[ -~]/.test(ch));

    return sending(tab, async () => {
      if (typeable(label)) {
        await quiet();
        await tab.input.type(label, { fast, check, guard });
        if (await now() === index) return { ...report, changed: true, how: 'typed the label' };
        const first = label[0];
        await quiet();
        for (let i = 0; i < state.options.length; i++) {
          await tab.input.type(first, { fast, check, guard });
          if (await now() === index) return { ...report, changed: true, how: `typed ${JSON.stringify(first)} ${i + 1} time(s)` };
        }
      }
      if (await tab.onNode(ref, kbIsMac) === true) {
        throw new SdkError('unsupported', `cannot choose ${JSON.stringify(label)} in ${describe(e)} with trusted keys on macOS (its arrow keys open the native menu); `
          + 'nothing was set from script; ask the user to choose it');
      }
      let at = await now();
      for (let guardCount = 0; at !== index && guardCount < state.options.length; guardCount++) {
        await tab.input.key(at < index ? 'ArrowDown' : 'ArrowUp', { fast, check, guard });
        const next = await now();
        if (next === at) break; // the key did not move the selection
        at = next;
      }
      if (at !== index) {
        throw new SdkError('unsupported', `could not choose ${JSON.stringify(label)} in ${describe(e)} with the keyboard (it is on option ${at}); nothing was set from script`);
      }
      return { ...report, changed: true, how: 'arrow keys' };
    });
  });
}

/**
 * Scroll with the mouse wheel: over a ref's node, or wherever the pointer is (the middle of the page if it has not
 * moved yet). With a ref, the node is checked like a click target once the pointer is there; the gesture then runs
 * at that fixed pointer position, guarded only against the frame changing: it does not promise that the same node or
 * scroll container stays under the pointer (the node scrolling away is normal, and so is anything the page puts there).
 * @param {Tab} tab @param {{ ref?: string, dx?: number, dy?: number }} what @param {ActOptions} [o]
 */
export function scroll(tab, { ref, dx = 0, dy = 0 }, o = {}) {
  return tab.input.locked(async () => {
    const fast = !!o.fast;
    for (const d of [dx, dy]) if (!Number.isFinite(d)) throw new SdkError('bad_argument', `scroll distances must be finite numbers, not ${d}`);
    /** @type {import('./input.js').Guard | undefined} */ let guard;
    if (ref) {
      const loc = await locate(tab, tab.entry(ref));
      await tab.input.moveTo(loc.main, { fast, viewport: loc.viewport });
      await verify(tab, ref, loc, o);
      guard = guardFor(tab, ref, loc.boundaries);
    } else if (!tab.input.pointer) {
      const v = await mainViewport(tab);
      await tab.input.moveTo({ x: v.width * tab.input.between(0.4, 0.6), y: v.height * tab.input.between(0.4, 0.6) }, { fast, viewport: v });
    }
    const segments = await sending(tab, () => tab.input.wheel(dx, dy, { fast, guard }));
    return { action: 'scroll', ...(ref ? { ref } : {}), dx, dy, segments };
  });
}

/** @param {number[]} q */
function area(q) {
  // shoelace
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    s += q[i * 2] * q[j * 2 + 1] - q[j * 2] * q[i * 2 + 1];
  }
  return Math.abs(s) / 2;
}
