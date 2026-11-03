// @ts-check
// Several Chrome profiles on one bridge: the list (profiles.js), each profile's own link, tabs that never mix even
// where two profiles' tab ids are the same number, and what removing, renaming and pairing again do.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import * as auth from '../src/auth.js';
import * as profiles from '../src/profiles.js';
import { startBridge } from '../src/server.js';
import { FakeCdp, FakeExtension, OPEN, until } from './fakes.js';

/** @type {Awaited<ReturnType<typeof startBridge>>} */
let bridge;

beforeEach(async () => {
  process.env.KBROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-prof-'));
  bridge = await startBridge({ port: 0, revokePollMs: 50, log: () => {} });
});

afterEach(async () => {
  while (OPEN.length) await /** @type {any} */ (OPEN.pop()).close();
  await bridge.close();
});

const key = () => /** @type {string} */ (auth.pairKey({ create: true }));

/** @param {string} profile @param {string} name @param {Partial<ConstructorParameters<typeof FakeExtension>[2]>} [o] */
async function pair(profile, name, o = {}) {
  const ext = new FakeExtension(bridge.base, key(), { profile, profileName: name, boot: `boot-${profile}`, ...o });
  assert.ok(await ext.connect(), JSON.stringify(ext.error));
  return ext;
}

/** until() for an async condition. @param {() => Promise<boolean>} pred */
async function eventually(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

/** The context of a profile by name. @param {string} name */
const ctx = (name) => /** @type {string} */ (profiles.read().profiles.find((p) => p.name === name)?.context);

/** Both profiles online, a client connected. */
async function two() {
  const a = await pair('profile-aaaaaaaa', 'work');
  const b = await pair('profile-bbbbbbbb', 'home');
  assert.ok(await until(() => bridge.relay.profiles().every((p) => p.online)));
  const cdp = await new FakeCdp(bridge.base, auth.addClient('agent')).connect();
  return { a, b, cdp };
}

test('a profile.id from before 0.6.0 becomes the profile "default", and the file goes on the first change', () => {
  fs.writeFileSync(auth.profileFile(), 'profile-legacy00');
  const r = profiles.read();
  assert.deepEqual(r.profiles.map((p) => [p.id, p.name]), [['profile-legacy00', 'default']]);
  assert.equal(r.default, r.profiles[0].context);
  assert.equal(profiles.admit({ profileId: 'profile-legacy00' }).added, false, 'already known: no pairing needed');
  profiles.rename('default', 'work');
  assert.equal(fs.existsSync(auth.profileFile()), false);
  assert.equal(profiles.read().profiles[0].context, r.profiles[0].context, 'the same context');
});

test('two profiles at once: each its own context; a tab opens where the client says, else in the default', async () => {
  const { a, b, cdp } = await two();
  const contexts = (await cdp.call('Target.getBrowserContexts')).browserContextIds;
  assert.deepEqual(contexts.sort(), [ctx('work'), ctx('home')].sort());
  const inHome = await cdp.call('Target.createTarget', { url: 'https://example.com/', browserContextId: ctx('home') });
  const inDefault = await cdp.call('Target.createTarget', { url: 'https://example.org/' });
  assert.deepEqual([inHome.browserContextId, inDefault.browserContextId], [ctx('home'), ctx('work')], 'the answer says where it opened');
  assert.equal(b.calls.filter(([op]) => op === 'tabs.create').length, 1, 'home got one create');
  assert.equal(a.calls.filter(([op]) => op === 'tabs.create').length, 1, 'work (the default: paired first) got the other');
  const infos = (await cdp.call('Target.getTargets')).targetInfos;
  assert.equal(infos.find((/** @type {any} */ t) => t.targetId === inHome.targetId).browserContextId, ctx('home'));
  assert.equal(infos.find((/** @type {any} */ t) => t.targetId === inDefault.targetId).browserContextId, ctx('work'));
  const named = (await cdp.call('KBrowser.profiles')).profiles;
  assert.deepEqual(named.map((/** @type {any} */ p) => [p.name, p.online, p.default]).sort(), [['home', true, false], ['work', true, true]]);
  await assert.rejects(cdp.call('Target.createTarget', { url: 'https://example.com/', browserContextId: 'kb-nope' }), /no browser context/);
});

test('the same tab id in two profiles: events, closing and sessions never cross', async () => {
  const { a, b, cdp } = await two();
  const ta = await cdp.call('Target.createTarget', { url: 'https://a.example/', browserContextId: ctx('work') });
  const tb = await cdp.call('Target.createTarget', { url: 'https://b.example/', browserContextId: ctx('home') });
  assert.deepEqual([[...a.owned], [...b.owned]], [[100], [100]], 'both extensions call it tab 100');
  const { sessionId: sa } = await cdp.call('Target.attachToTarget', { targetId: ta.targetId, flatten: true });
  const { sessionId: sb } = await cdp.call('Target.attachToTarget', { targetId: tb.targetId, flatten: true });
  a.event('dbg.event', { tabId: 100, method: 'Page.loadEventFired', params: { timestamp: 1 } });
  assert.ok(await until(() => cdp.events.some((e) => e.method === 'Page.loadEventFired')));
  assert.deepEqual(cdp.events.filter((e) => e.method === 'Page.loadEventFired').map((e) => e.sessionId), [sa], 'only work\'s session hears it');
  await cdp.call('Runtime.evaluate', { expression: '1' }, sb);
  assert.ok(b.calls.some(([op, x]) => op === 'dbg.send' && x.tabId === 100) && !a.calls.some(([op, x]) => op === 'dbg.send' && x.method === 'Runtime.evaluate'));
  b.event('tab.removed', { tabId: 100 });
  assert.ok(await eventually(async () => (await cdp.call('Target.getTargets')).targetInfos.length === 1));
  assert.equal((await cdp.call('Target.getTargets')).targetInfos[0].targetId, ta.targetId, 'work\'s tab 100 is still there');
});

test('one profile\'s extension restarting drops only its own tabs and hand-offs', async () => {
  const { a, b, cdp } = await two();
  const ta = await cdp.call('Target.createTarget', { url: 'https://a.example/', browserContextId: ctx('work') });
  const tb = await cdp.call('Target.createTarget', { url: 'https://b.example/', browserContextId: ctx('home') });
  const h = await cdp.call('KBrowser.handoff', { targetId: tb.targetId, reason: 'sign in' });
  assert.ok(await until(() => b.handoffs.length === 1) && a.handoffs.length === 0, 'the hand-off shows only in its own profile');
  await a.close();
  await pair('profile-aaaaaaaa', 'work', { boot: 'boot-restarted', pairing: false });
  assert.ok(await eventually(async () => (await cdp.call('Target.getTargets')).targetInfos.length === 1));
  assert.equal((await cdp.call('Target.getTargets')).targetInfos[0].targetId, tb.targetId);
  assert.equal((await cdp.call('KBrowser.handoffStatus', { handoffId: h.handoffId })).state, 'waiting', 'home\'s hand-off goes on');
  void ta;
});

test('pairing: a name in use (online or not) is refused, a bad name too; an unknown profile without Pair is refused', async () => {
  const a = await pair('profile-aaaaaaaa', 'work');
  await a.close();
  const taken = new FakeExtension(bridge.base, key(), { profile: 'profile-cccccccc', profileName: 'WORK' });
  assert.equal(await taken.connect(), false);
  assert.equal(taken.error.code, 'profile_name_taken', 'not "the same profile reinstalled": a profile offline may just be away');
  const bad = new FakeExtension(bridge.base, key(), { profile: 'profile-dddddddd', profileName: 'a b' });
  assert.equal(await bad.connect(), false);
  assert.equal(bad.error.code, 'profile_name_invalid');
  const empty = new FakeExtension(bridge.base, key(), { profile: 'profile-eeeeeeee' });
  assert.equal(await empty.connect(), false, 'the second profile needs a name');
  assert.equal(empty.error.code, 'profile_name_invalid');
});

test('removed: the profile is dropped at once, its own reconnect is refused; paired again it gets a new context, and the old one never means anything', async () => {
  const { b, cdp } = await two();
  const old = ctx('home');
  const tb = await cdp.call('Target.createTarget', { url: 'https://b.example/', browserContextId: old });
  const h = await cdp.call('KBrowser.handoff', { targetId: tb.targetId, reason: 'x' });
  profiles.remove('home');
  assert.ok(await until(() => b.ws.readyState === 3), 'its link closed within a poll');
  assert.equal((await cdp.call('KBrowser.handoffStatus', { handoffId: h.handoffId })).state, 'invalidated');
  assert.ok(await eventually(async () => (await cdp.call('Target.getTargets')).targetInfos.length === 0), 'its tabs let go');
  const again = new FakeExtension(bridge.base, key(), { profile: 'profile-bbbbbbbb', pairing: false });
  assert.equal(await again.connect(), false);
  assert.equal(again.error.code, 'profile_unknown');
  await pair('profile-bbbbbbbb', 'home');
  assert.notEqual(ctx('home'), old);
  await assert.rejects(cdp.call('Target.createTarget', { url: 'https://b.example/', browserContextId: old }), /removed/);
});

test('removed and paired again between two polls: the old registration goes all the same', async () => {
  await bridge.close();
  bridge = await startBridge({ port: 0, revokePollMs: 60_000, log: () => {} });
  const { b, cdp } = await two();
  const tb = await cdp.call('Target.createTarget', { url: 'https://b.example/', browserContextId: ctx('home') });
  profiles.remove('home');
  await b.close();
  await pair('profile-bbbbbbbb', 'home'); // same profileId, a new context: no poll in between
  assert.ok(await eventually(async () => !(await cdp.call('Target.getTargets')).targetInfos.some((/** @type {any} */ t) => t.targetId === tb.targetId)));
});

test('renamed: the same context keeps meaning the same profile, even once another takes the old name', async () => {
  const { a, cdp } = await two();
  const work = ctx('work');
  profiles.rename('work', 'office');
  assert.ok(await until(() => a.profileNameNow === 'office'), 'the extension is told');
  profiles.rename('home', 'work');
  await cdp.call('Target.createTarget', { url: 'https://a.example/', browserContextId: work });
  assert.equal(a.calls.filter(([op]) => op === 'tabs.create').length, 1, 'still the profile now called office');
});

test('an offline profile: creating a tab there says which profile is not connected', async () => {
  const { b, cdp } = await two();
  await b.close();
  assert.ok(await until(() => bridge.relay.profiles().some((p) => p.name === 'home' && !p.online)));
  await assert.rejects(cdp.call('Target.createTarget', { url: 'https://b.example/', browserContextId: ctx('home') }), /"home" is not connected/);
});

test('the panel: a command about another profile\'s tab goes to that profile; the answer to the panel that asked; return only in its own profile', async () => {
  const { a, b, cdp } = await two();
  const tb = await cdp.call('Target.createTarget', { url: 'https://b.example/', browserContextId: ctx('home') });
  const h = await cdp.call('KBrowser.handoff', { targetId: tb.targetId, reason: 'x' });
  a.event('panel.open');
  b.event('panel.open');
  assert.ok(await until(() => a.panel.length > 0 && b.panel.length > 0));
  const principal = /** @type {string} */ (auth.clientRecord('agent')?.principal);
  a.event('panel.cmd', { op: 'show', principal, targetId: tb.targetId });
  assert.ok(await until(() => b.shown.length === 1) && a.shown.length === 0, 'shown in home');
  a.event('panel.cmd', { op: 'return', principal, handoffId: h.handoffId });
  const results = () => a.panel.flatMap((/** @type {any} */ batch) => batch.updates).filter((/** @type {any} */ x) => x.type === 'result');
  assert.ok(await until(() => results().length === 2), JSON.stringify(a.panel));
  assert.deepEqual(results().map((/** @type {any} */ r) => r.ok), [true, false]);
  assert.match(results()[1].why, /another Chrome profile/);
  a.event('handoff.return', { handoffId: h.handoffId }); // a forged return from the other profile's popup
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await cdp.call('KBrowser.handoffStatus', { handoffId: h.handoffId })).state, 'waiting');
  a.event('panel.close');
  b.event('panel.cmd', { op: 'closeTabs', principal });
  assert.ok(await until(() => b.calls.some(([op]) => op === 'tabs.close')), 'home\'s panel still works with work\'s closed');
});

