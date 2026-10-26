// @ts-check
// Redaction shared by everything K-Browser prints or hands to an agent: MCP results,
// stderr logs, and later the activity panel, the activity file and the installer's output.
//
// Rules, in this order:
//   1. credentials K-Browser actually loaded (every client token, the pairing key): replaced wherever they appear,
//      matched literally, not by their shape;
//   2. URLs: userinfo, query values (all but a 1-3 digit value of a parameter not named like a secret, e.g. CID=63,
//      page=2, and a listed shop's product number, e.g. momo's i_code), the fragment, and path segments that look like tokens;
//   3. Authorization / Cookie / Set-Cookie style header values, "Bearer ..." and JSON fields named like secrets
//      ("password", "token", "session", ...);
//      and in HTML, the value attribute of password fields and of fields named like secrets;
//   4. numbers that identify a person: Taiwanese national / resident IDs, mobile numbers, card numbers (Luhn-checked).
// Names and addresses have no reliable pattern and are not covered. Screenshots (pixels) cannot be redacted by text
// rules at all: see the screenshot policy in src/mcp/.

const CREDENTIAL = '[redacted:credential]';
const MIN_SECRET = 8; // shorter strings would match ordinary text

const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token',
  'x-csrf-token', 'x-xsrf-token']);
// A name is secret-like when it contains one of the long words anywhere (access_token, sessionId), or has one of the
// short words as a whole word (auth_code, x-sid, otpCode) — not inside another word (author, design, side, shipping).
const SECRET_PART = /pass(?:word|wd)|secret|token|session|sessid|cookie|credential|apikey|privatekey|csrf|xsrf|jwt/;
const SECRET_WORD = new Set(['pass', 'pwd', 'auth', 'oauth', 'authorization', 'sid', 'code', 'sig', 'signature', 'otp', 'pin']);
const PASS_WORD = new Set(['pass', 'pwd']); // JSON-like text: the short words that name a secret value (not auth, code...)
/** @param {string} name @param {Set<string>} [words] */
export function secretName(name, words = SECRET_WORD) {
  if (SECRET_PART.test(name.toLowerCase().replace(/[-_.]/g, ''))) return true;
  return name.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).some((w) => words.has(w.toLowerCase()));
}
const SHORT_NUMBER = /^\d{1,3}$/; // shorter than any one-time code
// a shop's product number in the query (momo's i_code): kept on that shop only, digits only, too short for a card number
const PRODUCT_PARAMS = new Map([['momoshop.com.tw', new Set(['i_code'])], ['tw.coupang.com', new Set(['itemId', 'vendorItemId'])]]);
const PRODUCT_NUMBER = /^\d{4,12}$/;
/** A product number url() kept (momo's i_code reads like a secret "code" to the text rules): the URL it sits in, from
 * the text before it, names that shop. @param {string} before @param {string} k @param {string} v */
