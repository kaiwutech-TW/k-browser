// @ts-check
// `k-browser mcp --client <name>`: what the agent starts. A small relay that runs the MCP server proper
// (`k-browser mcp-worker`) as its child, and starts a new one between calls when K-Browser on disk was updated, the
// client's record changed (revoked, added again, settings changed in the side panel) or the worker died. The agent
// keeps one connection throughout: no reconnecting after an update or a settings change.
//
// Only Node's own modules: what this file does is whatever was loaded when the agent started, whatever is on disk
// later. For the same reason `mcp-worker --client <name> --port <port>`, k-browser/tabs and k-browser/adopt stay as
// they are; a change to them is a new SHIM_PROTOCOL, and agents reconnect once to load it.
//
// The rules:
// - the generation (package.json's version + the client record's inode, mtime and size) is read before every request
//   is handed on. Once it changed, no new request goes to the old worker: requests wait until the old worker answered
//   the ones it has (a run_flow may take minutes; they finish under the rights they started with), then go to a new
//   worker, which reads the record afresh. A setting saved before a call was handed on applies to that call.
// - every request to a worker carries the shim's own id; answers are mapped back by the id table, so nothing the shim
//   asks for itself reaches the agent, whatever ids the agent uses.
// - a tools/call the worker never answered (it died) answers result_unknown and is never sent again: input or a
//   submit may have happened.
// - tab and ref ids never come to mean something else: the worker reports its tab table (k-browser/tabs) before it
//   answers with anything that shows those ids, and the shim hands the last table to the next worker
//   (k-browser/adopt). The bridge's ownership check decides which of those tabs are still this client's.
// - the new worker's initialize answer must match what the agent was told (protocol version, capabilities): else
//   every call answers worker_incompatible. Instructions that differ are let be: the agent keeps the first ones.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHIM_PROTOCOL = 1;
const CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));
const STOP_MS = 5000; // a worker asked to stop (stdin closed) gets this long before SIGTERM, then as long before SIGKILL
const START_MS = 20_000; // initialize, adopt and tools/list of a new worker, each
const COOLDOWN_MS = [2000, 4000, 8000, 16_000, 30_000]; // between attempts to start a worker that failed to
const RESEND = new Set(['tools/list']); // requests without side effects: sent again when the worker died before answering

/** @typedef {{ jsonrpc?: string, id?: string | number, method?: string, params?: any, result?: any, error?: any }} Msg */

/** The version on disk: changes when K-Browser is updated. */
function diskVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version);
  } catch {
    return '?';
  }
}

/** What the worker's code and the client's record are now: a new worker is started when this changes. @param {string} name */
export function generation(name) {
  const home = process.env.KBROWSER_HOME || path.join(os.homedir(), '.k-browser');
  let record = 'none';
  try {
    const s = fs.statSync(path.join(home, 'clients', `${name}.json`));
    record = `${s.ino}:${s.mtimeMs}:${s.size}`;
  } catch { /* revoked, or never added: the worker says so */ }
  return `${diskVersion()}|${record}`;
}

/** A tool result made by the shim (the same shape as K-Browser's: one JSON line). @param {string} error @param {string} message */
const toolError = (error, message) => ({ content: [{ type: 'text', text: JSON.stringify({ error, message }) }], isError: true });

const FAILED = 'the K-Browser MCP worker did not start: run `k-browser doctor`';
const INCOMPATIBLE = 'K-Browser was updated in a way this connection cannot follow: reconnect this agent\'s k-browser MCP server once (Claude Code: /mcp)';
const UNKNOWN = 'the K-Browser MCP worker stopped while this call was running: it may have partly happened; read the page before repeating';

/** Call onLine with each JSON message on a newline-delimited stream. @param {NodeJS.ReadableStream} stream @param {(m: Msg) => void} onLine */
function lines(stream, onLine) {
  let buf = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue; // not a message
      }
      if (m && typeof m === 'object') onLine(m);
    }
  });
}

/**
 * @typedef {{ agent: Msg, cancelled?: boolean } | { resolve: (m: Msg | null) => void }} Pending what a request sent to
 *   a worker was: the agent's (answered back to it, unless the agent cancelled it) or the shim's own
 */

