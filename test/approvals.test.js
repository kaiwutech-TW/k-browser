// @ts-check
// Approvals (src/approvals.js): one action of a client, allowed or denied by the user in the side panel.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Approvals } from '../src/approvals.js';

const tab = { targetId: 'T1', tabId: 1 };

test('allowed once: the first status read with consume uses it up; denied, expired and another client\'s are never allowed', () => {
  let now = 1000;
  let changes = 0;
  const ap = new Approvals({ ttlMs: 60_000, now: () => now, changed: () => { changes += 1; } });
  const a = ap.request('p1', tab, 'submit @ https://erp.test', '{"x":1}');
  assert.equal(ap.waiting().length, 1);
  assert.ok(changes > 0, 'the panel hears of it');
  assert.equal(ap.decide('p2', a.approvalId, true), false, 'another client cannot answer it');
  assert.equal(ap.get('p2', a.approvalId), null, 'nor read it');
  assert.equal(ap.decide('p1', a.approvalId, true), true);
  assert.equal(ap.get('p1', a.approvalId, { consume: true })?.state, 'allowed');
  assert.equal(ap.get('p1', a.approvalId, { consume: true })?.state, 'used', 'one action only');
  assert.equal(ap.decide('p1', a.approvalId, true), false, 'not waiting any more');

  const b = ap.request('p1', tab, 'pay', '');
  ap.decide('p1', b.approvalId, false);
  assert.equal(ap.get('p1', b.approvalId, { consume: true })?.state, 'denied');

  const c = ap.request('p1', tab, 'pay', '');
  now += 60_001;
  assert.equal(ap.get('p1', c.approvalId)?.state, 'expired');
  assert.equal(ap.decide('p1', c.approvalId, true), false, 'too late to allow');

  const d = ap.request('p1', tab, 'pay', '');
  ap.invalidate((x) => x.targetId === 'T1', 'the tab was closed');
  assert.equal(ap.get('p1', d.approvalId)?.state, 'invalidated');
  assert.throws(() => ap.request('p1', tab, '', ''), /title/);
});

test('use: only an allowed approval, of that client, for exactly what it was bound to, once', () => {
  const ap = new Approvals();
  const a = ap.request('p1', tab, 'pay', '', 'B1');
  assert.equal(ap.use('p1', a.approvalId, 'B1'), false, 'not allowed yet');
  ap.decide('p1', a.approvalId, true);
  assert.equal(ap.use('p2', a.approvalId, 'B1'), false, 'another client');
  assert.equal(ap.use('p1', a.approvalId, 'B2'), false, 'another call');
  assert.equal(ap.use('p1', a.approvalId, 'B1'), true);
  assert.equal(ap.use('p1', a.approvalId, 'B1'), false, 'once');
});

test('an Allow not used yet ends with its tab too', () => {
  const ap = new Approvals();
  const a = ap.request('p1', tab, 'pay', '', 'B1');
  ap.decide('p1', a.approvalId, true);
  ap.invalidate((x) => x.targetId === 'T1', 'the tab was closed');
  assert.equal(ap.use('p1', a.approvalId, 'B1'), false);
});
