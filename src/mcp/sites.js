// @ts-check
// The site policy of one MCP client: blockedOrigins, and optionally allowedOrigins
// (when set, only those are allowed). It is an MCP-layer rule; raw CDP clients (Kav) are not affected.
//
// Every frame is judged on its own: the top document and each iframe. A frame is "allowed", "blocked", or "unknown"
// (an origin K-Browser cannot tell: data:, file:, an error page, a frame that has not navigated yet). Only allowed
// frames are read or sent input; a frame inside a frame that is not allowed is not allowed either.
//
// Patterns:
//   example.com                 that host and its subdomains, any scheme and port
//   https://example.com         exactly that origin (default port)
//   https://example.com:8443    exactly that origin
//   https://*.example.com       that scheme, the host and its subdomains

/** @typedef {'allowed' | 'blocked' | 'unknown'} Verdict */
/** @typedef {{ scheme: string | null, host: string, sub: boolean, port: string | null }} Pattern */

const WEB = new Set(['http:', 'https:', 'ws:', 'wss:']);
const DEFAULT_PORT = /** @type {Record<string, string>} */ ({ 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' });

/** @param {string} raw @returns {Pattern} */
export function parsePattern(raw) {
  const s = String(raw).trim().toLowerCase();
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::(\d{1,5}))?\/?$/.exec(s);
  if (!m) throw new Error(`site pattern ${JSON.stringify(raw)}: expected host, scheme://host[:port] or scheme://*.host`);
  const [, scheme, star, host, port] = m;
  if (!scheme && port) throw new Error(`site pattern ${JSON.stringify(raw)}: a port needs a scheme`);
  return { scheme: scheme ? `${scheme}:` : null, host, sub: !scheme || Boolean(star), port: scheme ? port ?? DEFAULT_PORT[`${scheme}:`] ?? null : null };
}

/** The origin of a URL, or null when it has none K-Browser can judge. about:blank / about:srcdoc take the parent's.
 * @param {string} url @param {string | null} [parentOrigin] @returns {string | null} */
export function originOf(url, parentOrigin = null) {
  if (/^about:(blank|srcdoc)(?:[?#]|$)/i.test(url)) return parentOrigin;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol === 'blob:') return originOf(url.slice(5), null);
  return WEB.has(u.protocol) ? `${u.protocol}//${u.host}` : null;
}

/** @param {{ blockedOrigins?: string[], allowedOrigins?: string[] | null }} cfg */
export function sitePolicy({ blockedOrigins = [], allowedOrigins = null } = {}) {
  const blocked = blockedOrigins.map(parsePattern);
  const allowed = allowedOrigins ? allowedOrigins.map(parsePattern) : null;

  /** @param {Pattern} p @param {URL} u */
  const hit = (p, u) => {
    if (p.scheme && p.scheme !== u.protocol) return false;
    if (p.port && p.port !== (u.port || DEFAULT_PORT[u.protocol])) return false;
    const h = u.hostname.toLowerCase();
    return h === p.host || (p.sub && h.endsWith(`.${p.host}`));
  };

  /** @param {string | null} origin @returns {Verdict} */
  const judge = (origin) => {
    if (!origin) return 'unknown';
    const u = new URL(origin);
    if (blocked.some((p) => hit(p, u))) return 'blocked';
    if (allowed && !allowed.some((p) => hit(p, u))) return 'blocked';
    return 'allowed';
  };

  /**
   * Judge every frame of a tab. Frames come parent-first (FrameTree order). A new tab's own about:blank (no opener)
   * holds nothing and counts as allowed; any other frame without a judgeable origin is unknown.
   * @param {{ frameId: string, parentId: string | null, url: string }[]} frames @param {{ opened?: boolean }} [o]
   */
  const assess = (frames, { opened = false } = {}) => {
    /** @type {Map<string, { origin: string | null, verdict: Verdict }>} */
    const byId = new Map();
    /** @type {Set<string>} frames not to read, send input to, or show */
    const hidden = new Set();
    let main = /** @type {{ frameId: string | null, origin: string | null, verdict: Verdict }} */ ({ frameId: null, origin: null, verdict: 'unknown' });
    for (const f of frames) {
      const parent = f.parentId ? byId.get(f.parentId) : undefined;
      const origin = originOf(f.url, parent?.origin ?? null);
      let verdict = judge(origin);
      if (!f.parentId && !opened && /^about:blank(?:[?#]|$)/i.test(f.url)) verdict = 'allowed';
      if (parent && parent.verdict !== 'allowed') verdict = parent.verdict === 'blocked' ? 'blocked' : 'unknown';
      if (f.parentId && !parent && verdict === 'allowed') verdict = 'unknown'; // its parent is not known: cannot place it
      byId.set(f.frameId, { origin, verdict });
      if (verdict !== 'allowed') hidden.add(f.frameId);
      if (!f.parentId) main = { frameId: f.frameId, origin, verdict };
    }
    return { main, hidden, frames: byId, clean: hidden.size === 0 && main.verdict === 'allowed' };
  };

  /** @param {string} url */
  const urlVerdict = (url) => judge(originOf(url));

  /**
   * For what is kept per host, not per origin (site notes): blocked when any origin of the host is (any scheme or
   * port), and, with an allow list, when no pattern covers the host at all.
   * @param {string} host @returns {Verdict}
   */
  const hostVerdict = (host) => {
    const h = host.toLowerCase();
    const on = (/** @type {Pattern} */ p) => h === p.host || (p.sub && h.endsWith(`.${p.host}`));
    if (blocked.some(on)) return 'blocked';
    if (allowed && !allowed.some(on)) return 'blocked';
    return 'allowed';
  };

  return { judge, assess, urlVerdict, hostVerdict, restricted: blocked.length > 0 || allowed !== null };
}

/** @typedef {ReturnType<typeof sitePolicy>} SitePolicy */
