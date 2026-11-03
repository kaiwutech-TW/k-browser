// @ts-check
// The Chrome profiles paired with this bridge: ~/.k-browser/profiles.json.
//
// A profile's identity for clients is its context (`kb-` + 8 hex digits, the CDP browserContextId of its tabs): given
// once when it pairs, kept when it is renamed, and never given out again once the profile is removed, so a context a
// client kept can only ever mean the profile it meant or nothing. The name is for people: shown, and looked up.
//
// A profileId (the extension's own random id) that is not on the list joins only when the user just pressed Pair in
// that profile's popup (hello.pairing); an extension reconnecting by itself, after `profile remove` say, is refused.
// Every read-change-write runs under profiles.lock: the bridge (pairing) and the CLI (rename, remove) both write it.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as auth from './auth.js';
import { withFileLock } from './filelock.js';

/** A profile name: letters (any script), digits, _ and -, 1 to 32 of them. */
export const NAME = /^[\p{L}\p{N}_-]{1,32}$/u;
export const FIRST_NAME = 'default';
/** The context of the profile paired before 0.6.0 (profile.id): what K-Browser called its one browser context then
 * ('k-browser-default') names this one. */
export const LEGACY_CONTEXT = 'kb-legacy';

/** @typedef {{ id: string, context: string, name: string, pairedAt: string }} Profile */
/** @typedef {{ default: string | null, profiles: Profile[], retired: string[], retiredContexts: string[] }} Registry */

export class ProfileError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const file = () => path.join(auth.home(), 'profiles.json');

/** @param {any} x @returns {Registry} */
function clean(x) {
  /** @type {Profile[]} */
  const profiles = (Array.isArray(x?.profiles) ? x.profiles : []).filter((/** @type {any} */ p) => typeof p?.id === 'string' && typeof p.context === 'string'
    && typeof p.name === 'string').map((/** @type {any} */ p) => ({ id: p.id, context: p.context, name: p.name, pairedAt: String(p.pairedAt ?? '') }));
  const strings = (/** @type {any} */ a) => (Array.isArray(a) ? a.filter((s) => typeof s === 'string') : []);
  const d = typeof x?.default === 'string' && profiles.some((p) => p.context === x.default) ? x.default : profiles[0]?.context ?? null;
  return { default: d, profiles, retired: strings(x?.retired), retiredContexts: strings(x?.retiredContexts) };
}

/** The registry as it is on disk (a profile.id from before 0.6.0 reads as its one profile). @returns {Registry} */
export function read() {
  try {
    return clean(JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch (e) {
    if (/** @type {any} */ (e).code !== 'ENOENT') throw new ProfileError('profiles_unreadable', `${file()} cannot be read: fix or remove it`);
  }
  const old = fs.existsSync(auth.profileFile()) ? fs.readFileSync(auth.profileFile(), 'utf8').trim() : '';
  if (!old) return clean({});
  const context = LEGACY_CONTEXT;
  return clean({ default: context, profiles: [{ id: old, context, name: FIRST_NAME, pairedAt: '' }] });
}

/**
 * Read, change and write the registry under its lock; fn returns what to hand back. The profile.id of an older
 * version is folded in (and removed) on the first write.
 * @template T @param {(r: Registry) => T} fn @returns {T}
 */
export function update(fn) {
  return withFileLock(path.join(auth.home(), 'profiles.lock'), () => {
    const r = read();
    const out = fn(r);
    const fixed = clean(r);
    auth.writePrivate(file(), `${JSON.stringify(fixed, null, 2)}\n`);
    fs.rmSync(auth.profileFile(), { force: true });
    return out;
  }, (st) => new ProfileError('profiles_busy', st === 'left'
    ? `the profile list is locked by a k-browser that is no longer running: once none is changing profiles, remove ${path.join(auth.home(), 'profiles.lock')}`
    : 'the profile list is busy (another k-browser is changing it): try again'));
}

/** A new context: never one in use or retired. @param {Registry} r */
function newContext(r) {
  for (;;) {
    const c = `kb-${randomBytes(4).toString('hex')}`;
    if (!r.profiles.some((p) => p.context === c) && !r.retiredContexts.includes(c)) return c;
  }
}

/** @param {Registry} r @param {string} name */
const byName = (r, name) => r.profiles.find((p) => p.name.toLowerCase() === name.toLowerCase());

/**
 * Who an extension is: its profile on the list, or (pairing: the user just pressed Pair) a new one under the name it
 * asked for. Throws ProfileError profile_unknown / profile_name_taken / profile_name_invalid.
 * @param {{ profileId: string, pairing?: unknown, profileName?: unknown }} hello @returns {Profile & { added: boolean }}
 */
export function admit({ profileId, pairing, profileName }) {
  const known = read().profiles.find((p) => p.id === profileId);
  if (known) return { ...known, added: false };
  if (pairing !== true) {
    throw new ProfileError('profile_unknown', 'this Chrome profile is not on K-Browser\'s list (removed, or never paired): pair it again from the K-Browser popup');
  }
  return update((r) => {
    const again = r.profiles.find((p) => p.id === profileId);
    if (again) return { ...again, added: false };
    const name = typeof profileName === 'string' && profileName.trim() ? profileName.trim() : r.profiles.length ? '' : FIRST_NAME;
    if (!NAME.test(name)) throw new ProfileError('profile_name_invalid', 'give this Chrome profile a name: up to 32 letters, digits, _ or -');
    if (byName(r, name)) throw new ProfileError('profile_name_taken', `another Chrome profile is already called ${JSON.stringify(name)}: choose another name`);
    const p = { id: profileId, context: newContext(r), name, pairedAt: new Date().toISOString() };
    r.profiles.push(p);
    r.retired = r.retired.filter((id) => id !== profileId);
    if (!r.default) r.default = p.context;
    return { ...p, added: true };
  });
}

/** @param {string} from @param {string} to */
export function rename(from, to) {
  if (!NAME.test(to)) throw new ProfileError('profile_name_invalid', 'a profile name is up to 32 letters, digits, _ or -');
  update((r) => {
    const p = byName(r, from);
    if (!p) throw new ProfileError('profile_not_found', `no profile ${JSON.stringify(from)}: see \`k-browser profile list\``);
    const other = byName(r, to);
    if (other && other !== p) throw new ProfileError('profile_name_taken', `another profile is already called ${JSON.stringify(to)}`);
    p.name = to;
  });
}

/** Remove a profile: its id and context are retired (its extension reconnecting by itself is refused). @param {string} name */
export function remove(name) {
  return update((r) => {
    const p = byName(r, name);
    if (!p) throw new ProfileError('profile_not_found', `no profile ${JSON.stringify(name)}: see \`k-browser profile list\``);
    r.profiles = r.profiles.filter((x) => x !== p);
    r.retired.push(p.id);
    r.retiredContexts.push(p.context);
    if (r.default === p.context) r.default = r.profiles[0]?.context ?? null;
    return p;
  });
}

/** @param {string} name */
export function setDefault(name) {
  update((r) => {
    const p = byName(r, name);
    if (!p) throw new ProfileError('profile_not_found', `no profile ${JSON.stringify(name)}: see \`k-browser profile list\``);
    r.default = p.context;
  });
}