class Worker {
  /** @param {string[]} argv @param {Record<string, string | undefined>} env @param {Shim} shim */
  constructor(argv, env, shim) {
    this.shim = shim;
    this.gen = '';
    this.ready = false;
    /** the initialize exchange is done: notifications from the agent may go to it */
    this.initDone = false;
    this.alive = true;
    /** @type {Map<number, Pending>} */ this.pending = new Map();
    this.proc = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'inherit'], env });
    /** @type {Promise<void>} */
    this.exited = new Promise((resolve) => {
      let done = false;
      const end = () => {
        if (done) return;
        done = true;
        this.alive = false;
        resolve();
        shim.workerExited(this);
      };
      this.proc.once('exit', end);
      this.proc.once('error', end); // could not be started at all
    });
    this.proc.stdin.on('error', () => {}); // it went away: exit handles that
    lines(this.proc.stdout, (m) => shim.fromWorker(this, m));
  }

  /** @param {Msg} m */
  send(m) {
    if (this.alive) this.proc.stdin.write(`${JSON.stringify(m)}\n`);
  }

  /** The agent's request, under the shim's id. @param {Msg} m */
  forward(m) {
    const id = this.shim.newId();
    this.pending.set(id, { agent: m });
    this.send({ ...m, id });
  }

  /** The shim's own request: its answer, or null (no answer in time, or the worker died). @param {string} method @param {any} params */
  request(method, params) {
    const id = this.shim.newId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, START_MS);
      this.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Does it still owe the agent an answer? A cancelled request does not count: MCP servers never answer those, and
   * stopping the worker (to replace it) stops whatever is left of it. */
  busy() {
    for (const p of this.pending.values()) if ('agent' in p && !p.cancelled) return true;
    return false;
  }

  /** Stop: close its stdin (it stops a running flow first), then signals if it does not go. */
  async stop() {
    if (!this.alive) return;
    const term = setTimeout(() => this.proc.kill('SIGTERM'), STOP_MS);
    const kill = setTimeout(() => this.proc.kill('SIGKILL'), 2 * STOP_MS);
    this.proc.stdin.end();
    await this.exited;
    clearTimeout(term);
    clearTimeout(kill);
  }
}

export class Shim {
  /**
   * @param {{ argv: string[], generation: () => string, write: (m: Msg) => void, env?: Record<string, string | undefined>,
   *   cooldownMs?: number[] }} o argv: the worker's command line; write: a message to the agent
   */
  constructor({ argv, generation, write, env = process.env, cooldownMs = COOLDOWN_MS }) {
    this.argv = argv;
    this.generation = generation;
    this.write = write;
    this.env = { ...env, KBROWSER_SHIM: `${SHIM_PROTOCOL} ${diskVersion()}` };
    this.cooldownMs = cooldownMs;
    this.ids = 0;
    /** @type {any} the agent's initialize params, sent again to each new worker */
    this.initParams = null;
    /** @type {any} the initialize result the agent got */
    this.initResult = null;
    /** @type {string | null} protocol version and capabilities of the first worker (JSON): every later one must match */
    this.negotiated = null;
    /** the agent sent notifications/initialized */
    this.initialized = false;
    /** @type {Worker | null} */ this.worker = null;
    /** @type {Msg[]} the agent's requests not handed on yet */
    this.queue = [];
    /** @type {any} the worker's last tab table, for the next one */
    this.tabs = null;
    /** @type {string | null} the tools the agent was last given (JSON) */
    this.tools = null;
    /** @type {{ gen: string, n: number, until: number } | null} the last failed start */
    this.failure = null;
    /** @type {string | null} the generation whose worker answered initialize differently */
    this.incompatible = null;
    this.pumping = false;
    this.again = false;
    this.closed = false;
  }

  newId() {
    return ++this.ids;
  }

