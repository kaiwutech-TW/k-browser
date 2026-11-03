// @ts-check
// A stand-in for `k-browser mcp-worker`, for the shim's tests. It logs every message it gets (one JSON line each, with
// its pid) to FAKE_LOG, and reads FAKE_CTRL (JSON) when it starts: { fail, protocol, tools }.
//   tools/call echo: answers at once with its pid; slow: after args.ms; tab: reports a tab table first; die: exits unanswered.
//   A cancelled slow call is never answered (as the MCP SDK does).

import fs from 'node:fs';

const log = (/** @type {any} */ m) => fs.appendFileSync(String(process.env.FAKE_LOG), `${JSON.stringify({ pid: process.pid, ...m })}\n`);
/** @type {{ fail?: boolean, protocol?: string, tools?: string[] }} */
let ctrl = {};
try { ctrl = JSON.parse(fs.readFileSync(String(process.env.FAKE_CTRL), 'utf8')); } catch { /* defaults */ }
log({ started: true });
if (ctrl.fail) process.exit(3);

const send = (/** @type {any} */ m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const text = (/** @type {any} */ x) => ({ content: [{ type: 'text', text: JSON.stringify(x) }] });

/** @type {Map<unknown, NodeJS.Timeout>} */ const slow = new Map();
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0;) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    log({ got: m });
    if (m.method === 'notifications/cancelled') clearTimeout(slow.get(m.params?.requestId));
    if (m.id === undefined) continue;
    if (m.method === 'initialize') {
      send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: ctrl.protocol ?? m.params?.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '0' } } });
    } else if (m.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: m.id, result: { tools: (ctrl.tools ?? ['echo']).map((name) => ({ name, inputSchema: { type: 'object' } })) } });
    } else if (m.method === 'k-browser/adopt') {
      send({ jsonrpc: '2.0', id: m.id, result: {} });
    } else if (m.method === 'tools/call') {
      const { name, arguments: a = {} } = m.params;
      if (name === 'die') process.exit(1);
      if (name === 'tab') send({ jsonrpc: '2.0', method: 'k-browser/tabs', params: a.state });
      if (name === 'slow') slow.set(m.id, setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: text({ pid: process.pid, slow: true }) }), a.ms ?? 300));
      else send({ jsonrpc: '2.0', id: m.id, result: text({ pid: process.pid, name }) });
    } else {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
