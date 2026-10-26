// @ts-check
// The bridge <-> extension wire protocol, shared verbatim by both sides (the bridge imports this file from
// extension/). One definition of the handshake transcript and MAC means the two ends cannot drift apart.
// WebCrypto only: available in the extension's service worker and in Node alike.

export const PROTOCOL = 1;

/** Lifecycle events the extension reports for owned tabs (the bridge buffers these while reconciling). */
export const LIFECYCLE_EVENTS = ['tab.created', 'tab.updated', 'tab.removed', 'tab.replaced'];

/** Limits both sides enforce on handshake fields. */
export const IDENT_MIN = 8;
export const IDENT_MAX = 128;

/** @param {unknown} x */
export function isIdent(x) {
  return typeof x === 'string' && x.length >= IDENT_MIN && x.length <= IDENT_MAX;
}

/** @param {number} bytes */
export function randomHex(bytes) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * What both sides MAC: the protocol version and both nonces, so a proof from one handshake is useless in another.
 * @param {string} bridgeNonce @param {string} extNonce
 */
export function transcript(bridgeNonce, extNonce) {
  return `k-browser|v${PROTOCOL}|${bridgeNonce}|${extNonce}`;
}

/**
 * HMAC-SHA256 hex of `${role}|${script}` under the pairing key. role binds the proof to one direction.
 * @param {string} key @param {'ext'|'bridge'} role @param {string} script
 */
export async function mac(key, role, script) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(`${role}|${script}`)));
  return [...sig].map((x) => x.toString(16).padStart(2, '0')).join('');
}
