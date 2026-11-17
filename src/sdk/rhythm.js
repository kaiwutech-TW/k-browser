// @ts-check
// The rhythm of typing: how long each key is held and how long until the next one.
//
// A person does not type at an even pace: letters inside a word come in quick bursts, a new word starts a little
// late, a comma or the end of a sentence takes a breath, a capital, a digit or a symbol is a reach, now and then
// there is a hesitation, and no two people (or two moods) share a speed. Text that is not on the keyboard (Chinese)
// arrives the way an input method commits it: a few characters at a time, each piece after the time it took to
// compose.
//
// The whole text is planned before the first key, so its total is known: a plan longer than `budget` is sped up
// evenly to fit (an agent's tool call has a deadline; a long text is better dropped in at once: Input.drop).

/** @typedef {{ ch: string, shift?: boolean } | { text: string }} Unit a key that types `ch`, or a piece of text inserted at once */

export const TYPE_BUDGET_MS = 20_000;
const STEADY_MAX_MS = 220; // a <select>'s type-to-select forgets its keys after 1 s: no long pause between them

const LETTER = /\p{L}/u;
const BREATH = new Set(['.', ',', '!', '?', ';', ':', '\n', '\r']);

/** How many characters of a run an input method commits next: 1 to 4, two most often. @param {() => number} rand @param {number} left */
export function pieceSize(rand, left) {
  const r = rand();
  return Math.min(left, r < 0.22 ? 1 : r < 0.62 ? 2 : r < 0.86 ? 3 : 4);
}

/**
 * @param {Unit[]} units @param {() => number} rand
 * @param {{ steady?: boolean, budget?: number }} [o] steady: an even, quick pace with no long pause
 * @returns {{ holds: number[], gaps: number[], total: number }} per unit: ms the key is held (0 for a piece of text), ms until the next unit
 */
export function typingPlan(units, rand, { steady = false, budget = TYPE_BUDGET_MS } = {}) {
  const between = (/** @type {number} */ lo, /** @type {number} */ hi) => lo + (hi - lo) * rand();
  const skewed = (/** @type {number} */ lo, /** @type {number} */ hi) => lo + (hi - lo) * rand() * rand(); // mostly near lo, sometimes far out
  const tempo = between(0.8, 1.4); // this person, this time
  /** @type {number[]} */ const holds = [];
  /** @type {number[]} */ const gaps = [];
  let prev = '';
  for (const u of units) {
    if ('text' in u) {
      // composing: each character takes a few keys of its own, then choosing the candidate
      const n = [...u.text].length;
      holds.push(0);
      gaps.push(tempo * (n * between(130, 260) + between(0, 160)));
      prev = '';
      continue;
    }
    const c = u.ch;
    let gap = skewed(48, 170);
    if (LETTER.test(c) && LETTER.test(prev)) gap *= between(0.55, 1); // inside a word
    if (c === prev) gap *= 0.7; // the same key again
    if (u.shift || (!LETTER.test(c) && c !== ' ')) gap += between(25, 90); // a reach
    if (prev === ' ' && rand() < 0.6) gap += between(40, 170); // the next word
    if (BREATH.has(c)) gap += between(140, 460); // after a comma, a full stop, a line
    if (!steady && rand() < 0.035) gap += between(300, 800); // a hesitation
    holds.push(skewed(32, 115));
    gaps.push(tempo * gap);
    prev = c;
  }
  if (steady) for (let i = 0; i < gaps.length; i++) gaps[i] = Math.min(gaps[i], STEADY_MAX_MS);
  let total = 0;
  for (let i = 0; i < gaps.length; i++) total += gaps[i] + holds[i];
  if (total > budget) {
    const k = budget / total;
    for (let i = 0; i < gaps.length; i++) { gaps[i] *= k; holds[i] *= k; }
    total = budget;
  }
  return { holds: holds.map(Math.round), gaps: gaps.map(Math.round), total: Math.round(total) };
}
