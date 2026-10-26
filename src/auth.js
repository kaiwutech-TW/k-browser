// @ts-check
// Secrets on disk: the extension pairing key and one named token per client.
//
// Layout under ~/.k-browser (KBROWSER_HOME): pair.key, profile.id, clients/<name>.json. Directories 0700,
// files 0600. A client record holds its token and a principal id that is never reused: removing a client and
// adding one with the same name yields a new principal, so the new client inherits nothing the old one owned.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** @typedef {{ id: string, name: string }} Principal */

export function home() {
  return process.env.KBROWSER_HOME || path.join(os.homedir(), '.k-browser');
}

/** @param {string} dir */
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Atomic write, readable only by the user. @param {string} file @param {string} text */
export function writePrivate(file, text) {
  privateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** @param {number} n */
const token = (n) => randomBytes(n).toString('base64url');

// ---------- pairing key (long-lived, shared with the extension) ----------

/** The secret shared with the extension; null when unpaired and neither create nor rotate is set.
 * @param {{ create?: boolean, rotate?: boolean }} [opts] */
export function pairKey({ create = false, rotate = false } = {}) {
  const file = path.join(home(), 'pair.key');
  if (fs.existsSync(file) && !rotate) return fs.readFileSync(file, 'utf8').trim();
  if (!create && !rotate) return null;
  const key = token(32);
  writePrivate(file, key);
  return key;
}

export const profileFile = () => path.join(home(), 'profile.id');

/** Constant-time string comparison (any characters; lengths may differ). @param {string} a @param {unknown} b */
export function safeEqual(a, b) {
  if (typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------- clients ----------

const clientsDir = () => path.join(home(), 'clients');

/** @param {string} name */
export const validName = (name) => NAME.test(name);

/** Create the client if needed and return its token. @param {string} name */
export function addClient(name) {
  if (!validName(name)) throw new Error("client name: lowercase letters, digits, '-' or '_', at most 32 chars");
  const file = path.join(clientsDir(), `${name}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).token;
  const rec = { token: token(24), principal: randomBytes(12).toString('hex') };
  writePrivate(file, JSON.stringify(rec));
  return rec.token;
}

/** @param {string} name */
export function removeClient(name) {
  const file = path.join(clientsDir(), `${name}.json`);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/** name -> record. An unreadable or malformed file counts as absent (its connections get revoked); others are unaffected.
 * @returns {Map<string, { token: string, principal: string }>} */
function records() {
  const out = new Map();
  let files = [];
  try {
    files = fs.readdirSync(clientsDir()).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(clientsDir(), f), 'utf8'));
      if (rec && typeof rec === 'object' && typeof rec.token === 'string' && typeof rec.principal === 'string') {
        out.set(f.slice(0, -5), rec);
      }
    } catch {
      // skip this one only
    }
  }
  return out;
}

/** A client's whole record (token, principal, and settings such as its site policy), or null.
 * @param {string} name @returns {Record<string, any> | null} */
export function clientRecord(name) {
  if (!validName(name)) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(clientsDir(), `${name}.json`), 'utf8'));
    return rec && typeof rec === 'object' && typeof rec.token === 'string' ? rec : null;
  } catch {
    return null;
  }
}

/** Change a client's settings (its site policy...). Its token and principal never change this way.
 * @param {string} name @param {Record<string, unknown>} patch */
export function updateClient(name, patch) {
  const rec = clientRecord(name);
  if (!rec) throw new Error(`no client ${JSON.stringify(name)}`);
  const { token: _t, principal: _p, ...settings } = patch;
  writePrivate(path.join(clientsDir(), `${name}.json`), JSON.stringify({ ...rec, ...settings, token: rec.token, principal: rec.principal }));
}

/** The name a principal id is on disk under now, or null (removed, or the name now holds another principal).
 * @param {string} principal */
export function clientNameOf(principal) {
  for (const [name, rec] of records()) if (rec.principal === principal) return name;
  return null;
}

/** name -> token */
export function clients() {
  return new Map([...records()].map(([name, rec]) => [name, rec.token]));
}

/** Principal ids that currently exist. */
export function principals() {
  return new Set([...records().values()].map((r) => r.principal));
}

/** The client owning tok, compared in constant time over all clients. @param {string} tok @returns {Principal | null} */
export function principalFor(tok) {
  /** @type {Principal | null} */
  let found = null;
  for (const [name, rec] of records()) {
    if (safeEqual(rec.token, tok)) found = { id: rec.principal, name };
  }
  return found;
}
