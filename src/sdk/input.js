// @ts-check
// Human-like input through CDP: every event is a trusted Input.* event
// on the tab's root session, in main-frame viewport coordinates (Chrome routes it to the right frame, OOPIFs too).
//
// The pointer never jumps: it travels from where it was along a cubic Bézier curve to a random point inside the
// target (15% away from its edges), with the number of steps and the time taken growing with the distance, then
// pauses, presses, holds briefly and releases. `fast: true` drops the pauses (tests); the path stays.
//
// One lock per tab: only one action sends input to a tab at a time. Whatever an action pressed and did not release
// (it failed or was cut off half way) is released when it ends; the action itself is never replayed (its effect is
// unknown). A release that fails leaves the button or key marked as possibly down, and no further input is sent to
// the tab until a later release succeeds.
//
// Sends that act on a page take a `guard`: a synchronous check run right before the send (callers pass "is the
// target's frame still the same document"), so input is never sent to what is already known to be stale. Keys also
// take a `check` (callers pass "the field still has the focus"), run before every key down, modifiers included:
// a page can react to the Shift keydown before the character is sent.
//
// An interrupt stops the running action: nothing more is pressed, typed or scrolled by it, even after the cause is gone
// (its releases still go out). A JavaScript dialog (alert, confirm, prompt, beforeunload) interrupts (the tab reports
// dialogOpened / dialogClosed), and so does a caller handing the tab to the user, who also sets `hold`: no new
// action starts while it is set.

import { SdkError } from './cdp.js';
import { keyEvent, keyForChar, macCommands, MODIFIER, parseCombo, shifted } from './keys.js';

/** @typedef {{ x: number, y: number }} Point */
/** @typedef {{ rand?: () => number, sleep?: (ms: number) => Promise<void> }} InputDeps */
/** @typedef {() => void} Guard throws when the send must not happen */
/** @typedef {() => Promise<void>} Check async check before each key (e.g. "the field still has the focus") */

const realSleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const MAX_WHEEL = 100_000; // px per call

export class Input {
  /** @param {import('./cdp.js').CdpClient} client @param {string} sessionId the tab's root session @param {InputDeps} [deps] */
  constructor(client, sessionId, { rand = Math.random, sleep = realSleep } = {}) {
    this.client = client;
    this.sessionId = sessionId;
    this.rand = rand;
    this.sleep = sleep;
    /** where the pointer is; null until the first move (then it starts from a random spot near the target) @type {Point | null} */
    this.pointer = null;
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve();
    /** when the last key or text went in (ms since epoch): the browser's type-to-select remembers keys for 1 s */
    this.lastKeyAt = 0;
    /** input events sent so far (key downs, text insertions, presses, wheel turns), counted from the moment each is
     * sent: an action that stops part-way compares it to tell "nothing went in" from "some of it did" */
    this.sent = 0;
    /** the left button is (or may be) down, since a press was sent @type {{ clickCount: number } | null} */
    this.button = null;
    /** keys that are (or may be) down, by code, in press order @type {Map<string, { def: import('./keys.js').KeyDef, modifiers: number }>} */
    this.keys = new Map();
    /** interrupts so far, the last one's reason, and whether a dialog is open now (fed by the tab) */
    this.interrupts = 0;
    /** @type {{ code: import('./cdp.js').SdkErrorCode, message: string }} */
    this.interruptedBy = { code: 'dialog_open', message: '' };
    this.dialogOpen = false;
    /** this.interrupts when the running action began */
    this.interruptsAtStart = 0;
    /** set: no action starts (e.g. the tab is with the user) @type {{ code: import('./cdp.js').SdkErrorCode, message: string } | null} */
    this.hold = null;
  }

  /** Stop the running action at its next press. @param {import('./cdp.js').SdkErrorCode} code @param {string} message */
  interrupt(code, message) {
    this.interrupts += 1;
    this.interruptedBy = { code, message };
  }

  dialogOpened() {
    this.dialogOpen = true;
    this.interrupt('dialog_open', 'a JavaScript dialog opened during this action: it sends nothing more');
  }

