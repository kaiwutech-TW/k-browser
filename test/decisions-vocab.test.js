// @ts-check
// The closed vocabularies of the decision dataset (src/decisions.js) against the codes Kav says it writes (its kfw/codes.json,
// Kav >= 0.0.8): a code Kav adds that K-Browser does not know would be recorded as "other". Skipped when the
// Kav checkout is not on this machine (kavCheckout in fakes.js).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { VOCAB } from '../src/decisions.js';
import { kavCheckout } from './fakes.js';

const KAV = kavCheckout();
const FILE = path.join(KAV, 'kfw', 'codes.json');
const skip = fs.existsSync(FILE) ? false : `no ${FILE}`;

test('every code in Kav\'s kfw/codes.json is in the closed vocabularies', { skip }, () => {
  const c = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(c.schema, 1, 'a new codes.json schema: look at what changed');
  const want = {
    VERDICTS: c.decision.verdicts,
    REFUSALS: [...c.decision.refusals, ...c.model_exit.known], // a refusal of K-Browser's model exit passes through as the refusal
    WHYS: [...c.decision.action_whys, ...c.task.whys],
    STATUSES: c.task.statuses,
    REASONS: [...c.task.reasons, ...c.model_exit.known],
  };
  for (const [name, codes] of Object.entries(want)) {
    const missing = codes.filter((/** @type {string} */ x) => !VOCAB[/** @type {keyof typeof VOCAB} */ (name)].has(x));
    assert.deepEqual(missing, [], `${name} in src/decisions.js lacks Kav's ${missing.join(', ')}`);
  }
});

const SITES_FILE = path.join(KAV, 'kfw', 'sites.py');

test('every site in Kav\'s kfw/sites.py is in the closed site list', { skip: fs.existsSync(SITES_FILE) ? false : `no ${SITES_FILE}` }, () => {
  const block = /^SITES = \{\n([\s\S]*?)^\}/m.exec(fs.readFileSync(SITES_FILE, 'utf8'));
  assert.ok(block, 'SITES = { … } not found: look at what changed');
  const ids = [...block[1].matchAll(/^ {4}"([a-z0-9_]+)":/gm)].map((m) => m[1]);
  assert.ok(ids.length > 0);
  assert.deepEqual(ids.filter((x) => !VOCAB.SITES.has(x)), [], 'add them to SITES in src/decisions.js');
});
