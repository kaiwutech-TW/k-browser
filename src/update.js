// @ts-check
// `k-browser update`: bring this checkout up to date and put the new version to work.
//
//   git pull --ff-only   refused when tracked files have local changes, or the branch tracks nothing
//   npm ci               after every pull (every version bump changes package.json and the lock file, so "did the
//                        packages change" is not worth guessing), or when node_modules is missing; ci, not install, so
//                        the lock file is never rewritten (a changed tracked file would stop the next update)
//   service restart      the LaunchAgent's bridge, when it runs a version other than the one now on disk
//
// The extension cannot be reloaded from here (Chrome does not let a program reload an unpacked extension): the last
// line says to press ↻ at chrome://extensions. Agents follow a restarted bridge by themselves (the MCP relay).
// A folder that is not a git clone (a downloaded zip) is told where new releases are.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, ServiceError, serviceRestart, serviceStatus } from './launchd.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RELEASES = 'https://github.com/kaiwutech-TW/k-browser/releases';

export class UpdateError extends Error {}

/** @typedef {(cmd: string, args: string[], cwd: string) => { status: number | null, stdout: string, stderr: string }} Run */
/** @type {Run} */
const realRun = (cmd, args, cwd) => {
  // GIT_TERMINAL_PROMPT=0: a remote asking for a password fails instead of waiting on a prompt nobody sees
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 600000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
};

/** @param {string} root */
const versionAt = (root) => String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
/** @param {string} s */
const tail = (s) => s.trim().split('\n').slice(-8).join('\n');

/**
 * @param {{ root?: string, port: number, run?: Run, say?: (s: string) => void,
 *   service?: { status: () => { loaded: boolean }, restart: () => void }, probe?: typeof probePort, waitMs?: number }} o
 * @returns {Promise<{ from: string, to: string, pulled: boolean, installed: boolean, restarted: boolean }>}
 */
export async function update({ root = ROOT, port, run = realRun, say = (s) => console.log(s),
  service = { status: () => serviceStatus({ port }), restart: () => serviceRestart({ port, say: () => {} }) }, probe = probePort, waitMs = 15000 }) {
  const git = (/** @type {string[]} */ ...args) => run('git', args, root);
  const top = git('rev-parse', '--show-toplevel');
  if (top.status !== 0 || !samePath(top.stdout.trim(), root)) {
    throw new UpdateError(`${root} is not a git clone (a downloaded zip?): download the new release from ${RELEASES}, `
      + 'replace this folder with it, run `npm install` there, then `k-browser service restart`');
  }
  const dirty = git('status', '--porcelain', '--untracked-files=no');
  if (dirty.status !== 0) throw new UpdateError(`git status failed: ${tail(dirty.stderr)}`);
  if (dirty.stdout.trim()) {
    throw new UpdateError(`files in ${root} have local changes; commit or stash them (\`git stash\`), then run update again:\n${tail(dirty.stdout)}`);
  }
  if (git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}').status !== 0) {
    throw new UpdateError('this branch does not track a remote branch, so there is nothing to pull from (`git branch -u origin/main` sets one)');
  }
  const from = versionAt(root);
  const before = git('rev-parse', 'HEAD').stdout.trim();
  say('git pull --ff-only');
  const pull = git('pull', '--ff-only');
  if (pull.status !== 0) {
    throw new UpdateError(`git pull failed (nothing was changed): ${tail(pull.stderr || pull.stdout)}\n`
      + 'if your branch has commits of its own, merge or rebase it yourself, then run update again');
  }
  const after = git('rev-parse', 'HEAD').stdout.trim();
  const pulled = after !== before;
  const to = versionAt(root);
  say(pulled ? `K-Browser ${from} -> ${to}` : `already at the newest commit (${to})`);

  let installed = false;
  if (pulled || !fs.existsSync(path.join(root, 'node_modules'))) {
    say('npm ci');
    const r = run('npm', ['ci', '--no-audit', '--no-fund'], root);
    if (r.status !== 0) {
      throw new UpdateError(`npm ci failed: ${tail(r.stderr || r.stdout)}\nthe code is updated but not its packages: `
        + `run \`npm ci\` in ${root}, then \`k-browser service restart\``);
    }
    installed = true;
  }

  const running = await probe(port);
  const runningVersion = running.kind === 'bridge' ? String(running.health.version) : null;
  let restarted = false;
  if (runningVersion !== to) {
    if (service.status().loaded) {
      try {
        service.restart();
      } catch (e) {
        throw new UpdateError(`updated, but the bridge was not restarted: ${e instanceof ServiceError || e instanceof Error ? e.message : String(e)}`);
      }
      const end = Date.now() + waitMs;
      let now = null;
      while (Date.now() < end) {
        const p = await probe(port);
        if (p.kind === 'bridge' && p.health.version === to) { now = to; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!now) throw new UpdateError(`the bridge was restarted but does not answer as ${to} yet: see \`k-browser doctor\``);
      say(`bridge restarted (${to})`);
      restarted = true;
    } else if (runningVersion) {
      say(`the bridge you started by hand runs ${runningVersion}: stop it and start \`k-browser bridge\` again`);
    } else {
      say('the bridge is not running: `k-browser service install` runs it at login');
    }
  }
  if (pulled || restarted) {
    say('now press ↻ on K-Browser at chrome://extensions, in each Chrome profile that has it; agents follow by themselves '
      + '(one started before 0.5.0 needs reconnecting once). `k-browser doctor` checks everything.');
  }
  return { from, to, pulled, installed, restarted };
}

/** @param {string} a @param {string} b */
function samePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}
