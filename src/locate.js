// @ts-check
// Where this copy of K-Browser runs from, and the fixed install that `npx k-browser install` makes.
//
//   app       <home>/app/node_modules/k-browser: the copy agents, the LaunchAgent and Chrome point at (absolute paths)
//   clone     a git checkout (developers, and installs made before npx): behaves as it always did
//   launcher  anything else (the npx cache, `npm i -g`, another project's node_modules). Its own path does not last
//             (npx's cache is cleared, a new version gets a new folder), so it never installs itself: `install` puts
//             the same version at <home>/app and runs install from there; every other command is handed to <home>/app.
//
// <home>/app is replaced in two renames (app -> app.old, app.staging -> app) under ~/.k-browser/install.lock; a run cut
// off between them is put right by recover() before the next staging or hand-over.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.js';

export const PACKAGE = 'k-browser';
/** This copy's package folder. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const appDir = () => path.join(auth.home(), 'app');
/** The installed package inside <home>/app. @param {string} [dir] */
export const appPackage = (dir = appDir()) => path.join(dir, 'node_modules', PACKAGE);
export const appCli = () => path.join(appPackage(), 'src', 'cli.js');

/** @param {string} p */
function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** @param {string} [root] @returns {'app' | 'clone' | 'launcher'} */
export function identity(root = ROOT) {
  const here = real(root);
  const home = real(auth.home());
  if (here && home && here === path.join(home, 'app', 'node_modules', PACKAGE)) return 'app';
  // a checkout's top has .git (a directory, or a file in a git worktree); npm never puts one in a package it installs
  if (fs.existsSync(path.join(root, '.git'))) return 'clone';
  return 'launcher';
}

/** @param {string} root */
export function versionAt(root) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
  } catch {
    return null;
  }
}

/**
 * Is <dir> a K-Browser install we may run: no symbolic links on the way (<dir>, its node_modules, the package), every
 * one of them ours, the package named k-browser with its cli.js and extension manifest? The reason when not.
 * @param {string} [dir] @returns {{ ok: true, version: string } | { ok: false, why: string }}
 */
export function usable(dir = appDir()) {
  const uid = process.getuid?.();
  for (const p of [dir, path.join(dir, 'node_modules'), appPackage(dir)]) {
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st) return { ok: false, why: `${p} is missing` };
    if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, why: `${p} is not a plain folder` };
    if (uid !== undefined && st.uid !== uid) return { ok: false, why: `${p} belongs to another user` };
  }
  const pkg = appPackage(dir);
  let name;
  try {
    name = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).name;
  } catch {
    return { ok: false, why: `${pkg}/package.json is unreadable` };
  }
  if (name !== PACKAGE) return { ok: false, why: `${pkg} holds ${JSON.stringify(name)}, not ${PACKAGE}` };
  for (const f of ['src/cli.js', 'extension/manifest.json']) {
    if (!fs.existsSync(path.join(pkg, f))) return { ok: false, why: `${pkg}/${f} is missing` };
  }
  return { ok: true, version: /** @type {string} */ (versionAt(pkg)) };
}

/** a.b.c compared as numbers: < 0, 0, > 0. @param {string} a @param {string} b */
export function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

export class AppError extends Error {}

/**
 * Put right a replacement that was cut off. Call with install.lock held.
 *   app missing, app.old there   -> app.old back to app (stopped after the first rename)
 *   app and app.old there        -> app.old removed (stopped before clean-up)
 *   app.staging there            -> removed (a staging never finished)
 * @param {(s: string) => void} [say]
 */
export function recover(say = () => {}) {
  const app = appDir();
  const old = `${app}.old`;
  const staging = `${app}.staging`;
  const has = (/** @type {string} */ p) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;
  if (!has(app) && has(old)) {
    fs.renameSync(old, app);
    say(`put back ${app} from an update that was cut off`);
  } else if (has(old)) {
    fs.rmSync(old, { recursive: true, force: true });
  }
  if (has(staging)) fs.rmSync(staging, { recursive: true, force: true });
}

/** Has K-Browser ever been put at <home>/app (even half: something to recover)? */
export const everInstalled = () => ['', '.old'].some((s) => fs.lstatSync(appDir() + s, { throwIfNoEntry: false }) !== undefined);

/** @typedef {(cmd: string, args: string[], cwd: string) => { status: number | null, stdout: string, stderr: string }} Run */
/** @type {Run} */
const realRun = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 600000 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
};

/** What to install: KBROWSER_PACKAGE_SPEC (a tarball, for tests and checks before publishing) or k-browser@<version>. @param {string} version */
export const specFor = (version) => process.env.KBROWSER_PACKAGE_SPEC || `${PACKAGE}@${version}`;

/**
 * Install <spec> into <home>/app.staging and check it. Call with install.lock held, after recover().
 * @param {string} spec @param {{ run?: Run, say?: (s: string) => void }} [o] @returns {string} the staged version
 */
export function stage(spec, { run = realRun, say = (s) => console.log(s) } = {}) {
  const staging = `${appDir()}.staging`;
  fs.mkdirSync(auth.home(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(staging, { mode: 0o700 });
  say(`npm install ${spec} (into ${appDir()})`);
  const r = run('npm', ['install', '--prefix', staging, '--no-audit', '--no-fund', '--omit=dev', spec], auth.home());
  if (r.status !== 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    const tail = (r.stderr || r.stdout).trim().split('\n').slice(-8).join('\n');
    throw new AppError(`npm install ${spec} failed (nothing was changed): ${tail}`);
  }
  const u = usable(staging);
  if (!u.ok) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new AppError(`npm installed ${spec}, but ${u.why} (nothing was changed)`);
  }
  return u.version;
}

/** Replace <home>/app with <home>/app.staging. Call with install.lock held. */
export function swapIn() {
  const app = appDir();
  const old = `${app}.old`;
  const had = fs.lstatSync(app, { throwIfNoEntry: false }) !== undefined;
  if (had) fs.renameSync(app, old);
  try {
    fs.renameSync(`${app}.staging`, app);
  } catch (e) {
    if (had) fs.renameSync(old, app);
    throw e;
  }
  if (had) fs.rmSync(old, { recursive: true, force: true });
}

/**
 * Run <home>/app's cli.js with these arguments, this terminal and these pipes (an agent's MCP stdio goes straight
 * through); its exit code, or 128 + the signal that ended it. SIGINT / SIGTERM / SIGHUP sent to us are passed on.
 * @param {string[]} argv @returns {Promise<number>}
 */
export function delegate(argv) {
  const child = spawn(process.execPath, [appCli(), ...argv], { stdio: 'inherit' });
  /** @type {NodeJS.Signals[]} */ const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  /** @type {Record<string, () => void>} */ const pass = {};
  for (const s of signals) process.on(s, (pass[s] = () => { child.kill(s); }));
  return new Promise((resolve) => {
    const done = (/** @type {number} */ code) => {
      for (const s of signals) process.off(s, pass[s]);
      resolve(code);
    };
    child.once('error', (e) => { console.error(`could not run ${appCli()}: ${e.message}`); done(1); });
    child.once('exit', (code, signal) => done(code ?? 128 + (signal ? os.constants.signals[signal] ?? 0 : 0)));
  });
}
