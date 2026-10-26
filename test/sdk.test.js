// @ts-check
// Unit tests: the SDK's frame / session / world / ref bookkeeping against a scripted CDP wire.
// Each test names the completion condition it covers.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SdkError } from '../src/sdk/cdp.js';
import { FrameTree } from '../src/sdk/frames.js';
import { Tab } from '../src/sdk/index.js';
import { axDoc, MAIN, open, refOf, rejectsWith, ROOT, tick, Wire } from './wire.js';

// ---------- generations ----------

test('generations only increase: a frame removed and recreated under the same id gets new values', () => {
  const t = new FrameTree(ROOT);
  let seq = 0;
  t.onEvent({ method: 'Page.frameNavigated', params: { frame: { id: MAIN, url: 'a' } }, sessionId: ROOT, seq: ++seq });
  t.onEvent({ method: 'Page.frameAttached', params: { frameId: 'C', parentFrameId: MAIN }, sessionId: ROOT, seq: ++seq });
  const first = /** @type {import('../src/sdk/frames.js').Stamp} */ (t.stamp('C'));
  t.onEvent({ method: 'Page.frameDetached', params: { frameId: 'C', reason: 'remove' }, sessionId: ROOT, seq: ++seq });
  assert.equal(t.stamp('C'), null);
  t.onEvent({ method: 'Page.frameAttached', params: { frameId: 'C', parentFrameId: MAIN }, sessionId: ROOT, seq: ++seq });
  const again = /** @type {import('../src/sdk/frames.js').Stamp} */ (t.stamp('C'));
  assert.ok(again.sessionGen > first.sessionGen && again.documentGen > first.documentGen, 'new, larger generations');
  assert.equal(t.same(first), false, 'the old stamp no longer matches');
});

// ---------- refs go stale ----------

test('detach / re-create under the same frameId: the old ref is stale_ref', async () => {
  const w = new Wire();
  w.trees.set(ROOT, { frame: { id: MAIN, url: 'https://a.test/' }, childFrames: [{ frame: { id: 'C', parentId: MAIN, url: 'https://a.test/c' } }] });
  w.ax.set('C', axDoc('C', [['button', 'in child', 11]]));
  const tab = await open(w);
  const ref = refOf(tab, await tab.snapshot(), 'in child');
  assert.equal(tab.entry(ref).backendNodeId, 11);
  w.event('Page.frameDetached', { frameId: 'C', reason: 'remove' });
  w.event('Page.frameAttached', { frameId: 'C', parentFrameId: MAIN });
  assert.throws(() => tab.entry(ref), (e) => e instanceof SdkError && e.code === 'stale_ref');
  await rejectsWith(() => tab.read(ref), 'stale_ref');
  assert.ok(refOf(tab, await tab.snapshot(), 'in child'), 'a new snapshot gives a usable ref again');
});

test('a child session detaching (and the frame re-attaching on a new session) makes its refs stale', async () => {
  const w = new Wire();
  const tab = await open(w);
  w.ax.set('X', axDoc('X', [['button', 'oopif button', 21]]));
  w.attach('S1', 'X');
  await tick();
  await tab.settled();
  assert.deepEqual(w.sent.filter((m) => m.sessionId === 'S1').map((m) => m.method), ['Page.enable', 'Network.enable', 'Page.getFrameTree', 'Target.setAutoAttach'],
    'the child session is set up: its network observed and its own auto-attach (nested OOPIFs)');
  const ref = refOf(tab, await tab.snapshot(), 'oopif button');
  w.event('Target.detachedFromTarget', { sessionId: 'S1' });
  assert.throws(() => tab.entry(ref), (e) => e instanceof SdkError && e.code === 'stale_ref');
  w.attach('S2', 'X'); // the same frame on a new session
  await tick();
  await tab.settled();
  assert.throws(() => tab.entry(ref), (e) => e instanceof SdkError && e.code === 'stale_ref', 'still stale after re-attach');
  const fresh = refOf(tab, await tab.snapshot(), 'oopif button');
  assert.equal(tab.entry(fresh).stamp.sessionId, 'S2');
});

