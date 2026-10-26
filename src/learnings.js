// @ts-check
// Site notes (learnings): what agents and the user learned about a site — its API, the
// walls, the pitfalls — kept on this machine, one file per domain: ~/.k-browser/learnings/<domain>.jsonl (0600).
//
// A note is text for reading, never an instruction, a setting or a step to run: agents get it inside the untrusted
// block, and repeatable steps belong in a Kav flow (run_flow), saved after a dry run and the user's confirmation
// (BeatBrowser's learnings taught the model to replay playbooks as written). The untrusted
// block and the import confirmation are a floor, not immunity to prompt injection.
//
// Notes are written in a shareable shape (domain, author, date, source, hash) so that `export` / `import` can move
// them between machines; a shared platform for them is a separate plan.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { domainToASCII } from 'node:url';
import * as auth from './auth.js';

export const KINDS = /** @type {const} */ (['api', 'wall', 'pitfall', 'tip']);
const MAX_NOTE = 2048;
const MAX_PER_DOMAIN = 200;

export class LearningsError extends Error {}

const dir = () => path.join(auth.home(), 'learnings');

/**
 * A host name in its canonical form (lowercase, IDN as punycode), or an error: no scheme, port, path, or "..".
 * @param {unknown} input
 */
export function normalizeDomain(input) {
  if (typeof input !== 'string' || !input.trim()) throw new LearningsError('domain: a host name, e.g. thsrc.com.tw');
  const raw = input.trim().toLowerCase().replace(/\.$/, '');
  if (/[/:@?#\\\s]/.test(raw) || raw.includes('..')) throw new LearningsError(`domain: a host name only (no scheme, port or path): ${raw.slice(0, 80)}`);
  const ascii = domainToASCII(raw);
  if (!ascii || ascii.length > 253 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(ascii)) throw new LearningsError(`not a host name: ${raw.slice(0, 80)}`);
  return ascii;
}

/** The domain and its parents with at least two labels (a.b.example.com → b.example.com → example.com). @param {string} d */
const lineage = (d) => d.split('.').map((_, i, parts) => parts.slice(i).join('.')).filter((x) => x.includes('.'));

/** @param {string} d */
const fileOf = (d) => path.join(dir(), `${d}.jsonl`); // d is normalized: [a-z0-9.-] only

/**
 * @typedef {{ id: string, domain: string, note: string, kind: string, author: string, principal: string | null, at: string,
 *   source_url: string | null, sha256: string }} Note
 */

/** @param {string} d @returns {Note[]} */
function readDomain(d) {
  const f = fileOf(d);
  const st = fs.lstatSync(f, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      const n = JSON.parse(l);
      return n && typeof n.id === 'string' && typeof n.note === 'string' ? [n] : [];
    } catch {
      return [];
    }
  });
}

/** Write a domain's notes whole (a temporary file renamed into place). @param {string} d @param {Note[]} notes */
function writeDomain(d, notes) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  fs.chmodSync(dir(), 0o700);
  const f = fileOf(d);
  if (fs.lstatSync(f, { throwIfNoEntry: false })?.isSymbolicLink()) throw new LearningsError(`${f} is a symbolic link: left alone`);
  if (!notes.length) return void fs.rmSync(f, { force: true });
  const tmp = `${f}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, notes.map((n) => `${JSON.stringify(n)}\n`).join(''), { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, f);
}

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
 * Run fn holding learnings/.lock. A domain's file is read whole and written back, and several MCP sessions and the CLI
 * are separate processes: without one lock around the whole read-change-write, two adds at once keep only one note.
 * Writes are short, so a busy lock is waited for.
 * @template T @param {() => T} fn @returns {T}
 */
function locked(fn) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const file = path.join(dir(), '.lock');
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
      if (Date.now() > until) {
        throw new LearningsError(st === 'left'
          ? `the notes are locked by a k-browser that is no longer running (it stopped while writing): once no k-browser is writing notes, remove ${file}`
          : st === 'unreadable' ? `the notes' lock ${file} cannot be read (its permissions?): fix or remove it`
            : 'the notes are busy (another k-browser is writing them): try again');
      }
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

/**
 * Add a note. The text is redacted first (redact: the caller's redactor). author: a client name, "user" or
 * "import:<file>"; principal: the writing client's principal (never reused), null for the user and imports.
 * @param {{ domain: unknown, note: unknown, kind?: unknown, author: string, principal: string | null, sourceUrl?: string | null,
 *   redact: (s: string) => string }} o @returns {Note}
 */