function keptProduct(before, k, v) {
  const m = /\bhttps?:\/\/([^/?#\s"'<>`\\@]+)[^\s"'<>`\\]*$/i.exec(before);
  return Boolean(m) && productParam(/** @type {RegExpExecArray} */ (m)[1], k, v);
}
/** @param {string} host @param {string} k @param {string} v */
function productParam(host, k, v) {
  if (!PRODUCT_NUMBER.test(v)) return false;
  const h = host.toLowerCase().replace(/:\d+$/, '');
  for (const [site, names] of PRODUCT_PARAMS) if ((h === site || h.endsWith(`.${site}`)) && names.has(k)) return true;
  return false;
}

const URL_IN_TEXT = /\b(?:https?|wss?|ftp):\/\/[^\s"'<>`\\]+/gi;
const HEADER_LINE = /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)(\s*[:=]\s*)[^\r\n]+/gi;
const BEARER = /\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{6,}/g;
// "password": "x", 'token' = 'x' (an escaped quote, as in JSON inside JSON, counts as a quote): the start of a quoted
// value; keyed() checks the name (long words, or pass / pwd) and only then looks for the closing quote (same line, ≤ 4096)
const KEYED = /(?:\\?["'])?([A-Za-z0-9_.-]{1,80})(?:\\?["'])?\s*[:=]\s*(\\?["'])/g;
// a secret-named parameter in a relative URL or form data, or bare in text: ?session=x, &access_token=x, token=x
const KEYED_PARAM = /((?:^|[?&;\s])([A-Za-z0-9_.-]{1,80})=)([^&\s"'#<>\\]+)/g;
// HTML: the value of a password field, or of a field named like a secret (csrf_token, session...)
// (a tag lexed as HTML does: a quoted attribute value may contain '>')
const INPUT_TAG = /<input\b(?:[^>"']|"[^"]*"|'[^']*'){0,2000}>/gi;
const SECRET_INPUT = /\btype\s*=\s*["']?password\b|\b(?:name|id|autocomplete)\s*=\s*["']?[^"'\s>]{0,40}(?:pass|token|secret|session|csrf|otp|one-time-code)/i;
const VALUE_ATTR = /(\bvalue\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/i;
const TW_ID = /\b[A-Z][1289]\d{8}\b/g;
const TW_MOBILE = /(?:\+886[- ]?|\b0)9\d{2}[- ]?\d{3}[- ]?\d{3}\b/g;
// not right after a letter and a hyphen (an ID such as A-116057345-00000-6)
const CARD = /(?<![A-Za-z]-?)\b\d(?:[ -]?\d){12,18}\b/g;
// how card numbers are written when grouped: 4-4-4-4 (a last group of 1-4 digits, up to 19), Amex 4-6-5, Diners 4-6-4
const CARD_GROUPS = /^(?:\d{4}(?:[ -]\d{4}){2,3}(?:[ -]\d{1,4})?|\d{4}[ -]\d{6}[ -]\d{4,5})$/;

/** @param {string} s */
function keyed(s) {
  let out = '';
  let last = 0;
  KEYED.lastIndex = 0;
  for (let m = KEYED.exec(s); m; m = KEYED.exec(s)) {
    const [whole, name, q] = m;
    if (!secretName(name, PASS_WORD)) continue;
    const start = m.index + whole.length;
    const ahead = s.slice(start, start + 4096 + q.length);
    const end = ahead.indexOf(q);
    if (end <= 0 || ahead.slice(0, end).includes('\n')) continue;
    out += `${s.slice(last, start)}[redacted]`;
    last = start + end;
    KEYED.lastIndex = last + q.length;
  }
  return out + s.slice(last);
}

/** @param {string} k a query parameter name, still percent-encoded */
function secretParam(k) {
  try {
    return secretName(decodeURIComponent(k));
  } catch {
    return true;
  }
}

/** @param {string} digits */
function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** A path segment that carries a token rather than a name: one long run (between - _ . ~) mixing letters and digits.
 * @param {string} seg */
export function looksLikeToken(seg) {
  if (seg.length < 16 || !/^[A-Za-z0-9_.~=+%-]+$/.test(seg)) return false;
  return seg.split(/[-_.~]/).some((run) => run.length >= 16 && /\d/.test(run) && /[A-Za-z]/.test(run));
}

/**
 * @param {{ secrets?: Iterable<string | null | undefined> }} [o] credentials to remove wherever they appear
 */
export function redactor({ secrets = [] } = {}) {
  const literal = [...new Set(/** @type {string[]} */ ([...secrets].filter((s) => typeof s === 'string' && s.length >= MIN_SECRET)))]
    .sort((a, b) => b.length - a.length);

  /** @param {string} s */
  const credentials = (s) => {
    for (const x of literal) if (s.includes(x)) s = s.split(x).join(CREDENTIAL);
    return s;
  };

  /** A URL with userinfo, query values, fragment and token-like path segments removed. Not a URL: text rules.
   * @param {string} u */
  const url = (u) => {
    u = credentials(String(u));
    const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(u);
    if (!m) return u;
    const [, scheme, authority, path, query, fragment] = m;
    const host = authority.includes('@') ? `[redacted]@${authority.slice(authority.lastIndexOf('@') + 1)}` : authority;
    const segs = path.split('/').map((s) => (looksLikeToken(s) ? '[redacted]' : s)).join('/');
    const q = query ? `?${query.slice(1).split('&').map((kv) => {
      const i = kv.indexOf('=');
      if (i < 0) return kv ? '[redacted]' : kv;
      const [k, v] = [kv.slice(0, i), kv.slice(i + 1)];
      return (SHORT_NUMBER.test(v) && !secretParam(k)) || (!authority.includes('@') && productParam(authority, k, v)) ? kv : `${k}=[redacted]`;
    }).join('&')}` : '';
    return `${scheme}${host}${segs}${q}${fragment && fragment.length > 1 ? '#[redacted]' : fragment ?? ''}`;
  };

  /** @param {string} s */
  const text = (s) => {
    s = credentials(String(s));
    s = s.replace(INPUT_TAG, (tag) => (SECRET_INPUT.test(tag) ? tag.replace(VALUE_ATTR, '$1"[redacted]"') : tag));
    s = s.replace(URL_IN_TEXT, (u) => url(u));
    s = s.replace(HEADER_LINE, (_, name, sep) => `${name}${sep}[redacted]`);
    s = s.replace(BEARER, (_, kind, sp) => `${kind}${sp}[redacted]`);
    s = keyed(s);
    s = s.replace(KEYED_PARAM, (m, key, name, value, at, all) => (secretName(name) && !keptProduct(all.slice(0, at), name, value) ? `${key}[redacted]` : m));
    s = s.replace(TW_ID, '[redacted:id]');
    s = s.replace(TW_MOBILE, '[redacted:phone]');
    s = s.replace(CARD, (m) => {
      const digits = m.replace(/\D/g, '');
      const grouped = digits.length === m.length || CARD_GROUPS.test(m);
      return grouped && digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '[redacted:card]' : m;
    });
    return s;
  };

  /** Header values of secret-bearing headers removed; the rest through the text rules.
   * @param {Record<string, unknown>} h */
  const headers = (h) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) =>
    [k, SECRET_HEADERS.has(k.toLowerCase()) ? '[redacted]' : text(String(v))]));

  /** Every string in a JSON-like value; object fields named like secrets lose their value entirely.
   * @param {unknown} v @returns {unknown} */
  const value = (v) => {
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map(value);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) =>
        [k, typeof x === 'string' && secretName(k) && !/^(url|kind|why)$/i.test(k) ? '[redacted]' : value(x)]));
    }
    return v;
  };

  return { text, url, headers, value, credentials };
}

/** @typedef {ReturnType<typeof redactor>} Redactor */
