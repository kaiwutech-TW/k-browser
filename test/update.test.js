// @ts-check
// `k-browser update` against real git repositories in a temp folder; npm, launchd and the bridge are stand-ins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { update, UpdateError } from '../src/update.js';
import { ServiceError } from '../src/launchd.js';

// no user or system git settings (pull.rebase, hooks, signing) in these repositories
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });

/** @param {string} cwd @param {...string} args */
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** @param {string} dir @param {string} version @param {string} [lock] */
function write(dir, version, lock = 'lock-1') {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'k-browser', version }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), lock);
}

/** A remote, a second clone that publishes to it, and the user's clone (root) with node_modules in place. */
function repos() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-update-'));
  const remote = path.join(tmp, 'remote.git');
  const dev = path.join(tmp, 'dev');
  const root = path.join(tmp, 'root');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  git(tmp, 'clone', '-q', remote, dev);
  write(dev, '1.0.0');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-qm', 'one');
  git(dev, 'push', '-q', 'origin', 'HEAD:main');
  git(tmp, 'clone', '-q', remote, root);
  fs.mkdirSync(path.join(root, 'node_modules'));
  /** @param {string} version @param {string} [lock] */
  const publish = (version, lock) => {
    write(dev, version, lock);
    git(dev, 'commit', '-qam', version);
    git(dev, 'push', '-q', 'origin', 'HEAD:main');
  };
  return { tmp, root, publish };
}

/**
 * Stand-ins: npm calls are recorded; the bridge answers `running` until the service restarts it, then `to`.
 * @param {{ running?: string | null, loaded?: boolean, restartFails?: boolean }} [o]
 */
function world({ running = '1.0.0', loaded = true, restartFails = false } = {}) {
  /** @type {string[][]} */ const npm = [];
  /** @type {string[]} */ const said = [];
  let version = running;
  let restarts = 0;
  /** @type {import('../src/update.js').Run} */
  const run = (cmd, args, cwd) => {
    if (cmd === 'npm') { npm.push(args); return { status: 0, stdout: '', stderr: '' }; }
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  /** @param {string} root */
  const opts = (root) => ({
    root, port: 1, run, say: (/** @type {string} */ s) => said.push(s), waitMs: 500,
    service: {
      status: () => ({ loaded }),
      restart: () => {
        if (restartFails) throw new ServiceError('bridge: launchd already has a job that does not run this K-Browser\'s bridge');
        restarts += 1;
        version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
      },
    },
    probe: async () => (version === null ? { kind: /** @type {const} */ ('free') } : { kind: /** @type {const} */ ('bridge'), health: { version } }),
  });
  return { npm, said, opts, restarts: () => restarts };
}

test('a new version: pulled, npm ci (never install, which could rewrite the lock file), the bridge restarted, then ↻ the extension', async () => {
  const { root, publish } = repos();
  publish('1.1.0');
  const w = world();
  const r = await update(w.opts(root));
  assert.deepEqual(r, { from: '1.0.0', to: '1.1.0', pulled: true, installed: true, restarted: true });
  assert.deepEqual(w.npm, [['ci', '--no-audit', '--no-fund']]);
  assert.equal(w.restarts(), 1);
  assert.ok(w.said.includes('K-Browser 1.0.0 -> 1.1.0'));
  assert.match(w.said.at(-1) ?? '', /chrome:\/\/extensions/);
});

test('nothing pulled but node_modules missing: npm ci', async () => {
  const { root } = repos();
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
  const w = world();
  assert.equal((await update(w.opts(root))).installed, true);
  assert.deepEqual(w.npm, [['ci', '--no-audit', '--no-fund']]);
});

test('already up to date and the bridge on that version: nothing restarted, no reminder', async () => {
  const { root } = repos();
  const w = world();
  const r = await update(w.opts(root));
  assert.deepEqual(r, { from: '1.0.0', to: '1.0.0', pulled: false, installed: false, restarted: false });
  assert.equal(w.restarts(), 0);
  assert.deepEqual(w.said, ['git pull --ff-only', 'already at the newest commit (1.0.0)']);
  assert.deepEqual(w.npm, []);
});

test('pulled by hand earlier, bridge still on the old version: update restarts it', async () => {
  const { root, publish } = repos();
  publish('1.1.0');
  git(root, 'pull', '-q', '--ff-only');
  const w = world({ running: '1.0.0' });
  const r = await update(w.opts(root));
  assert.equal(r.pulled, false);
  assert.equal(r.restarted, true);
});

test('local changes to tracked files: refused, nothing pulled', async () => {
  const { root, publish } = repos();
  publish('1.1.0');
  const head = git(root, 'rev-parse', 'HEAD');
  fs.appendFileSync(path.join(root, 'package-lock.json'), 'mine');
  const w = world();
  await assert.rejects(update(w.opts(root)), (e) => e instanceof UpdateError && /local changes/.test(e.message) && /package-lock\.json/.test(e.message));
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(w.restarts(), 0);
});

test('untracked files do not stop an update', async () => {
  const { root, publish } = repos();
  publish('1.1.0');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'mine');
  assert.equal((await update(world().opts(root))).pulled, true);
});

test('a branch with commits of its own: pull --ff-only fails, said plainly, HEAD unchanged', async () => {
  const { root, publish } = repos();
  publish('1.1.0');
  fs.writeFileSync(path.join(root, 'extra.txt'), 'x');
  git(root, 'add', 'extra.txt');
  git(root, 'commit', '-qm', 'mine');
  const head = git(root, 'rev-parse', 'HEAD');
  const w = world();
  await assert.rejects(update(w.opts(root)), (e) => e instanceof UpdateError && /git pull failed \(nothing was changed\)/.test(e.message));
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(w.restarts(), 0);
});

test('a branch that tracks nothing: refused before pulling', async () => {
  const { root } = repos();
  git(root, 'checkout', '-qb', 'local');
  await assert.rejects(update(world().opts(root)), (e) => e instanceof UpdateError && /does not track a remote branch/.test(e.message));
});

test('not a git clone (a downloaded zip): pointed at the releases page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-update-zip-'));
  write(dir, '1.0.0');
  await assert.rejects(update(world().opts(dir)), (e) => e instanceof UpdateError && /not a git clone/.test(e.message) && /releases/.test(e.message));
});

test('a folder inside some other git repository is not taken for a clone of K-Browser', async () => {
  const { root } = repos();
  const inner = path.join(root, 'sub');
  fs.mkdirSync(inner);
  write(inner, '1.0.0');
  await assert.rejects(update(world().opts(inner)), (e) => e instanceof UpdateError && /not a git clone/.test(e.message));
});

test('a bridge started by hand is never stopped: told to restart it', async () => {
  const { root, publish } = repos();
  publish('1.1.0');
  const w = world({ loaded: false });
  const r = await update(w.opts(root));
  assert.equal(r.restarted, false);
  assert.ok(w.said.some((s) => /started by hand runs 1\.0\.0/.test(s)));
});

test('a LaunchAgent that is not this checkout\'s: updated, the refusal passed on', async () => {
  const { root, publish } = repos();
  publish('1.1.0');
  await assert.rejects(update(world({ restartFails: true }).opts(root)),
    (e) => e instanceof UpdateError && /updated, but the bridge was not restarted: bridge: launchd already has a job/.test(e.message));
});