// ---------- frame swap ----------

for (const order of ['new session attaches first', 'old session frameDetached(swap) first']) {
  test(`frame swap, ${order}: the frame maps to the new session and old refs are stale`, async () => {
    const w = new Wire();
    w.trees.set(ROOT, { frame: { id: MAIN, url: 'https://a.test/' }, childFrames: [{ frame: { id: 'C', parentId: MAIN, url: 'https://a.test/c' } }] });
    w.ax.set('C', axDoc('C', [['button', 'swap me', 31]]));
    const tab = await open(w);
    const ref = refOf(tab, await tab.snapshot(), 'swap me');
    assert.equal(tab.entry(ref).stamp.sessionId, ROOT);
    if (order === 'new session attaches first') {
      w.attach('S9', 'C');
      w.event('Page.frameDetached', { frameId: 'C', reason: 'swap' }); // late, from the old owner: must not undo the new one
    } else {
      w.event('Page.frameDetached', { frameId: 'C', reason: 'swap' });
      assert.equal(tab.tree.frames.has('C'), true, 'a swap keeps the logical frame');
      assert.equal(tab.tree.stamp('C'), null, 'but nothing may use it until the new owner attaches');
      w.attach('S9', 'C');
    }
    await tick();
    await tab.settled();
    assert.equal(tab.tree.stamp('C')?.sessionId, 'S9');
    assert.throws(() => tab.entry(ref), (e) => e instanceof SdkError && e.code === 'stale_ref');
    w.event('Page.frameDetached', { frameId: 'C', reason: 'remove' }); // anything else late from the old owner is ignored too
    assert.equal(tab.tree.stamp('C')?.sessionId, 'S9');
    const fresh = refOf(tab, await tab.snapshot(), 'swap me');
    assert.equal(tab.entry(fresh).stamp.sessionId, 'S9');
  });
}

test('remote -> local: the child detaches before frameAttached; the frame comes back with new generations', async () => {
  const w = new Wire();
  const tab = await open(w);
  w.attach('S1', 'X');
  await tick();
  await tab.settled();
  const old = /** @type {import('../src/sdk/frames.js').Stamp} */ (tab.tree.stamp('X'));
  w.event('Target.detachedFromTarget', { sessionId: 'S1' });
  w.event('Page.frameAttached', { frameId: 'X', parentFrameId: MAIN });
  const now = tab.tree.stamp('X');
  assert.equal(now?.sessionId, ROOT);
  assert.equal(tab.tree.same(old), false);
});

// ---------- late replies ----------

test('a getFullAXTree reply that arrives after the frame navigated is discarded', async () => {
  const w = new Wire();
  w.trees.set(ROOT, { frame: { id: MAIN, url: 'https://a.test/' }, childFrames: [{ frame: { id: 'C', parentId: MAIN, url: 'https://a.test/c' } }] });
  w.ax.set(MAIN, axDoc(MAIN, [['button', 'main button', 5]]));
  w.ax.set('C', axDoc('C', [['button', 'old document', 41]]));
  const tab = await open(w);
  w.holding.add('Accessibility.getFullAXTree');
  const pending = tab.snapshot();
  await tick();
  w.event('Page.frameNavigated', { frame: { id: 'C', parentId: MAIN, url: 'https://a.test/c2' } });
  w.release('Accessibility.getFullAXTree');
  const snap = await pending;
  assert.ok(!snap.refs.some((r) => r.name === 'old document'), 'no ref from the replaced document');
  assert.ok(snap.refs.some((r) => r.name === 'main button'), 'the unchanged frame is still there');
  assert.ok(snap.notes.some((n) => n.includes('C') && n.includes('changed')), 'and the gap is reported');
});

