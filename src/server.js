// @ts-check
// The k-browser bridge: one long-lived process on 127.0.0.1.
//
//   /ext                                     the extension (fixed Origin as a filter + pairing-key HMAC as proof)
//   /c/<token>/json/version, /json/list      CDP discovery for one named client
//   /c/<token>/json/protocol                 the protocol subset K-Browser supports (not Chrome's whole protocol)
//   /c/<token>/devtools/browser/<any>        CDP browser websocket for that client
//   /model/v1/systemone                      the model exit (src/model.js): POST, the client token as a Bearer
//   /health                                  liveness, no secrets
//
// Tokens travel in the URL path, so this server never logs a URL (it has no access log) and discovery answers are
// no-store. Kav treats any HTTP answer as "Chrome is running"; with the bridge down it launches a Chrome of its own
// (it takes the port from the endpoint, which here has a path) — that has to be fixed on Kav's side.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { isIdent, mac, PROTOCOL, randomHex, transcript } from '../extension/protocol.js';
import { Activity, readConfig } from './activity.js';
import * as auth from './auth.js';
import * as model from './model.js';
import { ALLOWED } from './policy.js';
import { BROWSER_METHODS, CdpConn, ExtensionLink, Relay } from './relay.js';
import { EXTENSION_ID, VERSION } from './version.js';

export const DEFAULT_PORT = Number(process.env.KBROWSER_PORT || 9444);
const HANDSHAKE_TIMEOUT_MS = 5000;
const HANDSHAKE_MAX_BYTES = 4096;
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/;
const REJECT_GRACE_MS = 1000;

/** @param {import('ws').WebSocket} ws */
const sender = (ws) => /** @param {string} text @returns {Promise<void>} */ (text) => new Promise((resolve, reject) => {
  try {
    ws.send(text, (err) => (err ? reject(err) : resolve(undefined)));
  } catch (e) {
    reject(e);
  }
});

/** @param {import('ws').WebSocket} ws @param {string} code @param {string} message */
function reject(ws, code, message) {
  ws.send(JSON.stringify({ t: 'error', code, message }), () => ws.close());
}

/**
 * @param {{ port?: number, host?: string, extensionId?: string, revokePollMs?: number, log?: (line: string) => void, handoffTtlMs?: number,
 *   activity?: import('./activity.js').Activity, modelOpts?: { fetch?: typeof fetch, jevUrl?: string } }} [opts]
 *   activity: tests pass their own; else from ~/.k-browser/config.json. modelOpts: tests only (a fake upstream)
 */
