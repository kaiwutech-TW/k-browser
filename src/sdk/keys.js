// @ts-check
// A US keyboard: what Input.dispatchKeyEvent needs for a character or a named key.
//
// Pages see key, code and keyCode (= windowsVirtualKeyCode; the CDP field `keyCode` does not exist), so all three
// must agree the way a real US keyboard makes them agree: "A" is Shift + KeyA with keyCode 65, "!" is Shift + Digit1
// with keyCode 49. nativeVirtualKeyCode is not visible to pages; it carries the same value.
// Characters outside this table (CJK, accents, emoji) are not typed as keys: the caller inserts them with
// Input.insertText and says so.

/** @typedef {{ key: string, code: string, keyCode: number, text?: string, shift?: boolean, location?: number }} KeyDef */

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const SHIFTED_DIGITS = ')!@#$%^&*(';
/** [unshifted, shifted, code, keyCode] for the punctuation keys */
const PUNCT = /** @type {const} */ ([
  ['-', '_', 'Minus', 189], ['=', '+', 'Equal', 187], ['[', '{', 'BracketLeft', 219], [']', '}', 'BracketRight', 221],
  ['\\', '|', 'Backslash', 220], [';', ':', 'Semicolon', 186], ["'", '"', 'Quote', 222], [',', '<', 'Comma', 188],
  ['.', '>', 'Period', 190], ['/', '?', 'Slash', 191], ['`', '~', 'Backquote', 192],
]);

/** @type {Map<string, KeyDef>} printable character -> key */
const CHARS = new Map();
for (const c of LOWER) {
  const code = `Key${c.toUpperCase()}`;
  const keyCode = c.toUpperCase().charCodeAt(0);
  CHARS.set(c, { key: c, code, keyCode, text: c });
  CHARS.set(c.toUpperCase(), { key: c.toUpperCase(), code, keyCode, text: c.toUpperCase(), shift: true });
}
for (let i = 0; i < 10; i++) {
  const code = `Digit${DIGITS[i]}`;
  CHARS.set(DIGITS[i], { key: DIGITS[i], code, keyCode: 48 + i, text: DIGITS[i] });
  CHARS.set(SHIFTED_DIGITS[i], { key: SHIFTED_DIGITS[i], code, keyCode: 48 + i, text: SHIFTED_DIGITS[i], shift: true });
}
for (const [plain, shifted, code, keyCode] of PUNCT) {
  CHARS.set(plain, { key: plain, code, keyCode, text: plain });
  CHARS.set(shifted, { key: shifted, code, keyCode, text: shifted, shift: true });
}
CHARS.set(' ', { key: ' ', code: 'Space', keyCode: 32, text: ' ' });
CHARS.set('\n', { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
CHARS.set('\r', { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
CHARS.set('\t', { key: 'Tab', code: 'Tab', keyCode: 9 });

/** @type {Map<string, KeyDef>} named keys, by their KeyboardEvent.key */
const NAMED = new Map(Object.entries({
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 },
}));
for (let i = 1; i <= 12; i++) NAMED.set(`F${i}`, { key: `F${i}`, code: `F${i}`, keyCode: 111 + i });

/** CDP modifier bits */
export const MODIFIER = /** @type {const} */ ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 });

/** The key that types this character on a US keyboard, or null (insert it as text instead). @param {string} ch */
export function keyForChar(ch) {
  return CHARS.get(ch) ?? null;
}

/** What the same physical key gives with Shift held ("a" -> "A", "1" -> "!"), or the key itself if Shift changes nothing.
 * @param {KeyDef} k */
export function shifted(k) {
  if (k.shift) return k;
  for (const d of CHARS.values()) if (d.shift && d.code === k.code) return d;
  return k;
}

/** A named key ("Enter", "ArrowDown", "Shift") or a single character, or null. @param {string} name */
export function namedKey(name) {
  return NAMED.get(name) ?? CHARS.get(name) ?? null;
}

/**
 * "Shift+Tab", "Control+a", "Enter" -> modifiers and the key. Throws on an unknown key or modifier.
 * @param {string} combo
 * @returns {{ modifiers: (keyof typeof MODIFIER)[], key: KeyDef }}
 */
export function parseCombo(combo) {
  const parts = combo === '+' ? ['+'] : combo.split('+').map((s, i, a) => (s === '' && i === a.length - 1 ? '+' : s)).filter((s) => s !== '');
  const last = parts.pop();
  /** @type {(keyof typeof MODIFIER)[]} */
  const modifiers = [];
  for (const m of parts) {
    if (!(m in MODIFIER)) throw new Error(`unknown modifier "${m}" in "${combo}" (use Shift, Control, Alt, Meta)`);
    modifiers.push(/** @type {keyof typeof MODIFIER} */ (m));
  }
  const key = last === undefined ? null : namedKey(last);
  if (!key) throw new Error(`unknown key "${last}" in "${combo}"`);
  return { modifiers, key };
}

/** macOS shortcuts and the editing commands a real press runs: CDP key events do not run them by themselves.
 * Keyed by the held modifiers in MODIFIER order and the key's code. Copy, cut and paste are left out on purpose: they would
 * read the user's clipboard into the page (where the agent can read it) or overwrite it. */
const MAC_COMMANDS = new Map(Object.entries({
  'Meta+KeyA': 'selectAll', 'Meta+KeyZ': 'undo', 'Meta+Shift+KeyZ': 'redo',
  'Meta+ArrowLeft': 'moveToBeginningOfLine', 'Meta+ArrowRight': 'moveToEndOfLine',
  'Meta+ArrowUp': 'moveToBeginningOfDocument', 'Meta+ArrowDown': 'moveToEndOfDocument',
  'Meta+Shift+ArrowLeft': 'moveToBeginningOfLineAndModifySelection', 'Meta+Shift+ArrowRight': 'moveToEndOfLineAndModifySelection',
  'Meta+Shift+ArrowUp': 'moveToBeginningOfDocumentAndModifySelection', 'Meta+Shift+ArrowDown': 'moveToEndOfDocumentAndModifySelection',
  'Alt+ArrowLeft': 'moveWordLeft', 'Alt+ArrowRight': 'moveWordRight',
  'Alt+Shift+ArrowLeft': 'moveWordLeftAndModifySelection', 'Alt+Shift+ArrowRight': 'moveWordRightAndModifySelection',
  'Alt+Backspace': 'deleteWordBackward', 'Alt+Delete': 'deleteWordForward',
  'Meta+Backspace': 'deleteToBeginningOfLine', 'Meta+Delete': 'deleteToEndOfLine',
}));

/** The editing commands a macOS shortcut runs, or undefined. @param {string[]} modifiers @param {KeyDef} k */
export function macCommands(modifiers, k) {
  const held = Object.keys(MODIFIER).filter((m) => modifiers.includes(m));
  const c = MAC_COMMANDS.get([...held, k.code].join('+'));
  return c ? [c] : undefined;
}

/** CDP params for a key event. `commands` are the editing commands a real key press runs (on macOS a shortcut like
 * Meta+A only selects all through its "selectAll" command).
 * @param {'keyDown' | 'rawKeyDown' | 'keyUp'} type @param {KeyDef} k @param {number} modifiers @param {string[]} [commands] */
export function keyEvent(type, k, modifiers, commands) {
  /** @type {Record<string, any>} */
  const p = { type, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
  if (k.location) p.location = k.location;
  if (type === 'keyDown' && k.text !== undefined) {
    p.text = k.text;
    p.unmodifiedText = k.text;
  }
  if (commands?.length && type !== 'keyUp') p.commands = commands;
  return p;
}