test('a createIsolatedWorld reply that arrives after the frame navigated is discarded, not cached', async () => {
  const w = new Wire();
  const tab = await open(w);
  w.holding.add('Page.createIsolatedWorld');
  const pending = tab.evaluate(() => 1);
  await tick();
  w.event('Page.frameNavigated', { frame: { id: MAIN, url: 'https://a.test/next' } });
  w.release('Page.createIsolatedWorld');
  await rejectsWith(() => pending, 'no_frame');
  assert.equal(tab.worlds.cache.size, 0);
  assert.equal(w.count('Runtime.evaluate'), 0, 'nothing ran in a world of the old document');
});

test('a getFrameTree reply older than an event does not undo the event', async () => {
  const w = new Wire();
  w.trees.set(ROOT, { frame: { id: MAIN, url: 'https://a.test/' }, childFrames: [{ frame: { id: 'C', parentId: MAIN, url: 'https://a.test/c' } }] });
  w.holding.add('Page.getFrameTree');
  const opening = Tab.attach(w.client, 'T1');
  for (let i = 0; i < 5 && !w.held.length; i++) await tick();
  w.release('Page.getFrameTree');
  // The reply is in; an event that arrived right behind it is handled before the awaiting code resumes.
  w.event('Page.frameDetached', { frameId: 'C', reason: 'remove' });
  const tab = await opening;
  assert.equal(tab.tree.frames.has('C'), false, 'C stays removed although the (older) reply listed it');
  assert.equal(tab.tree.mainFrameId, MAIN);
});

test('an older getFrameTree reply does not re-claim a frame that a newer event swapped out, nor revert its url', () => {
  const t = new FrameTree(ROOT);
  t.treeRequested();
  // These arrived after the reply (seq 10) but were handled before it was applied.
  t.onEvent({ method: 'Page.frameAttached', params: { frameId: 'Y', parentFrameId: MAIN }, sessionId: ROOT, seq: 11 });
  t.onEvent({ method: 'Page.frameDetached', params: { frameId: 'Y', reason: 'swap' }, sessionId: ROOT, seq: 12 });
  t.onEvent({ method: 'Page.frameAttached', params: { frameId: 'Z', parentFrameId: MAIN }, sessionId: ROOT, seq: 13 });
  t.onEvent({ method: 'Page.frameNavigated', params: { frame: { id: 'Z', parentId: MAIN, url: 'https://a.test/new' } }, sessionId: ROOT, seq: 14 });
  t.applyFrameTree(ROOT, { frame: { id: MAIN, url: 'https://a.test/' }, childFrames: [
    { frame: { id: 'Y', parentId: MAIN, url: 'https://a.test/y' } }, { frame: { id: 'Z', parentId: MAIN, url: 'https://a.test/old' } }] }, 10);
  assert.equal(t.stamp('Y'), null, 'Y is still waiting for its new owner');
  assert.equal(t.frames.get('Z')?.url, 'https://a.test/new');
});

test('a stale frameAttached from the old owner followed by its swap: the frame goes back to the live child, not to nobody', () => {
  const t = new FrameTree(ROOT);
  let seq = 0;
  /** @param {string} method @param {Record<string, any>} params @param {string} [sid] */
  const ev = (method, params, sid = ROOT) => t.onEvent({ method, params, sessionId: sid, seq: ++seq });
  ev('Page.frameNavigated', { frame: { id: MAIN, url: 'a' } });
  ev('Page.frameAttached', { frameId: 'C', parentFrameId: MAIN });
  ev('Target.attachedToTarget', { sessionId: 'S', targetInfo: { targetId: 'C', type: 'iframe' } });
  const before = /** @type {import('../src/sdk/frames.js').Stamp} */ (t.stamp('C'));
  ev('Page.frameAttached', { frameId: 'C', parentFrameId: MAIN });
  ev('Page.frameDetached', { frameId: 'C', reason: 'swap' });
  assert.equal(t.stamp('C')?.sessionId, 'S');
  assert.equal(t.same(before), false, 'with new generations: what was taken in between is not trusted');
});

