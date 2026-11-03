// @ts-check
// Two Chrome profiles on one bridge, in Chrome for Testing (two user-data-dirs stand for two profiles: each runs its
// own extension with its own profile id). The same pairing code pairs both; an agent opens a tab in the one it names;
// one profile's Chrome restarting leaves the other's tabs alone. Run: npm run test:chrome

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as auth from '../../src/auth.js';
import * as profiles from '../../src/profiles.js';
import { startBridge } from '../../src/server.js';
import { until } from '../fakes.js';
import { findChrome, launchChrome } from './cft.js';
import { mcp as mcpProcess, writeClient } from './mcp-harness.js';

const CHROME = findChrome();
const skip = CHROME ? false : 'Chrome for Testing not found (set KBROWSER_TEST_CHROME)';

/** @type {Awaited<ReturnType<typeof startBridge>>} */ let bridge;
/** @type {Awaited<ReturnType<typeof launchChrome>>} */ let work;
/** @type {Awaited<ReturnType<typeof launchChrome>>} */ let home;
/** @type {Awaited<ReturnType<typeof mcpProcess>>} */ let m;
/** @type {http.Server} */ let site;
let base = '';
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cft-home-'));

before(async () => {
  if (skip) return;
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-prof-'));
  process.env.KBROWSER_HOME = kb;
  site = http.createServer((req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><title>page ${req.url}</title><p>hello ${req.url}</p>`));
  await new Promise((r) => site.listen(0, '127.0.0.1', () => r(undefined)));
  base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (site.address()).port}`;
  const key = /** @type {string} */ (auth.pairKey({ create: true }));
  writeClient(kb, { token: 'kbFAKEprofilesTOKEN0123456789abcdef', principal: 'p-profiles' });
  bridge = await startBridge({ port: 0, log: () => {} });
  work = await launchChrome({ chrome: /** @type {string} */ (CHROME) });
  home = await launchChrome({ chrome: /** @type {string} */ (CHROME), profile: homeDir });
  await work.pair(key, bridge.port);
  assert.ok(await until(() => bridge.relay.profiles().some((p) => p.online), 20000), 'the first profile is paired');
  await home.pair(key, bridge.port, 'home');
  assert.ok(await until(() => bridge.relay.profiles().filter((p) => p.online).length === 2, 20000), 'the second, with the same code');
  m = await mcpProcess(kb, bridge.port);
});

after(async () => {
  if (skip) return;
  await m?.close();
  await bridge?.close();
  await work?.close();
  await home?.close();
  site?.close();
});

/** The tabs' URLs in one Chrome, from its own control connection. @param {Awaited<ReturnType<typeof launchChrome>>} c */
const urls = async (c) => (await c.control.call('Target.getTargets')).targetInfos.filter((/** @type {any} */ t) => t.type === 'page').map((/** @type {any} */ t) => t.url);

test('the same pairing code pairs both profiles; status names them; a tab opens in the profile the agent names', { skip }, async () => {
  const status = (await m.call('status', {})).head;
  assert.deepEqual(status.profiles.map((/** @type {any} */ p) => [p.name, p.online, p.default === true]).sort(), [['default', true, true], ['home', true, false]]);
  const inHome = await m.call('tabs', { action: 'open', url: `${base}/in-home`, profile: 'home' });
  assert.equal(inHome.isError, false, inHome.text);
  const inDefault = await m.call('tabs', { action: 'open', url: `${base}/in-default` });
  assert.ok((await urls(home)).includes(`${base}/in-home`) && !(await urls(work)).includes(`${base}/in-home`), 'opened in the home Chrome');
  assert.ok((await urls(work)).includes(`${base}/in-default`), 'and the default in the other');
  const read = await m.call('read', { tab: inHome.head.tab });
  assert.match(read.page ?? '', /hello \/in-home/);
  const list = (await m.call('tabs', { action: 'list' })).head.tabs;
  assert.deepEqual(list.map((/** @type {any} */ t) => [t.tab, t.profile]).sort(), [[inHome.head.tab, 'home'], [inDefault.head.tab, 'default']].sort());
  assert.equal((await m.call('tabs', { action: 'open', url: base, profile: 'nope' })).head.error, 'unknown_profile');
  const mixed = await m.call('tabs', { action: 'open', url: base, profile: 'home', space: 's1' });
  assert.equal(mixed.isError, false);
  assert.equal((await m.call('tabs', { action: 'open', url: base, profile: 'default', space: 's1' })).head.error, 'bad_argument', 'a space stays in one profile');
});

test('a space opened in the default profile stays there when the default changes', { skip }, async () => {
  const first = await m.call('tabs', { action: 'open', url: `${base}/s2-first`, space: 's2' });
  assert.equal(first.isError, false, first.text);
  profiles.setDefault('home'); // the user changes the default; the agent has not listed its tabs since
  try {
    assert.ok(await until(() => bridge.relay.registry.default === bridge.relay.profiles().find((p) => p.name === 'home')?.context, 5000));
    const second = await m.call('tabs', { action: 'open', url: `${base}/s2-second`, space: 's2' });
    assert.equal(second.isError, false, second.text);
    assert.ok((await urls(work)).includes(`${base}/s2-second`) && !(await urls(home)).includes(`${base}/s2-second`), 'with its space, in the profile it began in');
  } finally {
    profiles.setDefault('default');
  }
});

test('one profile\'s Chrome restarting leaves the other profile\'s tabs working', { skip }, async () => {
  const keep = await m.call('tabs', { action: 'open', url: `${base}/kept`, profile: 'home' });
  await work.quit(); // the profile (its pairing, its profile id) stays; a new extension lifetime comes back
  work = await launchChrome({ chrome: /** @type {string} */ (CHROME), profile: work.profile });
  assert.ok(await until(() => bridge.relay.profiles().filter((p) => p.online).length === 2, 30000), 'the first profile reconnects by itself');
  const read = await m.call('read', { tab: keep.head.tab });
  assert.equal(read.isError, false, read.text);
  assert.match(read.page ?? '', /hello \/kept/);
});
