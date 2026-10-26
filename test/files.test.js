// @ts-check
// The file area is named by the client's principal: a client removed and added again under
// the same name sees none of the old one's files. Download / upload themselves: test/integration/p5c.test.js.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import * as auth from '../src/auth.js';
import * as files from '../src/files.js';
import { McpSession } from '../src/mcp/server.js';

beforeEach(() => {
  process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-files-'));
});

/** @param {string} name */
function session(name) {
  return new McpSession({ name, port: 1, record: /** @type {any} */ (auth.clientRecord(name)), connect: /** @type {any} */ (async () => { throw new Error('no browser'); }) });
}
/** @param {any} r */
const head = (r) => JSON.parse(r.content[0].text.split('\n')[0]);

test('a client added again under the same name gets a new file area: the old files are neither listed nor usable', async () => {
  auth.addClient('agent');
  const old = /** @type {any} */ (auth.clientRecord('agent')).principal;
  files.writeNew(old, 'report.txt', [Buffer.from('OLDCLIENT_CANARY')]);
  assert.deepEqual(head(await session('agent').call('files', { action: 'list' })).files.map((/** @type {any} */ f) => f.name), ['report.txt']);
  auth.removeClient('agent');
  auth.addClient('agent');
  const now = /** @type {any} */ (auth.clientRecord('agent')).principal;
  assert.notEqual(now, old);
  assert.deepEqual(head(await session('agent').call('files', { action: 'list' })).files, []);
  assert.throws(() => files.existing(now, 'report.txt'), files.FilesError, 'what the bridge checks before an upload');
  assert.ok(!fs.existsSync(path.join(auth.home(), 'files', 'agent')), 'never a directory named after the client');
});