test('swap, then remove from the session it was swapped out of: no ownerless ghost is left', () => {
  const t = new FrameTree(ROOT);
  let seq = 0;
  /** @param {string} method @param {Record<string, any>} params @param {string | null} [sid] */
  const ev = (method, params, sid = ROOT) => t.onEvent({ method, params, sessionId: sid, seq: ++seq });
  ev('Page.frameAttached', { frameId: 'C', parentFrameId: MAIN });
  ev('Target.attachedToTarget', { sessionId: 'OTHER', targetInfo: { targetId: 'D', type: 'iframe' } }); // live, but C is not its
  ev('Page.frameDetached', { frameId: 'C', reason: 'swap' });
  ev('Page.frameDetached', { frameId: 'C', reason: 'remove' }, 'OTHER');
  assert.equal(t.frames.has('C'), true, 'a live session that never owned C cannot remove it');
  ev('Page.frameDetached', { frameId: 'C', reason: 'remove' });
  assert.equal(t.frames.has('C'), false);

  // The same when C was swapped out of a child session that then ends: C goes with it.
  ev('Target.attachedToTarget', { sessionId: 'S1', targetInfo: { targetId: 'C', type: 'iframe' } });
  ev('Page.frameDetached', { frameId: 'C', reason: 'swap' }, 'S1');
  assert.equal(t.frames.has('C'), true);
  ev('Target.detachedFromTarget', { sessionId: 'S1' }, null);
  assert.equal(t.frames.has('C'), false);
});

test('two child sessions for one frame: the newer supersedes the older, so a hand-back and a late detach cannot kill the newer', () => {
  const t = new FrameTree(ROOT);
  let seq = 0;
  /** @param {string} method @param {Record<string, any>} params @param {string | null} [sid] */
  const ev = (method, params, sid = ROOT) => t.onEvent({ method, params, sessionId: sid, seq: ++seq });
  ev('Page.frameAttached', { frameId: 'C', parentFrameId: MAIN });
  ev('Target.attachedToTarget', { sessionId: 'S1', targetInfo: { targetId: 'C', type: 'iframe' } });
  ev('Target.attachedToTarget', { sessionId: 'S2', targetInfo: { targetId: 'C', type: 'iframe' } }); // S1 not detached yet
  ev('Page.frameAttached', { frameId: 'C', parentFrameId: MAIN }); // stale, from the root
  ev('Page.frameDetached', { frameId: 'C', reason: 'swap' });
  assert.equal(t.stamp('C')?.sessionId, 'S2', 'handed back to the newest session');
  ev('Target.detachedFromTarget', { sessionId: 'S1' }, null);
  assert.equal(t.stamp('C')?.sessionId, 'S2', "the old session's detach takes nothing with it");
  assert.equal(t.live('S2'), true);
});

test('an older getFrameTree reply does not revive the subtree of a frame removed or renavigated after it', () => {
  const tree = { frame: { id: MAIN, url: 'https://a.test/' }, childFrames: [{ frame: { id: 'C', parentId: MAIN, url: 'c' },
    childFrames: [{ frame: { id: 'G', parentId: 'C', url: 'g' } }] }] };
  const removed = new FrameTree(ROOT);
  removed.treeRequested();
  removed.onEvent({ method: 'Page.frameDetached', params: { frameId: 'C', reason: 'remove' }, sessionId: ROOT, seq: 11 });
  removed.applyFrameTree(ROOT, tree, 10);
  assert.deepEqual([...removed.frames.keys()], [MAIN], 'neither C nor its child G');

  const renavigated = new FrameTree(ROOT);
  renavigated.onEvent({ method: 'Page.frameAttached', params: { frameId: 'C', parentFrameId: MAIN }, sessionId: ROOT, seq: 5 });
  renavigated.treeRequested();
  renavigated.onEvent({ method: 'Page.frameNavigated', params: { frame: { id: 'C', parentId: MAIN, url: 'c2' } }, sessionId: ROOT, seq: 11 });
  renavigated.applyFrameTree(ROOT, tree, 10);
  assert.equal(renavigated.frames.has('G'), false, "G belonged to C's old document");
  assert.equal(renavigated.frames.get('C')?.url, 'c2');
});