export function add({ domain, note, kind = 'tip', author, principal, sourceUrl = null, redact }) {
  const d = normalizeDomain(domain);
  if (typeof note !== 'string' || !note.trim()) throw new LearningsError('note: the text of the note');
  if (!KINDS.includes(/** @type {any} */ (kind))) throw new LearningsError(`kind: one of ${KINDS.join(', ')}`);
  const text = redact(note.trim());
  if (Buffer.byteLength(text, 'utf8') > MAX_NOTE) throw new LearningsError(`note: at most ${MAX_NOTE} bytes`);
  const sha256 = createHash('sha256').update(`${d}\n${text}`).digest('hex');
  return locked(() => {
    const notes = readDomain(d);
    const same = notes.find((n) => n.sha256 === sha256);
    if (same) return same;
    if (notes.length >= MAX_PER_DOMAIN) throw new LearningsError(`${d} already has ${MAX_PER_DOMAIN} notes: remove some first`);
    /** @type {Note} */ const n = { id: randomBytes(6).toString('hex'), domain: d, note: text, kind: String(kind), author, principal,
      at: new Date().toISOString(), source_url: sourceUrl ? redact(sourceUrl) : null, sha256 };
    writeDomain(d, [...notes, n]);
    return n;
  });
}

/**
 * The notes for a domain and its parents, leaving out every domain the policy blocks (allowed: (domain) => boolean).
 * @param {unknown} domain @param {(d: string) => boolean} [allowed] @returns {Note[]}
 */
export function get(domain, allowed = () => true) {
  return lineage(normalizeDomain(domain)).filter(allowed).flatMap(readDomain);
}

/**
 * Remove a note by id. A client (principal) removes only what it wrote; the user (principal null, from the CLI) any.
 * @param {unknown} id @param {string | null} principal @returns {Note}
 */
export function remove(id, principal) {
  if (typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id)) throw new LearningsError('id: a note id from learnings get');
  return locked(() => {
    for (const f of fs.readdirSync(dir()).filter((x) => x.endsWith('.jsonl'))) {
      const d = f.slice(0, -'.jsonl'.length);
      const notes = readDomain(d);
      const n = notes.find((x) => x.id === id);
      if (!n) continue;
      if (principal !== null && n.principal !== principal) throw new LearningsError('that note was written by someone else: only its writer (or the user, from the CLI) can remove it');
      writeDomain(d, notes.filter((x) => x.id !== id));
      return n;
    }
    throw new LearningsError(`no note ${id}`);
  });
}

/** Every note of these domains (all when none), for export. @param {string[]} [domains] @returns {Note[]} */
export function exportNotes(domains = []) {
  const all = fs.existsSync(dir()) ? fs.readdirSync(dir()).filter((x) => x.endsWith('.jsonl')).map((x) => x.slice(0, -6)) : [];
  const want = domains.length ? new Set(domains.map(normalizeDomain)) : null;
  return all.filter((d) => !want || want.has(d)).flatMap(readDomain);
}

/**
 * Import notes from an export, each only after confirm(note) says yes. They are added as new notes (fresh id, redacted
 * again, author "import:<file>", no principal): an import never replaces or removes anything.
 * @param {string} file @param {(n: { domain: string, kind: string, note: string, author: string }) => Promise<boolean>} confirm
 * @param {(s: string) => string} redact
 */
export async function importNotes(file, confirm, redact) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let added = 0;
  let skipped = 0;
  for (const l of lines) {
    /** @type {any} */ let n;
    try {
      n = JSON.parse(l);
    } catch {
      skipped++;
      continue;
    }
    if (!n || typeof n.note !== 'string' || typeof n.domain !== 'string') { skipped++; continue; }
    const kind = KINDS.includes(n.kind) ? n.kind : 'tip';
    if (!(await confirm({ domain: n.domain, kind, note: n.note, author: String(n.author ?? '?') }))) { skipped++; continue; }
    try {
      add({ domain: n.domain, note: n.note, kind, author: `import:${path.basename(file)}`, principal: null, redact });
      added++;
    } catch (e) {
      if (!(e instanceof LearningsError)) throw e;
      skipped++; // a bad domain, too long, a full domain: that note only
    }
  }
  return { added, skipped };
}
