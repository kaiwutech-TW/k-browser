// @ts-check
// The SDK's WebMCP layer (src/sdk/webmcp.js) on a scripted wire: no WebMCP in this Chrome, handles bound to the frame
// document, invocations bound to it too. Chrome itself: test/integration/webmcp.test.js.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAIN, open, rejectsWith, ROOT, tick, Wire } from './wire.js';

/** @param {Wire} w */
async function ready(w) {
  const tab = await open(w);
  tab.input.sleep = async () => {};
  return tab;
}

const tool = (/** @type {string} */ name) => ({ name, description: name, inputSchema: { type: 'object' }, frameId: MAIN });

test('a Chrome without the WebMCP domain: unsupported, never a fallback into the page', async () => {
  const w = new Wire();
  w.on('WebMCP.enable', () => { throw new Error("'WebMCP.enable' wasn't found"); });
  const tab = await ready(w);
  await rejectsWith(() => tab.webmcp().list(), 'unsupported');
  assert.equal(w.sent.filter((m) => m.method === 'Runtime.evaluate' || m.method === 'Runtime.callFunctionOn').length, 0);
});

test('handles: bound to the frame document; a navigation makes them stale and drops the old document\'s tools', async () => {
  const w = new Wire();
  w.on('WebMCP.enable', () => { w.event('WebMCP.toolsAdded', { tools: [tool('draft')] }, ROOT); return {}; });
  w.on('WebMCP.invokeTool', () => ({ invocationId: 'I1' }));
  const tab = await ready(w);
  const [t] = await tab.webmcp().list();
  assert.equal(t.handle, 'w1.1');
  w.event('Page.frameNavigated', { frame: { id: MAIN, url: 'https://a.test/2' } }, ROOT);
  await tick();
  await rejectsWith(() => tab.webmcp().call('w1.1', {}), 'stale_ref');
  assert.equal(w.sent.filter((m) => m.method === 'WebMCP.invokeTool').length, 0, 'nothing sent on a stale handle');
  assert.deepEqual(await tab.webmcp().list(), [], 'the old document\'s tool is not offered');
});

test('a call: answered in time -> its outcome; not yet -> waiting, then wait collects it; the page navigating meanwhile -> result_unknown', async () => {
  const w = new Wire();
  let n = 0;
  w.on('WebMCP.enable', () => { w.event('WebMCP.toolsAdded', { tools: [tool('draft'), tool('submit')] }, ROOT); return {}; });
  w.on('WebMCP.invokeTool', (p) => {
    const id = `I${++n}`;
    if (p.toolName === 'draft') setTimeout(() => w.event('WebMCP.toolResponded', { invocationId: id, status: 'Completed', output: { ok: 1 } }, ROOT), 5);
    return { invocationId: id };
  });
  const tab = await ready(w);
  const mcp = tab.webmcp();
  await mcp.list();
  assert.deepEqual(await mcp.call('w1.1', { amount: 5 }), { invocationId: 'I1', tool: 'draft', status: 'Completed', output: { ok: 1 } });
  assert.deepEqual(w.sent.find((m) => m.method === 'WebMCP.invokeTool')?.params, { frameId: MAIN, toolName: 'draft', input: { amount: 5 } });
  const waiting = await mcp.call('w1.2', {}, { timeoutMs: 20 });
  assert.equal(waiting.status, 'waiting');
  setTimeout(() => w.event('WebMCP.toolResponded', { invocationId: 'I2', status: 'Completed', output: 'done' }, ROOT), 10);
  assert.equal((await mcp.wait('I2', { timeoutMs: 1000 })).output, 'done');
  // a third, then the page navigates: nobody will answer, and the page may have acted
  await mcp.call('w1.2', {}, { timeoutMs: 1 });
  w.event('Page.frameNavigated', { frame: { id: MAIN, url: 'https://a.test/2' } }, ROOT);
  await tick();
  await rejectsWith(() => mcp.wait('I3', { timeoutMs: 1000 }), 'result_unknown');
  await rejectsWith(() => mcp.call('w1.1', []), 'bad_argument');
});