  dialogClosed() {
    this.dialogOpen = false;
  }

  /** Resolves once every action queued so far has ended. */
  idle() {
    return this.queue;
  }

  /** Throws once the running action was interrupted (or must not run at all). */
  #halt() {
    if (this.hold) throw new SdkError(this.hold.code, this.hold.message);
    if (this.dialogOpen) throw new SdkError('dialog_open', 'a JavaScript dialog is open: the page takes no input');
    if (this.interrupts !== this.interruptsAtStart) throw new SdkError(this.interruptedBy.code, this.interruptedBy.message);
  }

  /** Run fn while holding the tab's input lock (actions on one tab never interleave); afterwards release whatever it
   * left pressed. Refused while an earlier action's button or key may still be down.
   * @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  locked(fn) {
    const run = this.queue.then(async () => {
      if (this.#stuck()) {
        await this.releaseAll();
        if (this.#stuck()) {
          throw new SdkError('result_unknown', 'a mouse button or key pressed by an earlier action may still be down and could not be released; '
            + 'no more input is sent to this tab until it is');
        }
      }
      this.interruptsAtStart = this.interrupts;
      try {
        this.#halt(); // held, or a dialog already open
        return await fn();
      } finally {
        await this.releaseAll();
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  #stuck() {
    return this.button !== null || this.keys.size > 0;
  }

  /** Best effort: release the button and every key still marked down, last pressed first. What fails to release
   * stays marked. Never throws. */
  async releaseAll() {
    if (this.button && this.pointer) {
      try {
        await this.#mouse({ type: 'mouseReleased', x: this.pointer.x, y: this.pointer.y, button: 'left', buttons: 0, clickCount: this.button.clickCount });
        this.button = null;
      } catch { /* still possibly down */ }
    }
    for (const [code, { def }] of [...this.keys].reverse()) {
      // modifiers still held while this key goes up: the others still marked down (as on the normal path)
      const held = [...this.keys.values()].reduce((bits, k) => (k.def.code !== code && k.def.key in MODIFIER ? bits | MODIFIER[/** @type {keyof typeof MODIFIER} */ (k.def.key)] : bits), 0);
      try {
        await this.client.call('Input.dispatchKeyEvent', keyEvent('keyUp', def, held), this.sessionId);
        this.keys.delete(code);
      } catch { /* still possibly down */ }
    }
  }

  /** @param {number} lo @param {number} hi */
  between(lo, hi) {
    return lo + (hi - lo) * this.rand();
  }

  /** @param {number} lo @param {number} hi @param {boolean} fast */
  async pause(lo, hi, fast) {
    if (!fast) await this.sleep(Math.round(this.between(lo, hi)));
  }

  /** Count an input event just handed to the client, unless the client was already closed: then it refused to send
   * it, and nothing went in. */
  #counted() {
    if (!this.client.closedWhy) this.sent++;
  }

  /** @param {Record<string, any>} params */
  #mouse(params) {
    return this.client.call('Input.dispatchMouseEvent', params, this.sessionId);
  }

  /** A random point inside a quad (8 numbers, clockwise from top-left), at least 15% away from its edges.
   * @param {number[]} q @returns {Point} */
  pointIn(q) {
    const u = this.between(0.15, 0.85);
    const v = this.between(0.15, 0.85);
    // bilinear: top edge q0->q1, bottom edge q3->q2
    const top = { x: q[0] + (q[2] - q[0]) * u, y: q[1] + (q[3] - q[1]) * u };
    const bottom = { x: q[6] + (q[4] - q[6]) * u, y: q[7] + (q[5] - q[7]) * u };
    return { x: top.x + (bottom.x - top.x) * v, y: top.y + (bottom.y - top.y) * v };
  }

  /**
   * Move the pointer to `to` along a curve. Returns the number of mouseMoved events sent.
   * @param {Point} to @param {{ fast?: boolean, viewport?: { width: number, height: number } }} [o]
   */
  async moveTo(to, { fast = false, viewport } = {}) {
    const from = this.pointer ?? this.#startNear(to, viewport);
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(5, Math.min(40, Math.round(dist / 18)));
    const total = Math.min(380, 90 + dist * 0.5); // ms; with the pauses below an action stays under ~600 ms
    // control points: off the straight line by up to 25% of the distance, on one side
    const nx = dist ? -(to.y - from.y) / dist : 0;
    const ny = dist ? (to.x - from.x) / dist : 0;
    const bend = this.between(-0.25, 0.25) * dist;
    const c1 = { x: from.x + (to.x - from.x) * 0.3 + nx * bend, y: from.y + (to.y - from.y) * 0.3 + ny * bend };
    const c2 = { x: from.x + (to.x - from.x) * 0.7 + nx * bend * 0.6, y: from.y + (to.y - from.y) * 0.7 + ny * bend * 0.6 };
    for (let i = 1; i <= steps; i++) {
      const t = easeInOut(i / steps);
      const p = i === steps ? to : bezier(from, c1, c2, to, t);
      await this.#mouse({ type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 });
      this.pointer = { x: p.x, y: p.y };
      if (!fast) await this.sleep(Math.round(total / steps));
    }
    return steps;
  }

  /** Where a pointer that has not moved yet starts: somewhere in the viewport, 150-400 px from the target.
   * @param {Point} to @param {{ width: number, height: number }} [viewport] */
  #startNear(to, viewport) {
    const a = this.between(0, Math.PI * 2);
    const r = this.between(150, 400);
    const w = viewport?.width ?? 800;
    const h = viewport?.height ?? 600;
    return { x: clamp(to.x + Math.cos(a) * r, 1, w - 1), y: clamp(to.y + Math.sin(a) * r, 1, h - 1) };
  }

  /** Press at the pointer; `guard` runs synchronously right before the send. @param {number} clickCount @param {{ guard?: Guard }} [o] */
  async press(clickCount, { guard } = {}) {
    const p = this.#here();
    this.#halt();
    guard?.();
    const sent = this.#mouse({ type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount });
    this.#counted();
    this.button = { clickCount }; // from the moment it is sent: a press whose answer is lost may have happened
    await sent;
  }

  /** Release at the pointer (always sent once pressed, whatever changed meanwhile). @param {number} clickCount */
  async release(clickCount) {
    const p = this.#here();
    await this.#mouse({ type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount });
    this.button = null;
  }

  #here() {
    if (!this.pointer) throw new Error('the pointer has not moved yet');
    return this.pointer;
  }

  /** Scroll with the wheel at the pointer, in segments of random size and spacing; `guard` runs before each segment.
   * @param {number} dx @param {number} dy @param {{ fast?: boolean, guard?: Guard }} [o] */
  async wheel(dx, dy, { fast = false, guard } = {}) {
    for (const d of [dx, dy]) {
      if (!Number.isFinite(d) || Math.abs(d) > MAX_WHEEL) throw new SdkError('bad_argument', `scroll distances must be finite numbers up to ${MAX_WHEEL} px, not ${d}`);
    }
    const p = this.#here();
    let left = { x: dx, y: dy };
    let segments = 0;
    while (Math.abs(left.x) >= 1 || Math.abs(left.y) >= 1) {
      const step = this.between(80, 140);
      const sx = Math.sign(left.x) * Math.min(Math.abs(left.x), step);
      const sy = Math.sign(left.y) * Math.min(Math.abs(left.y), step);
      this.#halt();
      guard?.();
      const turned = this.#mouse({ type: 'mouseWheel', x: p.x, y: p.y, deltaX: sx, deltaY: sy });
      this.#counted();
      await turned;
      left = { x: left.x - sx, y: left.y - sy };
      segments += 1;
      await this.pause(25, 70, fast);
    }
    return segments;
  }

  /**
   * Type text into whatever has focus: US-keyboard characters as key presses (Shift where a real keyboard needs it),
   * everything else with Input.insertText. `check` runs before each key and each insertion (callers check the focus
   * is still where it should be), `guard` right before each send. Returns how much went in as a non-key insertion.
   * @param {string} text @param {{ fast?: boolean, check?: Check, guard?: Guard }} [o]
   */
  async type(text, { fast = false, check, guard } = {}) {
    let inserted = 0;
    let run = '';
    const flush = async () => {
      if (!run) return;
      await check?.();
      this.#halt();
      guard?.();
      const sent = this.client.call('Input.insertText', { text: run }, this.sessionId);
      this.#counted();
      await sent;
      this.lastKeyAt = Date.now();
      inserted += [...run].length;
      run = '';
    };
    for (const ch of text) {
      const k = keyForChar(ch);
      if (!k) {
        run += ch;
        continue;
      }
      await flush();
      await this.#tap(k, k.shift ? ['Shift'] : [], fast, guard, check);
      await this.pause(35, 110, fast);
    }
    await flush();
    return { keys: [...text].length - inserted, inserted };
  }

  /** Press a key or combination ("Enter", "Shift+Tab", "A" = Shift+KeyA). `commands`: editing commands it runs.
   * @param {string} combo @param {{ fast?: boolean, check?: Check, guard?: Guard, commands?: string[] }} [o] */
  async key(combo, { fast = false, check, guard, commands } = {}) {
    const { modifiers, key } = parseCombo(combo);
    const mods = key.shift && !modifiers.includes('Shift') ? [...modifiers, 'Shift'] : modifiers;
    // K-Browser drives Chrome on this Mac: a shortcut does what pressing it does there
    const run = commands ?? (process.platform === 'darwin' ? macCommands(mods, key) : undefined);
    await this.#tap(key, /** @type {(keyof typeof MODIFIER)[]} */ (mods), fast, guard, check, run);
  }

  /**
   * Modifiers down, the key down and up, modifiers up. Every down is preceded by `check` and `guard` (the page may
   * react to a modifier's keydown); ups are always sent. With Shift held a key gives its shifted character, as on a
   * real keyboard; with Control / Alt / Meta held it types nothing (a shortcut).
   * @param {import('./keys.js').KeyDef} k @param {(keyof typeof MODIFIER)[]} mods @param {boolean} fast @param {Guard} [guard] @param {Check} [check] @param {string[]} [commands]
   */
  async #tap(k, mods, fast, guard, check, commands) {
    let bits = 0;
    for (const m of mods) {
      const def = parseCombo(m).key;
      bits |= MODIFIER[m];
      await check?.();
      this.#halt();
      guard?.();
      await this.#down('rawKeyDown', def, bits, undefined, false);
    }
    const def = bits & MODIFIER.Shift ? shifted(k) : k;
    const types = def.text !== undefined && !(bits & (MODIFIER.Control | MODIFIER.Alt | MODIFIER.Meta));
    await check?.();
    this.#halt();
    guard?.();
    await this.#down(types ? 'keyDown' : 'rawKeyDown', def, bits, commands);
    await this.pause(20, 60, fast);
    await this.#up(def, bits);
    this.lastKeyAt = Date.now();
    for (const m of [...mods].reverse()) {
      bits &= ~MODIFIER[m];
      await this.#up(parseCombo(m).key, bits);
    }
  }

  /** count: false for a modifier held on its own (it types nothing)
   * @param {'keyDown' | 'rawKeyDown'} type @param {import('./keys.js').KeyDef} def @param {number} bits @param {string[]} [commands] @param {boolean} [count] */
  async #down(type, def, bits, commands, count = true) {
    const sent = this.client.call('Input.dispatchKeyEvent', keyEvent(type, def, bits, commands), this.sessionId);
    if (count) this.#counted();
    this.keys.set(def.code, { def, modifiers: bits });
    await sent;
  }

  /** @param {import('./keys.js').KeyDef} def @param {number} bits */
  async #up(def, bits) {
    await this.client.call('Input.dispatchKeyEvent', keyEvent('keyUp', def, bits), this.sessionId);
    this.keys.delete(def.code);
  }
}

/** @param {number} t */
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** @param {Point} p0 @param {Point} p1 @param {Point} p2 @param {Point} p3 @param {number} t @returns {Point} */
function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}
