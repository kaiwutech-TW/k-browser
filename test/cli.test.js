// @ts-check
// CLI commands that only change local settings, run as the user runs them (node src/cli.js …).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as auth from '../src/auth.js';

const CLI = new URL('../src/cli.js', import.meta.url).pathname;

test('client set --eval on|off: only that switch changes; token and principal stay; a client that does not exist is refused', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cli-'));
  process.env.KBROWSER_HOME = home;
  auth.addClient('codex');
  auth.updateClient('codex', { blockedOrigins: ['bank.example'] });
  const before = /** @type {any} */ (auth.clientRecord('codex'));
  /** @param {string[]} a */
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { env: { ...process.env, KBROWSER_HOME: home }, encoding: 'utf8' });
  const on = run('client', 'set', 'codex', '--eval', 'on');
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout, /eval on/);
  const rec = /** @type {any} */ (auth.clientRecord('codex'));
  assert.deepEqual([rec.eval, rec.token, rec.principal, rec.blockedOrigins], [true, before.token, before.principal, ['bank.example']]);
  assert.ok(!on.stdout.includes(before.token), 'the token is never printed');
  assert.equal(run('client', 'set', 'codex', '--eval', 'off').status, 0);
  assert.equal(/** @type {any} */ (auth.clientRecord('codex')).eval, false);
  assert.notEqual(run('client', 'set', 'nobody', '--eval', 'on').status, 0);
  assert.notEqual(run('client', 'set', 'codex', '--eval', 'yes').status, 0);
  assert.equal(/** @type {any} */ (auth.clientRecord('codex')).eval, false, 'a bad value changes nothing');
});

test('install with no terminal and no --block: refused, nothing written; --block "" goes ahead', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cli-'));
  // if the guard is gone, install must still reach no real agent: no `codex` on PATH, HOME a temporary folder
  const env = { KBROWSER_HOME: home, HOME: home, PATH: fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cli-path-')) };
  /** @param {string[]} a */
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const r = run('install', '--client', 'codex');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--block/);
  assert.ok(!fs.existsSync(path.join(home, 'clients')), 'no client created');
  const dry = run('install', '--client', 'codex', '--dry-run');
  assert.match(dry.stdout, /--block/, 'a dry run says so too');
  assert.ok(!fs.existsSync(path.join(home, 'clients')));
  const explicit = run('install', '--client', 'nonesuch', '--block', '');
  assert.ok(!/沒有終端機/.test(explicit.stderr), 'an explicit --block "" is an answer');
});

test('model: jev shows what is sent and needs an explicit consent without a terminal; the key is imported, never printed; kev withdraws', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cli-'));
  const env = { KBROWSER_HOME: home, HOME: home, PATH: process.env.PATH ?? '' };
  const key = 'jev-cli-key-0123456789abcdef';
  const envFile = path.join(home, '.env');
  fs.writeFileSync(envFile, `TYPESAFE_AI = ${key}`);
  /** @param {string[]} a */
  const run = (...a) => spawnSync(process.execPath, [CLI, 'model', ...a], { env, encoding: 'utf8', input: '' });
  const cfg = () => { try { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); } catch { return null; } };

  assert.equal(JSON.parse(run().stdout).backend, 'kev');
  const no = run('jev', '--key-env-file', envFile, '--key-var', 'TYPESAFE_AI');
  assert.equal(no.status, 2, no.stderr);
  assert.match(no.stdout, /會送出/);
  assert.equal(cfg(), null, 'no consent: nothing written');
  assert.ok(!fs.existsSync(path.join(home, 'jev.key')), 'nor the key');

  const yes = run('jev', '--consent', '--key-env-file', envFile, '--key-var', 'TYPESAFE_AI');
  assert.equal(yes.status, 0, yes.stderr);
  assert.ok(!(yes.stdout + yes.stderr).includes(key), 'the key is never printed');
  assert.equal(cfg().model.backend, 'jev');
  assert.equal(cfg().model.consent.version, 1);
  assert.equal(fs.readFileSync(path.join(home, 'jev.key'), 'utf8').trim(), key);
  const shown = run();
  assert.deepEqual(JSON.parse(shown.stdout), { backend: 'jev', consent_at: cfg().model.consent.at, key_set: true });
  assert.ok(!shown.stdout.includes(key));

  assert.equal(run('kev').status, 0);
  assert.deepEqual(cfg().model, { backend: 'kev' }, 'leaving JEV withdraws the consent');
  assert.equal(run('kev', '--url', 'https://x.example').status, 1, 'only a local Kev');
  fs.writeFileSync(path.join(home, 'config.json'), '{');
  assert.equal(run('off').status, 1, 'an unreadable config is not overwritten');
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), '{');
  assert.equal(JSON.parse(run().stdout).problem, 'config_unreadable');
});

test('kav <dir>: only a Kav checkout with its .venv; off removes it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cli-'));
  const env = { KBROWSER_HOME: home, HOME: home, PATH: process.env.PATH ?? '' };
  /** @param {string[]} a */
  const run = (...a) => spawnSync(process.execPath, [CLI, 'kav', ...a], { env, encoding: 'utf8' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-kav-'));
  assert.equal(run(dir).status, 1, 'no .venv');
  fs.mkdirSync(path.join(dir, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.venv', 'bin', 'python'), '');
  assert.equal(run(dir).status, 1, 'no kfw/');
  fs.mkdirSync(path.join(dir, 'kfw'));
  assert.equal(run(dir).status, 0);
  assert.equal(run().stdout.trim(), dir);
  assert.equal(run('off').status, 0);
  assert.equal(run().stdout.trim(), '(not set)');
});