test('two processes changing the list at once: no change is lost', async () => {
  const script = (/** @type {number} */ n) => `import('${new URL('../src/profiles.js', import.meta.url).href}').then((p) => {
    for (let i = 0; i < 10; i++) p.admit({ profileId: 'p-${n}-' + i, pairing: true, profileName: 'n${n}x' + i });
  })`;
  const run = (/** @type {number} */ n) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', script(n)], { env: { ...process.env }, stdio: 'inherit' });
    c.once('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`exit ${code}`))));
  });
  await Promise.all([run(1), run(2)]);
  assert.equal(profiles.read().profiles.length, 20);
});

test('the context clients were told before 0.6.0 names the profile paired then, whichever profile is the default now', async () => {
  await bridge.close();
  fs.writeFileSync(auth.profileFile(), 'profile-legacy00');
  bridge = await startBridge({ port: 0, revokePollMs: 50, log: () => {} });
  const old = await pair('profile-legacy00', '', { pairing: false });
  const other = await pair('profile-bbbbbbbb', 'home');
  profiles.setDefault('home');
  assert.ok(await until(() => bridge.relay.registry.default === ctx('home')));
  const cdp = await new FakeCdp(bridge.base, auth.addClient('agent')).connect();
  await cdp.call('Target.createTarget', { url: 'https://a.example/', browserContextId: 'k-browser-default' });
  assert.equal(old.calls.filter(([op]) => op === 'tabs.create').length, 1, 'the profile it always meant');
  assert.equal(other.calls.filter(([op]) => op === 'tabs.create').length, 0);
  profiles.remove('default');
  assert.ok(await until(() => old.ws.readyState === 3));
  await assert.rejects(cdp.call('Target.createTarget', { url: 'https://a.example/', browserContextId: 'k-browser-default' }), /removed/);
});