// ---------- documents ----------

test('the parent frame replacing its document invalidates its whole old subtree', async () => {
  const w = new Wire();
  w.trees.set(ROOT, { frame: { id: MAIN, url: 'https://a.test/' }, childFrames: [{ frame: { id: 'C', parentId: MAIN, url: 'https://a.test/c' },
    childFrames: [{ frame: { id: 'G', parentId: 'C', url: 'https://a.test/g' } }] }] });
  w.ax.set('G', axDoc('G', [['link', 'grandchild link', 51]]));
  const tab = await open(w);
  w.attach('S1', 'X'); // an OOPIF under the main frame too
  await tick();
  await tab.settled();
  const ref = refOf(tab, await tab.snapshot(), 'grandchild link');
  w.event('Page.frameNavigated', { frame: { id: MAIN, url: 'https://a.test/other' } });
  assert.throws(() => tab.entry(ref), (e) => e instanceof SdkError && e.code === 'stale_ref');
  assert.deepEqual([...tab.tree.frames.keys()], [MAIN], 'child, grandchild and the OOPIF all went with the old document');
  assert.equal(tab.tree.live('S1'), false, "the OOPIF's session no longer counts");
  w.event('Page.frameNavigated', { frame: { id: 'X', url: 'https://x.test/late' } }, 'S1');
  assert.equal(tab.tree.frames.has('X'), false, 'a late event from that session does not bring it back');
});

test('Page.documentOpened (document.open()) invalidates the refs and the world of that frame', async () => {
  const w = new Wire();
  w.ax.set(MAIN, axDoc(MAIN, [['button', 'before open', 61]]));
  const tab = await open(w);
  const ref = refOf(tab, await tab.snapshot(), 'before open');
  await tab.evaluate(() => 1);
  const worlds = w.count('Page.createIsolatedWorld');
  w.event('Page.documentOpened', { frame: { id: MAIN, url: 'https://a.test/' } });
  assert.throws(() => tab.entry(ref), (e) => e instanceof SdkError && e.code === 'stale_ref');
  await tab.evaluate(() => 1);
  assert.equal(w.count('Page.createIsolatedWorld'), worlds + 1, 'a new world for the new document (the old context would still answer)');
});

// ---------- worlds ----------

test('world creation failing is an error, and no script ever runs outside an isolated world', async () => {
  const w = new Wire();
  const tab = await open(w);
  await tab.evaluate(() => 1);
  // The context goes away (as after a crash); re-creating the world fails too.
  w.on('Runtime.evaluate', () => { throw new Error('Cannot find context with specified id'); });
  w.on('Page.createIsolatedWorld', () => { throw new Error('No frame for given id found'); });
  await rejectsWith(() => tab.evaluate(() => 1), 'world_unavailable');
  await rejectsWith(() => tab.read(), 'world_unavailable');
  const created = new Set(Array.from({ length: w.ctx }, (_, i) => i + 1));
  const evals = w.sent.filter((x) => x.method === 'Runtime.evaluate');
  assert.ok(evals.length > 0);
  for (const m of evals) {
    assert.ok(created.has(m.params.contextId), `every Runtime.evaluate names a created isolated world (got ${m.params.contextId})`);
  }
});

