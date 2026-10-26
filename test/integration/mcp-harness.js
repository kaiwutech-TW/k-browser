// @ts-check
// Shared by the MCP integration tests: a real `k-browser mcp` process driven by the official MCP client.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { sleep } from '../fakes.js';

const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

/**
 * A `k-browser mcp` process on its own home. Every raw result goes to `record` (for secret scans).
 * @param {string} home @param {number} port @param {(raw: string) => void} [record]
 */
export async function mcp(home, port, record = () => {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, '--port', String(port), 'mcp', '--client', 'agent'],
    env: { ...process.env, KBROWSER_HOME: home }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (d) => { stderr += d; });
  const client = new Client({ name: 'k-browser-test', version: '0' });
  await client.connect(transport);
  return {
    client,
    stderr: () => stderr,
    /** @param {string} name @param {Record<string, any>} args */
    async call(name, args) {
      const r = /** @type {any} */ (await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 }));
      record(JSON.stringify(r));
      const text = String(r.content?.[0]?.text ?? '');
      const nl = text.indexOf('\n');
      return { head: JSON.parse(nl < 0 ? text : text.slice(0, nl)), page: nl < 0 ? null : text.slice(nl + 1), text, isError: r.isError === true, raw: r };
    },
    close: () => client.close(),
  };
}

/** The client file `agent` the MCP process reads. @param {string} home @param {Record<string, any>} rec */
export function writeClient(home, rec) {
  fs.mkdirSync(path.join(home, 'clients'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, 'clients', 'agent.json'), JSON.stringify(rec), { mode: 0o600 });
}

/** until() for an async condition, polled every 200 ms. @param {() => Promise<boolean>} pred @param {number} ms */
export async function eventually(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(200);
  }
  return pred();
}

/** The ref on the snapshot line matching `line`. @param {string} snapText @param {RegExp} line */
export function refIn(snapText, line) {
  const m = new RegExp(`${line.source}.*\\[(s\\d+\\.\\d+)\\]`).exec(snapText);
  assert.ok(m, `a ref for ${line} in:\n${snapText}`);
  return m[1];
}