test('the outcome arrives before invokeTool\'s own answer (relayed separately): kept, not lost', async () => {
  const w = new Wire();
  w.on('WebMCP.enable', () => { w.event('WebMCP.toolsAdded', { tools: [tool('draft')] }, ROOT); return {}; });
  w.on('WebMCP.invokeTool', () => { w.event('WebMCP.toolResponded', { invocationId: 'E1', status: 'Completed', output: 'fast' }, ROOT); return { invocationId: 'E1' }; });
  const tab = await ready(w);
  await tab.webmcp().list();
  const r = await tab.webmcp().call('w1.1', {}, { timeoutMs: 50 });
  assert.deepEqual([r.status, r.output], ['Completed', 'fast']);
});

test('review ①: a tool removed and registered again under the same name is another tool: the old handle is stale', async () => {
  const w = new Wire();
  w.on('WebMCP.enable', () => { w.event('WebMCP.toolsAdded', { tools: [tool('save')] }, ROOT); return {}; });
  w.on('WebMCP.invokeTool', () => ({ invocationId: 'X' }));
  const tab = await ready(w);
  const mcp = tab.webmcp();
  await mcp.list();
  w.event('WebMCP.toolsRemoved', { tools: [{ name: 'save', frameId: MAIN }] }, ROOT);
  w.event('WebMCP.toolsAdded', { tools: [{ ...tool('save'), description: 'saves B' }] }, ROOT);
  await tick();
  await rejectsWith(() => mcp.call('w1.1', {}), 'stale_ref');
  assert.equal(w.count('WebMCP.invokeTool'), 0);
  // the same registration announced again (enable on another session replays it) keeps its handle
  const [again] = await mcp.list();
  w.event('WebMCP.toolsAdded', { tools: [{ ...tool('save'), description: 'saves B' }] }, ROOT);
  await tick();
  assert.equal((await mcp.call(again.handle, {}, { timeoutMs: 1 })).status, 'waiting');
});

test('review ②: list numbers carry over to a new Tab object (a reattach, a new MCP worker): a handle is never issued twice', async () => {
  const w = new Wire();
  w.on('WebMCP.enable', () => { w.event('WebMCP.toolsAdded', { tools: [tool('a')] }, ROOT); return {}; });
  const { Tab } = await import('../src/sdk/index.js');
  const tab = await Tab.attach(w.client, 'T1', { webmcpSeq: 5 });
  await tab.settled();
  tab.input.sleep = async () => {};
  assert.equal((await tab.webmcp().list())[0].handle, 'w6.1');
  assert.equal(tab.webmcpSeq, 6);
});

test('a call waiting when the connection to K-Browser closes: result_unknown, not waiting forever', async () => {
  const w = new Wire();
  w.on('WebMCP.enable', () => { w.event('WebMCP.toolsAdded', { tools: [tool('slow')] }, ROOT); return {}; });
  w.on('WebMCP.invokeTool', () => ({ invocationId: 'S1' }));
  const tab = await ready(w);
  await tab.webmcp().list();
  await tab.webmcp().call('w1.1', {}, { timeoutMs: 1 });
  tab.client.closedWhy = 'the connection closed';
  await rejectsWith(() => tab.webmcp().wait('S1', { timeoutMs: 2000 }), 'result_unknown');
});

test('review round 2: the same names registered by a new document (a reload, no toolsRemoved) are listed, as new registrations', async () => {
  const w = new Wire();
  w.on('WebMCP.enable', () => { w.event('WebMCP.toolsAdded', { tools: [tool('a'), tool('b')] }, ROOT); return {}; });
  const tab = await ready(w);
  const first = await tab.webmcp().list();
  w.event('Page.frameNavigated', { frame: { id: MAIN, url: 'https://a.test/' } }, ROOT);
  await tick();
  w.event('WebMCP.toolsAdded', { tools: [tool('a'), tool('b')] }, ROOT);
  await tick();
  const second = await tab.webmcp().list();
  assert.deepEqual(second.map((t) => t.name), ['a', 'b']);
  await rejectsWith(() => tab.webmcp().call(first[0].handle, {}), 'stale_ref');
});
