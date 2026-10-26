// @ts-check
// The file area: ~/.k-browser/files/<principal>/ (0700), the only place a client downloads
// to or uploads from. It is named by the client's principal, never its name: a client removed and added again under the
// same name gets a new principal and none of the old one's files (src/auth.js). Paths are always decided here, from a plain file name: no absolute path, no "..", no separator; a
// file that is a symbolic link, has other hard links or is not ours is never used (BeatBrowser's
// upload read any local file and savePath wrote anywhere).

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as auth from './auth.js';

export const MAX_DOWNLOAD = 25 * 1024 * 1024;

export class FilesError extends Error {}

/** A client's file area, created private; a link in its place is refused. @param {string} principal */
export function areaOf(principal) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(principal)) throw new FilesError('bad principal');
  const root = path.join(auth.home(), 'files');
  const dir = path.join(root, principal);
  for (const d of [root, dir]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(d);
    if (!st.isDirectory() || st.uid !== process.getuid?.()) throw new FilesError(`${d} is not a directory of ours: left alone`);
    fs.chmodSync(d, 0o700);
  }
  return dir;
}

/** A plain file name, or an error. @param {unknown} name */
export function plainName(name) {
  if (typeof name !== 'string' || !name || name.length > 200 || name === '.' || name === '..' || /[/\\\0]/.test(name) || name.startsWith('.')) {
    throw new FilesError('name: a plain file name from files list (no path, not starting with a dot)');
  }
  return name;
}

/** The files in a client's area: regular files of ours with one link only. @param {string} principal */
export function list(principal) {
  const dir = areaOf(principal);
  return fs.readdirSync(dir).flatMap((name) => {
    const st = fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false });
    return st && st.isFile() && st.nlink === 1 && !name.startsWith('.') ? [{ name, size: st.size }] : [];
  });
}

/**
 * The absolute path of an existing file in the area, for an upload — only a regular file of ours with one link, inside
 * the area once links are resolved. @param {string} principal @param {unknown} name
 */
export function existing(principal, name) {
  const dir = areaOf(principal);
  const file = path.join(dir, plainName(name));
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st) throw new FilesError(`no file ${name} in your file area (see files list)`);
  if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.()) throw new FilesError(`${name} is not a plain file of yours: not used`);
  if (path.dirname(fs.realpathSync(file)) !== fs.realpathSync(dir)) throw new FilesError(`${name} is outside your file area`);
  return file;
}

/** A name for a download: a random prefix and a cleaned-up name. @param {string} wanted */
export function downloadName(wanted) {
  const clean = String(wanted).normalize('NFC').replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^[.\s]+/, '').slice(-120) || 'download';
  return `${randomBytes(4).toString('hex')}-${clean}`;
}

/** Write a new file in the area, exclusively (never over anything), 0600; removed again if writing fails. @param {string} principal @param {string} name @param {Buffer[]} chunks */
export function writeNew(principal, name, chunks) {
  const file = path.join(areaOf(principal), plainName(name));
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    for (const c of chunks) fs.writeSync(fd, c);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  return file;
}
