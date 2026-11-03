// @ts-check
// A lock file around a read-change-write of shared files: several k-browser processes (the bridge, MCP servers, the
// CLI) write the same files, and an atomic rename alone keeps only the last of two concurrent changes.

import fs from 'node:fs';
import path from 'node:path';

const pause = (/** @type {number} */ ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Why a lock file is not being let go: its holder is alive (busy), or the process named in it is gone (left behind by a
 * crash). Never taken over: a file system has no "remove it only if it is still that file", so clearing a lock judged
 * stale can remove a newer holder's and let two writers in: the feature is narrowed instead of
 * guessing. @param {string} file @returns {'busy' | 'left' | 'gone' | 'unreadable'} */
function lockState(file) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) return Date.now() - fs.statSync(file).mtimeMs > 10_000 ? 'left' : 'busy';
    try {
      process.kill(pid, 0);
      return 'busy';
    } catch (e) {
      return /** @type {any} */ (e).code === 'ESRCH' ? 'left' : 'busy';
    }
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') return 'gone'; // let go meanwhile: just try again
    return 'unreadable'; // not ours to judge (permissions changed by hand): reported once the wait is over
  }
}

/**
 * Run fn holding the lock file; a busy lock is waited for (up to 5 s), then error(state) is thrown.
 * @template T @param {string} file @param {() => T} fn @param {(state: 'busy' | 'left' | 'unreadable') => Error} error @returns {T}
 */
export function withFileLock(file, fn, error) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const until = Date.now() + 5000;
  let mine;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      mine = fs.fstatSync(fd).ino;
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'EEXIST') throw e;
      const st = lockState(file);
      if (st === 'gone') continue;
      if (Date.now() > until) throw error(st);
      pause(5 + Math.random() * 20);
    }
  }
  try {
    return fn();
  } finally {
    // only our own lock (nobody else removes it, but a user may have by hand)
    if (fs.statSync(file, { throwIfNoEntry: false })?.ino === mine) fs.rmSync(file, { force: true });
  }
}