export async function startBridge({ port = DEFAULT_PORT, host = '127.0.0.1', extensionId = EXTENSION_ID, revokePollMs = 1000,
  log = (line) => console.error(line), handoffTtlMs, activity, modelOpts = {} } = {}) {
  // The activity record stays in memory unless the user set activityLog: "disk"
  const disk = readConfig().activityLog === 'disk' ? { dir: path.join(auth.home(), 'activity') } : null;
  const relay = new Relay({ log, handoffTtlMs, activity: activity ?? new Activity({ disk }) });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  let listeningPort = port;
  let closing = false;
  /** @type {Set<import('node:net').Socket>} every TCP socket, upgraded or not, so close() has a hard boundary */
  const sockets = new Set();

  // DNS rebinding: a web page can reach 127.0.0.1 under its own hostname, never under an exact loopback Host.
  // The whole authority is checked (no userinfo, no trailing text, our port), not a prefix.
  /** @param {string | undefined} host */
  const okHost = (host = '') => {
    const m = LOOPBACK_HOST.exec(host);
    return m !== null && (m[1] === undefined || Number(m[1]) === listeningPort);
  };

  /** @param {http.IncomingMessage} req @param {string} tok */
  const principalOf = (req, tok) => (req.headers.origin ? null : auth.principalFor(tok)); // browsers always send Origin

  const server = http.createServer((req, res) => {
    if (closing) return void res.writeHead(503).end();
    if (!okHost(req.headers.host)) return void res.writeHead(403).end('forbidden host');
    const parts = (req.url ?? '').split('?')[0].split('/');
    if (req.method === 'GET' && req.url === '/health') {
      // pid: lets install / doctor tell a launchd-run bridge from one started by hand
      res.writeHead(200, NO_STORE).end(JSON.stringify({ ok: true, version: VERSION, protocol: PROTOCOL, pid: process.pid,
        extension: relay.ext !== null, extensionVersion: relay.ext?.hello.version ?? null, paired: auth.pairKey() !== null }));
      return;
    }
    // /c/<token>/json/version | /c/<token>/json/list | /c/<token>/json
    if (req.method === 'GET' && parts[1] === 'c' && parts[3] === 'json' && parts.length <= 5) {
      const tok = decodeURIComponentSafe(parts[2]);
      const p = principalOf(req, tok);
      if (!p) return void res.writeHead(404).end();
      if (parts[4] === 'version') {
        const hello = relay.ext?.hello ?? {};
        res.writeHead(200, NO_STORE).end(JSON.stringify({
          Browser: `${hello.product ?? 'Chrome'} (K-Browser ${VERSION})`,
          'Protocol-Version': '1.3',
          'User-Agent': hello.userAgent ?? '',
          'V8-Version': '',
          'WebKit-Version': '',
          // built from where we listen, never from the request's Host
          webSocketDebuggerUrl: `ws://127.0.0.1:${listeningPort}/c/${parts[2]}/devtools/browser/k-browser`,
          'K-Browser-Extension': relay.ext ? 'online' : 'offline',
        }));
        return;
      }
      if (parts[4] === 'protocol') {
        res.writeHead(200, NO_STORE).end(JSON.stringify(describeProtocol()));
        return;
      }
      if (parts[4] === undefined || parts[4] === 'list' || parts[4] === '') {
        res.writeHead(200, NO_STORE).end(JSON.stringify([...relay.targets.values()].filter((t) => t.owner === p.id)
          .map((t) => ({ id: t.targetId, type: 'page', title: t.title, url: t.url, description: '' }))));
        return;
      }
    }
    if (req.url === '/model/v1/systemone') return void modelRequest(req, res);
    res.writeHead(404).end();
  });

  /** The model exit: the token comes in the Authorization header, never in the URL (model-choice H5).
   * @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  const modelRequest = async (req, res) => {
    const answer = (/** @type {number} */ status, /** @type {string} */ body) => void res.writeHead(status, NO_STORE).end(body);
    if (req.method !== 'POST') return answer(405, JSON.stringify({ error: 'bad_request', message: 'POST only' }));
    const m = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? '');
    const p = m ? principalOf(req, m[1]) : null;
    if (!m || !p) return answer(401, JSON.stringify({ error: 'unauthorized', message: 'a client token is needed as Authorization: Bearer' }));
    /** @type {Buffer[]} */ const chunks = [];
    let n = 0;
    try {
      for await (const c of req) {
        n += c.length;
        if (n > model.MAX_BODY) return answer(413, JSON.stringify({ error: 'bad_request', message: 'the request is larger than 1 MB' }));
        chunks.push(c);
      }
    } catch {
      return void res.destroy();
    }
    // the client may have been removed (or removed and made again under the same name) while the body came in
    const record = auth.clientRecord(p.name);
    if (!record || record.principal !== p.id || record.token !== m[1]) {
      return answer(401, JSON.stringify({ error: 'unauthorized', message: 'this client token is no longer valid' }));
    }
    const t0 = Date.now();
    /** @type {Awaited<ReturnType<typeof model.forward>>} */ let r;
    try {
      r = await model.forward({ record, raw: Buffer.concat(chunks).toString('utf8'), ...modelOpts });
    } catch {
      r = { status: 502, body: JSON.stringify({ error: 'model_unavailable', message: 'the model exit failed' }), backend: null, outcome: 'unavailable' };
    }
    try {
      // method: where it went (model:kev, model:jev) or why it went nowhere (model:model_off, model:jev_policy_restricted...)
      relay.activity.command({ principal: p.id, name: p.name, method: `model:${r.backend ?? r.outcome}`, targetId: null,
        outcome: r.status === 200 ? 'ok' : r.status < 500 ? 'refused' : 'error', params: { ms: Date.now() - t0 } });
    } catch { /* the record must never break an answer */ }
    answer(r.status, r.body);
  };

  server.on('upgrade', (req, socket, head) => {
    const deny = (/** @type {number} */ status) => {
      socket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Not Found'}\r\nConnection: close\r\n\r\n`);
      setTimeout(() => socket.destroy(), REJECT_GRACE_MS).unref(); // a peer that never closes its side cannot hold us
    };
    if (closing) return deny(404);
    if (!okHost(req.headers.host)) return deny(403);
    const parts = (req.url ?? '').split('?')[0].split('/');
    if (req.url === '/ext') {
      // The Origin is only a filter (a local program can forge it); the pairing key is the proof.
      if (req.headers.origin !== `chrome-extension://${extensionId}`) return deny(403);
      wss.handleUpgrade(req, socket, head, (ws) => {
        onExtension(ws).catch((e) => {
          log(`k-browser: extension handshake error (${e instanceof Error ? e.constructor.name : 'error'})`);
          ws.terminate();
        });
      });
      return;
    }
    if (parts[1] === 'c' && parts[3] === 'devtools' && parts[4] === 'browser' && parts.length === 6) {
      const p = principalOf(req, decodeURIComponentSafe(parts[2]));
      if (!p) return deny(404);
      wss.handleUpgrade(req, socket, head, (ws) => onClient(ws, p));
      return;
    }
    deny(404);
  });

  /** @param {import('ws').WebSocket} ws @param {auth.Principal} principal */
  function onClient(ws, principal) {
    const conn = new CdpConn(principal, sender(ws), () => {
      ws.close();
      setTimeout(() => ws.terminate(), REJECT_GRACE_MS).unref();
    }, { log });
    relay.connOpened(conn);
    // Commands run concurrently (a slow evaluate must not block the rest), as in Chrome.
    ws.on('message', (data, isBinary) => { if (!isBinary) void relay.handle(conn, data.toString()); });
    ws.on('close', () => {
      conn.close();
      void relay.connClosed(conn);
    });
    ws.on('error', () => {});
  }

  /** @param {import('ws').WebSocket} ws */
  async function onExtension(ws) {
    ws.on('error', () => {});
    const key = auth.pairKey();
    if (!key) return reject(ws, 'unpaired', 'Run `k-browser pair` and paste the code into the extension.');
    const bnonce = randomHex(16);
    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL, nonce: bnonce, version: VERSION }));
    /** @type {Record<string, any>} */
    const hello = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({}), HANDSHAKE_TIMEOUT_MS);
      ws.once('message', (data, isBinary) => {
        clearTimeout(timer);
        const buf = /** @type {Buffer} */ (data);
        if (isBinary || buf.length > HANDSHAKE_MAX_BYTES) return resolve({}); // bytes on the wire
        const text = buf.toString('utf8');
        try {
          const m = JSON.parse(text);
          resolve(m && typeof m === 'object' ? m : {});
        } catch {
          resolve({});
        }
      });
      ws.once('close', () => resolve({}));
    });
    if (hello.v !== PROTOCOL) {
      return reject(ws, 'protocol', `bridge speaks protocol ${PROTOCOL}, extension ${hello.v}: update both to the same version`);
    }
    if (!(isIdent(hello.nonce) && isIdent(hello.profileId) && isIdent(hello.bootId))) {
      return reject(ws, 'protocol', 'handshake is missing nonce / profileId / bootId');
    }
    const script = transcript(bnonce, hello.nonce);
    if (!auth.safeEqual(await mac(key, 'ext', script), hello.mac)) {
      log('k-browser: extension handshake failed (wrong pairing code?)');
      return reject(ws, 'auth', 'pairing code does not match: run `k-browser pair` again');
    }
    // v0 serves one Chrome profile; the first one that pairs is it (`k-browser pair --rotate` resets).
    const pf = auth.profileFile();
    const known = fs.existsSync(pf) ? fs.readFileSync(pf, 'utf8').trim() : null;
    if (known === null) auth.writePrivate(pf, hello.profileId);
    else if (known !== hello.profileId) {
      // a removed and reinstalled extension looks like this too: its profile id lived in its own storage
      return reject(ws, 'profile', 'another Chrome profile is already paired with this bridge (v0 supports one), or the extension '
        + 'was removed and installed again; run `k-browser pair --rotate` and paste the new code to switch');
    }
    const send = sender(ws);
    const link = new ExtensionLink(send, hello, () => ws.close());
    link.key = key;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let m;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (m?.t === 'res') link.resolve(m);
      else if (m?.t === 'ev') relay.extEvent(link, m);
      else if (m?.t === 'ping') void send('{"t":"pong"}').catch(() => {});
    });
    ws.on('close', () => {
      relay.extDisconnected(link);
      log('k-browser: extension offline');
    });
    // welcome goes out only after the listener above is installed, so the extension's first reply is never missed.
    await send(JSON.stringify({ t: 'welcome', mac: await mac(key, 'bridge', script), version: VERSION })).catch(() => {});
    log(`k-browser: extension online (${String(hello.product).slice(0, 40)})`);
    void relay.extConnected(link);
  }

  // Removed clients and a rotated pairing key take effect within one poll (revokePollMs), not at the next
  // connection. Revocation is by principal: removing a client is the supported way to revoke it.
  const watcher = setInterval(() => {
    try {
      const key = auth.pairKey();
      if ([relay.ext, relay.candidate].some((l) => l !== null && l.key !== key)) relay.dropExtension('pairing key rotated');
    } catch {
      log('k-browser: pairing-key check failed');
    }
    try {
      relay.revoke(auth.principals());
    } catch {
      log('k-browser: revocation check failed');
    }
  }, revokePollMs);
  watcher.unref();

  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => resolve(undefined));
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  listeningPort = actualPort;

  return {
    relay,
    port: actualPort,
    base: `http://127.0.0.1:${actualPort}`,
    async close() {
      closing = true; // no new work from here on
      clearInterval(watcher);
      for (const ws of wss.clients) ws.terminate();
      const closed = new Promise((resolve) => server.close(() => resolve(undefined)));
      server.closeAllConnections();
      for (const sock of sockets) sock.destroy(); // upgraded and half-open sockets too
      await closed;
    },
  };
}