test('read(ref) resolves the node in the isolated world of its own frame, on its own session, and calls into that object', async () => {
  const w = new Wire();
  w.ax.set(MAIN, axDoc(MAIN, [['button', 'main b', 7]]));
  w.ax.set('X', axDoc('X', [['button', 'oopif b', 8]]));
  /** @type {{ frameId: string, sid: string | null, id: number }[]} */
  const made = [];
  w.on('Page.createIsolatedWorld', (p, sid) => { const id = ++w.ctx; made.push({ frameId: p.frameId, sid, id }); return { executionContextId: id }; });
  w.on('DOM.resolveNode', (p) => ({ object: { objectId: `obj-${p.backendNodeId}-in-${p.executionContextId}` } }));
  const tab = await open(w);
  w.attach('S1', 'X');
  await tick();
  await tab.settled();
  const snap = await tab.snapshot();
  for (const [name, frameId, sid, backend] of /** @type {const} */ ([['main b', MAIN, ROOT, 7], ['oopif b', 'X', 'S1', 8]])) {
    await tab.read(refOf(tab, snap, name));
    const world = made.filter((m) => m.frameId === frameId).at(-1);
    assert.ok(world && world.sid === sid, `a world was created in ${frameId} on ${sid}`);
    const resolve = w.sent.filter((m) => m.method === 'DOM.resolveNode').at(-1);
    assert.deepEqual([resolve?.params.backendNodeId, resolve?.params.executionContextId, resolve?.sessionId], [backend, world.id, sid]);
    const calls = w.sent.filter((m) => m.method === 'Runtime.callFunctionOn').slice(-2);
    assert.equal(calls.length, 2);
    for (const c of calls) assert.deepEqual([c.params.objectId, c.sessionId], [`obj-${backend}-in-${world.id}`, sid]);
  }
});

test('nothing is sent for a world or node already known to be stale (a pause after getting them)', async () => {
  const w = new Wire();
  w.ax.set(MAIN, axDoc(MAIN, [['button', 'b', 7]]));
  const tab = await open(w);
  const ref = refOf(tab, await tab.snapshot(), 'b');
  await tab.evaluate(() => 1);
  /** @type {() => void} */ let go = () => {};
  const paused = new Promise((r) => { go = () => r(undefined); });
  const world = tab.worlds.world.bind(tab.worlds);
  tab.worlds.world = async (id) => { const r = await world(id); await paused; return r; };
  const evals = w.count('Runtime.evaluate');
  const running = tab.evaluate(() => 1);
  await tick();
  w.event('Page.documentOpened', { frame: { id: MAIN, url: 'https://a.test/' } });
  go();
  await rejectsWith(() => running, 'no_frame');
  assert.equal(w.count('Runtime.evaluate'), evals, 'the old world was not used');

  tab.worlds.world = world;
  const ref2 = refOf(tab, await tab.snapshot(), 'b');
  /** @type {() => void} */ let go2 = () => {};
  const paused2 = new Promise((r) => { go2 = () => r(undefined); });
  const resolve = tab.worlds.resolve.bind(tab.worlds);
  tab.worlds.resolve = async (st, id) => { const r = await resolve(st, id); await paused2; return r; };
  const calls = w.count('Runtime.callFunctionOn');
  const reading = tab.read(ref2);
  await tick();
  w.event('Page.documentOpened', { frame: { id: MAIN, url: 'https://a.test/' } });
  go2();
  await rejectsWith(() => reading, 'stale_ref');
  assert.equal(w.count('Runtime.callFunctionOn'), calls, 'nothing ran on a node of the replaced document');
  assert.ok(ref !== ref2);
});

test('a ref whose node is no longer connected to the document is stale_ref, and nothing runs on it', async () => {
  const w = new Wire();
  w.ax.set(MAIN, axDoc(MAIN, [['button', 'b', 7]]));
  const tab = await open(w);
  const ref = refOf(tab, await tab.snapshot(), 'b');
  w.on('Runtime.callFunctionOn', () => ({ result: { value: false } })); // isConnected === false
  await rejectsWith(() => tab.read(ref), 'stale_ref');
  assert.equal(w.count('Runtime.callFunctionOn'), 1, 'only the isConnected check ran');
});