  /** A message from the agent. @param {Msg} m */
  fromAgent(m) {
    if (this.closed) return;
    if (m.method === undefined) {
      this.worker?.send(m); // an answer to something a worker asked the agent
      return;
    }
    if (m.id === undefined) {
      if (m.method === 'notifications/initialized') {
        this.initialized = true;
        if (this.worker?.initDone) this.worker.send(m);
      } else if (m.method === 'notifications/cancelled') {
        this.#cancel(m);
      } else if (this.worker?.initDone) {
        this.worker.send(m);
      }
      return;
    }
    if (m.method === 'ping') {
      this.write({ jsonrpc: '2.0', id: m.id, result: {} });
      return;
    }
    if (this.initParams === null && m.method !== 'initialize') {
      // before initialize nothing is started: an agent may probe first (Claude Code asks for a newer protocol's
      // method and falls back to initialize on "method not found", as an MCP server answers)
      this.write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
      return;
    }
    if (m.method === 'initialize' && this.initParams === null) this.initParams = m.params ?? {};
    this.queue.push(m);
    void this.pump();
  }

  /** @param {Msg} m */
  #cancel(m) {
    const target = m.params?.requestId;
    const i = this.queue.findIndex((q) => q.id === target);
    if (i >= 0) {
      this.queue.splice(i, 1); // never handed on: dropped, and a cancelled request gets no answer
      return;
    }
    const w = this.worker;
    for (const [id, p] of w?.pending ?? []) {
      if (!('agent' in p) || p.agent.id !== target) continue;
      p.cancelled = true; // a late answer is dropped, and it no longer holds back a new worker
      p.agent = { id: p.agent.id, method: p.agent.method }; // only what is needed to recognise it: not its arguments
      w?.send({ ...m, params: { ...m.params, requestId: id } });
    }
    if (w && !w.busy() && this.queue.length) void this.pump();
  }

  /** A message from a worker. @param {Worker} w @param {Msg} m */
  fromWorker(w, m) {
    if (m.method === undefined && m.id !== undefined) {
      const p = typeof m.id === 'number' ? w.pending.get(m.id) : undefined;
      if (!p) return;
      w.pending.delete(/** @type {number} */ (m.id));
      if ('resolve' in p) p.resolve(m);
      else if (!p.cancelled) this.#answer(p.agent, m);
      if (!w.busy() && this.queue.length) void this.pump();
      return;
    }
    if (m.method === 'k-browser/tabs') {
      if (w === this.worker) this.tabs = m.params ?? null;
      return;
    }
    this.write(m); // its notifications (and requests, which K-Browser does not make) go to the agent as they are
  }

  /** The worker's answer to the agent's request. @param {Msg} req @param {Msg} m */
  #answer(req, m) {
    if (req.method === 'tools/list' && m.result && Array.isArray(m.result.tools)) this.tools = JSON.stringify(m.result.tools);
    this.write({ ...m, id: req.id });
  }

  /** @param {Worker} w */
  workerExited(w) {
    const lost = [...w.pending.values()];
    w.pending.clear();
    /** @type {Msg[]} */ const again = [];
    for (const p of lost) {
      if ('resolve' in p) p.resolve(null);
      else if (p.cancelled) continue;
      else if (RESEND.has(String(p.agent.method))) again.push(p.agent);
      else if (p.agent.method === 'tools/call') this.write({ jsonrpc: '2.0', id: p.agent.id, result: toolError('result_unknown', UNKNOWN) });
      else this.write({ jsonrpc: '2.0', id: p.agent.id, error: { code: -32603, message: UNKNOWN } });
    }
    this.queue.unshift(...again);
    if (!this.closed && this.queue.length) void this.pump();
  }

  /** Hand on what is queued, starting a new worker first when the generation changed or the worker is gone. */
  async pump() {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        await this.#pumpOnce();
      } while (this.again && !this.closed);
    } finally {
      this.pumping = false;
    }
  }

  async #pumpOnce() {
    while (this.queue.length && !this.closed) {
      const gen = this.generation();
      const w = this.worker;
      if (w && w.alive && w.ready && w.gen === gen) {
        const m = /** @type {Msg} */ (this.queue.shift());
        if (m.method === 'initialize') this.write({ jsonrpc: '2.0', id: m.id, result: this.initResult }); // done at start
        else w.forward(m);
        continue;
      }
      if (w && w.alive && w.busy()) return; // the old worker finishes what it has; its last answer pumps again
      if (this.incompatible === gen) return this.#refuseQueue('worker_incompatible', INCOMPATIBLE);
      if (this.failure && this.failure.gen === gen && Date.now() < this.failure.until) return this.#refuseQueue('worker_failed', FAILED);
      await this.#replace(gen);
    }
  }

  /** Answer every queued request with an error (initialize included: nothing to start). @param {string} code @param {string} message */
  #refuseQueue(code, message) {
    for (const m of this.queue.splice(0)) {
      if (m.method === 'tools/call') this.write({ jsonrpc: '2.0', id: m.id, result: toolError(code, message) });
      else this.write({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message } });
    }
  }

  /** Stop the old worker (it owes nothing now) and start one for this generation. @param {string} gen */
  async #replace(gen) {
    await this.worker?.stop();
    const w = new Worker(this.argv, this.env, this);
    w.gen = gen;
    this.worker = w;
    const how = await this.#start(w);
    if (how === 'ok') {
      w.ready = true;
      this.failure = null;
      this.incompatible = null;
      return;
    }
    await w.stop();
    if (how === 'incompatible') {
      this.incompatible = gen;
    } else {
      const n = this.failure?.gen === gen ? this.failure.n + 1 : 0;
      this.failure = { gen, n, until: Date.now() + this.cooldownMs[Math.min(n, this.cooldownMs.length - 1)] };
    }
  }

  /** initialize (the agent's own params), initialized, adopt, tools/list. @param {Worker} w @returns {Promise<'ok' | 'failed' | 'incompatible'>} */
  async #start(w) {
    const init = await w.request('initialize', this.initParams ?? {});
    if (!init?.result || !w.alive) {
      // the agent's log is where this shows (no secrets: an MCP error message, or how the worker ended)
      const why = init?.error ? `answered ${JSON.stringify(init.error).slice(0, 300)}` : w.alive ? 'no answer in time' : `exited (${w.proc.exitCode ?? w.proc.signalCode})`;
      process.stderr.write(`k-browser mcp: the worker did not answer initialize: ${why}\n`);
      return 'failed';
    }
    const { protocolVersion, capabilities } = init.result;
    if (this.initResult === null) {
      // the first worker: what it answers is what the agent is told, plus that the tool list may change
      this.initResult = { ...init.result, capabilities: { ...capabilities, tools: { ...capabilities?.tools, listChanged: true } } };
      this.negotiated = JSON.stringify({ protocolVersion, capabilities });
    } else if (JSON.stringify({ protocolVersion, capabilities }) !== this.negotiated) {
      return 'incompatible';
    }
    w.initDone = true;
    if (this.initialized) w.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    if (this.tabs) await w.request('k-browser/adopt', this.tabs); // refused by a worker that has no client: nothing to adopt
    if (this.tools === null) return w.alive ? 'ok' : 'failed'; // the agent has not asked for tools yet
    const list = await w.request('tools/list', {});
    if (!list?.result || !Array.isArray(list.result.tools)) return 'failed';
    const tools = JSON.stringify(list.result.tools);
    if (tools !== this.tools) {
      this.tools = tools;
      this.write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
    return 'ok';
  }

  /** The agent went away: stop the worker. */
  async close() {
    this.closed = true;
    await this.worker?.stop();
  }
}

/**
 * Run the shim on this process's stdio until the agent closes it.
 * @param {{ name: string, port: number }} o
 */
export async function runShim({ name, port }) {
  const shim = new Shim({
    argv: [process.execPath, CLI_PATH, 'mcp-worker', '--client', name, '--port', String(port)],
    generation: () => generation(name),
    write: (m) => { try { process.stdout.write(`${JSON.stringify(m)}\n`); } catch { /* the agent went away */ } },
  });
  process.stdout.on('error', () => {});
  lines(process.stdin, (m) => shim.fromAgent(m));
  await new Promise((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
    for (const sig of /** @type {const} */ (['SIGTERM', 'SIGINT', 'SIGHUP'])) process.once(sig, resolve);
  });
  await shim.close();
  return 0;
}