/** @param {string | undefined} s */
function decodeURIComponentSafe(s = '') {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The protocol K-Browser actually supports, in the shape of /json/protocol: session methods from the policy's
 * allowlist, browser methods the relay answers, and the KBrowser domain. Only names (and KBrowser's parameters):
 * Chrome's own descriptions would claim more than K-Browser does. */
export function describeProtocol() {
  /** @type {Map<string, { domain: string, commands: Record<string, any>[], description?: string }>} */
  const domains = new Map();
  /** @param {string} name @param {Record<string, any>} extra */
  const add = (name, extra) => {
    const [domain, command] = name.split('.');
    if (!domains.has(domain)) domains.set(domain, { domain, commands: [] });
    /** @type {any} */ (domains.get(domain)).commands.push({ name: command, ...extra });
  };
  for (const m of ALLOWED.keys()) add(m, { scope: 'session' });
  for (const m of BROWSER_METHODS) if (!m.startsWith('KBrowser.')) add(m, { scope: 'browser' });
  const kb = { domain: 'KBrowser', description: "K-Browser's own methods: the bridge's observation log of owned tabs (browser level only; never with a sessionId)", commands: [
    { name: 'mark', scope: 'browser', parameters: [{ name: 'targetId', type: 'string' }, { name: 'label', type: 'string', optional: true, description: 'at most 200 characters; stored as client-provided' }],
      returns: [{ name: 'actionId', type: 'string' }, { name: 't', type: 'number' }, { name: 'label', type: 'string' }, { name: 'source', type: 'string' }] },
    { name: 'queryNetwork', scope: 'browser', parameters: [{ name: 'targetId', type: 'string' }, { name: 'sinceActionId', type: 'string', optional: true },
      { name: 'urlGlob', type: 'string', optional: true, description: '* and ? only; no regular expressions' }, { name: 'method', type: 'string', optional: true },
      { name: 'status', type: 'number | [number, number]', optional: true }, { name: 'limit', type: 'integer', optional: true, description: '1-200, default 50' },
      { name: 'includeBody', type: 'boolean', optional: true, description: 'bodies the bridge captured from Network.getResponseBody replies' }],
    returns: [{ name: 'entries', type: 'array' }, { name: 'truncated', type: 'boolean' }, { name: 'unobservable', type: 'boolean' }, { name: 'why', type: 'array' }, { name: 'partial', type: 'boolean' }] },
    { name: 'getNavigation', scope: 'browser', parameters: [{ name: 'targetId', type: 'string' }],
      returns: [{ name: 'url', type: 'string' }, { name: 'loaderId', type: 'string', optional: true }, { name: 'history', type: 'array' }] },
    { name: 'handoff', scope: 'browser', description: 'hand the tab to the user (one waiting hand-off per tab)',
      parameters: [{ name: 'targetId', type: 'string' }, { name: 'reason', type: 'string', description: 'at most 200 characters; stored as client-provided' }],
      returns: [{ name: 'handoffId', type: 'string' }, { name: 'state', type: 'string' }, { name: 'existing', type: 'boolean' }] },
    { name: 'handoffStatus', scope: 'browser', parameters: [{ name: 'handoffId', type: 'string' }],
      returns: [{ name: 'state', type: 'string', description: 'waiting, returned, cancelled, expired or invalidated' }, { name: 'url', type: 'string', optional: true }] },
    { name: 'cancelHandoff', scope: 'browser', parameters: [{ name: 'handoffId', type: 'string' }], returns: [{ name: 'state', type: 'string' }] },
    { name: 'reportResult', scope: 'browser', description: 'record what the client\'s wait_for found, for the side panel; kept as judged by the SDK, never as verified by the bridge',
      parameters: [{ name: 'targetId', type: 'string' }, { name: 'verdict', type: 'string' }, { name: 'level', type: 'string', optional: true }, { name: 'recordIds', type: 'array', optional: true }],
      returns: [] },
    { name: 'tabHandoff', scope: 'browser', parameters: [{ name: 'targetId', type: 'string' }], returns: [{ name: 'handoffId', type: 'string', description: 'the waiting hand-off, or null' }] },
  ] };
  return { version: { major: '1', minor: '3' }, 'K-Browser': VERSION, domains: [...domains.values(), kb] };
}