test('an exception thrown by the page script is never re-run, whatever its message says', async () => {
  const w = new Wire();
  const tab = await open(w);
  w.on('Runtime.evaluate', () => ({ result: { type: 'object' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: Cannot find context with specified id (cart)' } } }));
  await rejectsWith(() => tab.evaluate(() => 1), 'script_error');
  assert.equal(w.count('Runtime.evaluate'), 1);
  w.on('Runtime.evaluate', () => { throw new Error('Execution context was destroyed.'); }); // it may have run in part
  await rejectsWith(() => tab.evaluate(() => 1), 'cdp_error');
  assert.equal(w.count('Runtime.evaluate'), 2, 'not retried either');
});

test('a lost context is re-created once, transparently', async () => {
  const w = new Wire();
  const tab = await open(w);
  await tab.evaluate(() => 1);
  let fail = true;
  w.on('Runtime.evaluate', (p) => {
    if (fail && p.contextId === 1) { fail = false; throw new Error('Cannot find context with specified id'); }
    return { result: { value: `ctx ${p.contextId}` } };
  });
  assert.equal(await tab.evaluate(() => 1), 'ctx 2');
});

// ---------- snapshot shape ----------

test('the snapshot nests a child frame under its iframe, and nodes without backendDOMNodeId get no ref', async () => {
  const w = new Wire();
  w.trees.set(ROOT, { frame: { id: MAIN, url: 'https://a.test/' }, childFrames: [{ frame: { id: 'C', parentId: MAIN, url: 'https://a.test/c' } }] });
  w.ax.set(MAIN, axDoc(MAIN, [['heading', 'Title', 2], ['Iframe', '', 3], ['button', 'after frame', 4], ['button', 'no backend']]));
  w.ax.set('C', axDoc('C', [['textbox', 'Email', 12]]));
  w.owners.set(3, 'C');
  const tab = await open(w);
  const snap = await tab.snapshot();
  assert.equal(snap.text, [
    '- heading "Title"',
    '- frame "https://a.test/c"',
    '  - textbox "Email" [s1.1]',
    '- button "after frame" [s1.2]',
    '- button "no backend"',
  ].join('\n'));
  assert.equal(snap.refs.length, 2);
  for (const limit of [{ maxLines: 3 }, { maxBytes: 60 }]) {
    const cut = await tab.snapshot({ full: true, ...limit });
    assert.equal(cut.truncated, true, JSON.stringify(limit));
    assert.ok(Buffer.byteLength(cut.text) <= (limit.maxBytes ?? Infinity) && cut.text.split('\n').length <= (limit.maxLines ?? Infinity));
    assert.equal(cut.refs.length, cut.text.split('\n').filter((l) => l.includes('[s')).length, 'refs only for lines shown');
  }
});

test('a named image on its own gets a ref (a date picker icon); one inside a link, or without a name, does not', async () => {
  const w = new Wire();
  const nodes = axDoc(MAIN, [['textbox', 'date', 5], ['image', '...', 6], ['image', '', 7], ['link', 'product', 8]]);
  const link = /** @type {Record<string, any>} */ (nodes.find((n) => n.backendDOMNodeId === 8));
  link.childIds = [`${MAIN}-photo`];
  nodes.push({ nodeId: `${MAIN}-photo`, parentId: link.nodeId, role: { value: 'image' }, name: { value: 'photo' }, childIds: [], backendDOMNodeId: 9 });
  w.ax.set(MAIN, nodes);
  const tab = await open(w);
  const snap = await tab.snapshot();
  assert.equal(snap.text, ['- textbox "date" [s1.1]', '- image "..." [s1.2]', '- link "product" [s1.3]'].join('\n'));
});

test('footprint: the SDK never sends Runtime.enable', async () => {
  const w = new Wire();
  w.ax.set(MAIN, axDoc(MAIN, [['button', 'b', 7]]));
  const tab = await open(w);
  w.attach('S1', 'X');
  await tick();
  const snap = await tab.snapshot();
  await tab.read(refOf(tab, snap, 'b'));
  await tab.read();
  const going = tab.goto('https://a.test/next');
  for (let i = 0; i < 5; i++) await tick();
  w.event('Page.frameNavigated', { frame: { id: MAIN, url: 'https://a.test/next' } });
  w.event('Page.loadEventFired', { timestamp: 1 });
  await going;
  assert.equal(w.client.sent.get('Runtime.enable') ?? 0, 0);
  assert.ok((w.client.sent.get('Page.createIsolatedWorld') ?? 0) > 0, 'scripts ran, in isolated worlds');
});
