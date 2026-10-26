// @ts-check
// run_flow: hand a saved, hand-written Kav flow to Kav, which runs it in the user's Chrome as the caller.
//
//   C1 Kav's MCP server is a child process for each run (the python of Kav's venv, in a process group of its own), and
//      K-Browser is its MCP client; only a Kav that reports version >= 0.0.2 (answer validation, decision events) is used.
//   C2 its KFW_CDP is the caller's own endpoint, in a short environment listed here: the tabs Kav opens are the caller's.
//   C5 the client's site policy, which Kav (a raw CDP client) does not see: checked before (the flow's url and domains,
//      the tabs already open) and while it runs (targetCreated / targetInfoChanged on K-Browser's own connection). A
//      blocked origin, or losing that watch, stops Kav at once. After the fact: Kav may have sent any number of commands
//      to that page by then, and commands already sent can still complete afterwards.
//      What Kav read comes back only when its provenance is verified: Kav (>= 0.0.3) names, in `sources`, the URL of
//      every document it read content from, taken in the same evaluate as the content; all of them must be allowed and
//      no blocked site may have been seen. Otherwise the content is withheld (watch events can
//      arrive late, and a final page_url says nothing about the pages before it).
//   C6 cancel / timeout kill the process group: the result is unknown, nothing is sent again. A guard process kills the
//      group if K-Browser itself goes away first (an orphaned Kav went on clicking).
//   C7 recorded flows (recorded_from) are not run here; C8 a model off this machine is refused.
//   With the decision dataset on (src/decisions.js), Kav writes its model decisions to a file made for this run
//   (KFW_DECISIONS), read in and deleted when the run ends, however it ends.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import * as decisions from '../decisions.js';
import * as model from '../model.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { originOf } from './sites.js';

export const KAV_MIN_VERSION = '0.0.8';
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;
const KILL_GRACE_MS = 2000;
const WATCH_POLL_MS = 200;
// after Kav answers, how long late target events still count before the final check (not a proof of anything: the
// content check is sources)
const SETTLE_MS = 300;
// the guard: kills Kav's process group when K-Browser's process is gone, and exits once the group is gone
const GUARD = `const [parent, group] = process.argv.slice(1).map(Number);
setInterval(() => {
  try { process.kill(-group, 0); } catch { process.exit(0); }
  try { process.kill(parent, 0); } catch { try { process.kill(-group, 'SIGKILL'); } catch {} process.exit(0); }
}, 200);`;

/** Kav's MCP server over stdio, spawned in its own process group so that stopping it stops everything it started. */
export class ChildTransport {
  /** @param {string} command @param {string[]} args @param {Record<string, string>} env @param {string} cwd */
  constructor(command, args, env, cwd) {
    Object.assign(this, { command, args, env, cwd });
    /** @type {import('node:child_process').ChildProcess | null} */ this.proc = null;
    this.buf = new ReadBuffer();
    this.stderr = '';
    /** @type {((m: any) => void) | undefined} */ this.onmessage = undefined;
    /** @type {(() => void) | undefined} */ this.onclose = undefined;
    /** @type {((e: Error) => void) | undefined} */ this.onerror = undefined;
    /** @type {Promise<void>} */ this.exited = Promise.resolve();
  }

  async start() {
    const p = spawn(/** @type {string} */ (/** @type {any} */ (this).command), /** @type {any} */ (this).args,
      { env: /** @type {any} */ (this).env, cwd: /** @type {any} */ (this).cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.proc = p;
    this.exited = new Promise((resolve) => p.once('exit', () => resolve(undefined)));
    p.stdout?.on('data', (d) => {
      this.buf.append(d);
      try {
        for (let m = this.buf.readMessage(); m; m = this.buf.readMessage()) this.onmessage?.(m);
      } catch (e) {
        this.onerror?.(e instanceof Error ? e : new Error(String(e)));
      }
    });
    p.stderr?.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    p.once('exit', () => this.onclose?.());
    await new Promise((resolve, reject) => { p.once('spawn', resolve); p.once('error', reject); });
    spawn(process.execPath, ['-e', GUARD, String(process.pid), String(p.pid)], { detached: true, stdio: 'ignore' }).unref();
  }

  /** @param {any} m */
  async send(m) {
    this.proc?.stdin?.write(serializeMessage(m));
  }

  /** SIGTERM to the whole group, SIGKILL after a grace period; resolves once the process has exited. The group is
   * signalled even when its leader is already gone: what it started may still be running. */
  async close() {
    const p = this.proc;
    if (!p) return;
    const kill = (/** @type {NodeJS.Signals} */ sig) => { try { process.kill(-(/** @type {number} */ (p.pid)), sig); } catch { /* gone */ } };
    if (p.exitCode !== null || p.signalCode !== null) return void kill('SIGKILL');
    kill('SIGTERM');
    const hard = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
    await this.exited;
    clearTimeout(hard);
    kill('SIGKILL'); // anything of the group still left
  }
}

/** @param {string} a @param {string} b */
function atLeast(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  if (x.length !== 3 || x.some((n) => !Number.isInteger(n) || n < 0)) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}

/** The flow file Kav will load: the user's (KFW_HOME/recipes) over the built-in one. @param {string} dir @param {string} kfwHome @param {string} flow */
function flowFile(dir, kfwHome, flow) {
  for (const f of [path.join(kfwHome, 'recipes', `${flow}.json`), path.join(dir, 'recipes', `${flow}.json`)]) {
    if (fs.existsSync(f)) {
      const text = fs.readFileSync(f, 'utf8');
      return { file: f, text, sha: createHash('sha256').update(text).digest('hex') };
    }
  }
  return null;
}

/** @param {string} dir @param {string} kfwHome @param {string} flow */
const flowSha = (dir, kfwHome, flow) => flowFile(dir, kfwHome, flow)?.sha ?? null;

/**
 * @typedef {{ name: string, endpoint: string, policy: ReturnType<typeof import('./sites.js').sitePolicy>,
 *   config: Record<string, any>, browser: () => Promise<import('../sdk/index.js').Browser>, alias: (targetId: string) => string,
 *   redact: import('../decisions.js').Redact,
 *   transport?: (env: Record<string, string>, dir: string) => ChildTransport }} FlowCtx
 * transport: tests pass a fake Kav; else the python of <kav.dir>/.venv runs kfw.mcp_server.
 */

/** sources: the documents Kav read content from (kept here, not shown). @typedef {{ head: Record<string, any>, page?: unknown, isError?: boolean, sources?: string[] }} FlowOut */

/** @param {string} status @param {Record<string, any>} [more] @returns {FlowOut} */
const refuse = (status, more = {}) => ({ head: { status, ...more }, isError: true });

/**
 * Run one flow. Never throws for the flow's own outcomes; returns what the agent sees.
 * @param {FlowCtx} ctx @param {Record<string, any>} a @param {AbortSignal} [signal]
 * @returns {Promise<FlowOut>}
 */
export async function runFlow(ctx, a, signal) {
  const flow = a.flow;
  if (typeof flow !== 'string' || !/^[a-z0-9-]{1,64}$/.test(flow)) return refuse('error', { reason: 'bad_argument', message: 'flow: a Kav flow name ([a-z0-9-])' });
  const params = a.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) return refuse('error', { reason: 'bad_argument', message: 'params: an object' });
  const timeoutS = typeof a.timeout_s === 'number' && Number.isFinite(a.timeout_s) ? Math.min(MAX_TIMEOUT_S, Math.max(1, a.timeout_s)) : DEFAULT_TIMEOUT_S;

  // Kav asks for decisions at the bridge's model exit (src/model.js), never at a model directly: the bridge decides
  // where they go (local Kev, JEV with consent, or nowhere). Kav takes its Bearer token from KFW_CDP.
  const modelUrl = `${new URL(ctx.endpoint).origin}/model`;
  const dir = typeof ctx.config.kav?.dir === 'string' ? ctx.config.kav.dir : null;
  const python = dir ? path.join(dir, '.venv', 'bin', 'python') : null;
  if (!ctx.transport && (!dir || !python || !fs.existsSync(python))) {
    return refuse('kav_unavailable', { flow, message: dir ? `no ${python}: run \`uv sync\` in ${dir}` : 'set kav.dir in ~/.k-browser/config.json' });
  }
  const kfwHome = String(ctx.config.kav?.home ?? path.join(os.homedir(), '.kav-fastweb'));

  // C7 / C5 before: the flow as Kav will load it
  const before = dir ? flowFile(dir, kfwHome, flow) : null;
  /** @type {any} */ let recipe = null;
  if (before) {
    try {
      recipe = JSON.parse(before.text);
    } catch {
      return refuse('error', { reason: 'bad_flow', flow, message: 'the flow file is not valid JSON' });
    }
    if (recipe?.recorded_from) {
      return refuse('recorded_flow', { flow, message: 'a recorded flow runs in Kav\'s own Chrome (isolated): use the kav-fastweb tools for it' });
    }
    // domains also holds search words for find_recipe (e.g. 台灣銀行): only host names are checked
    const hosts = (Array.isArray(recipe?.domains) ? recipe.domains : []).filter((/** @type {unknown} */ d) => typeof d === 'string' && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d));
    const urls = [recipe?.url, ...hosts.map((/** @type {string} */ d) => `https://${d}/`)].filter((u) => typeof u === 'string');
    for (const u of urls) if (ctx.policy.urlVerdict(u) === 'blocked') return refuse('blocked_origin', { flow, origin: originOf(u) ?? 'unknown', when: 'before' });
  } else if (dir) {
    return refuse('error', { reason: 'unknown_flow', flow, message: `no flow ${flow} in ${path.join(kfwHome, 'recipes')} or ${path.join(dir, 'recipes')}` });
  }

  // C5 during: watch first, on K-Browser's own connection (same principal); start Kav only once the watch is in place
  const b = await ctx.browser();
  const { targetInfos } = await b.client.call('Target.getTargets');
  for (const ti of targetInfos.filter((/** @type {any} */ x) => x.type === 'page')) {
    if (ctx.policy.urlVerdict(String(ti.url ?? '')) === 'blocked') {
      return refuse('blocked_origin', { flow, origin: originOf(String(ti.url)) ?? 'unknown', when: 'before', message: 'one of your tabs is on a blocked site; Kav could pick it up' });
    }
  }
  const known = new Set(targetInfos.map((/** @type {any} */ x) => x.targetId));
  /** @type {Set<string>} */ const opened = new Set();
  /** @type {FlowOut | null} the first blocked site seen during the run, even when Kav answered first */
  let blockedSeen = null;
  /** @type {(o: FlowOut) => void} */ let trip = () => {};
  /** @type {Promise<FlowOut>} */ const tripped = new Promise((resolve) => { trip = resolve; });
  const off = b.client.onEvent((ev) => {
    if (ev.method !== 'Target.targetCreated' && ev.method !== 'Target.targetInfoChanged') return;
    const ti = ev.params?.targetInfo;
    if (!ti || ti.type !== 'page') return;
    if (!known.has(ti.targetId)) opened.add(ti.targetId);
    if (ctx.policy.urlVerdict(String(ti.url ?? '')) === 'blocked') {
      blockedSeen ??= refuse('blocked_origin', { flow, origin: originOf(String(ti.url)) ?? 'unknown', when: 'during' });
      trip(blockedSeen);
    }
  });
  const poll = setInterval(() => { if (b.client.closedWhy) trip(refuse('monitor_lost', { flow })); }, WATCH_POLL_MS);
  const timer = setTimeout(() => trip(refuse('timeout', { flow })), timeoutS * 1000);
  const onAbort = () => trip(refuse('cancelled', { flow }));
  signal?.addEventListener('abort', onAbort);
  if (signal?.aborted) onAbort();

  /** @type {Record<string, string>} */ const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir(), KFW_CDP: ctx.endpoint, KFW_KEV: modelUrl, KFW_HOME: kfwHome,
  };
  decisions.sweep();
  const events = decisions.enabled() ? decisions.prepare() : null;
  // which backend answered: the setting at the start and at the end (one value when they agree; it is read per request)
  const backendAtStart = events ? /** @type {string | null} */ (model.summary().backend) : null;
  if (events) env.KFW_DECISIONS = events.file;
  const transport = ctx.transport ? ctx.transport(env, dir ?? '.') : new ChildTransport(/** @type {string} */ (python), ['-m', 'kfw.mcp_server'], env, /** @type {string} */ (dir));
  const client = new Client({ name: 'k-browser', version: '0' });
  /** @type {FlowOut} */ let out;
  let kavVersion = null;
  try {
    const ran = (async () => {
      await client.connect(/** @type {any} */ (transport));
      kavVersion = client.getServerVersion()?.version ?? null;
      if (!kavVersion || !atLeast(kavVersion, KAV_MIN_VERSION)) {
        return refuse('kav_unsupported', { flow, kav_version: kavVersion || null, message: `Kav ${KAV_MIN_VERSION} or later is needed (answer validation, decision events)` });
      }
      const r = await client.callTool({ name: 'run_recipe', arguments: { name: flow, params, allow_stateful: a.allow_stateful === true } },
        undefined, { timeout: (timeoutS + 30) * 1000 });
      return fromKav(r, flow, kavVersion, a.detail === true);
    })();
    ran.catch(() => {}); // when tripped first, its rejection (the connection closing) is expected
    const first = await Promise.race([ran.then((o) => ({ o, tripped: false })), tripped.then((o) => ({ o, tripped: true }))]);
    out = first.o;
    if (!first.tripped) {
      // Kav answered. Late watch events still count (the listener stays on until the end); a round trip on the watch
      // connection comes back behind every event the bridge sent it before
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      await b.client.call('Target.getTargets').catch(() => {});
      const seen = /** @type {FlowOut | null} */ (blockedSeen); // set by the event listener
      const sources = /** @type {any} */ (out).sources;
      const blockedSource = Array.isArray(sources) ? sources.find((u) => ctx.policy.urlVerdict(u) === 'blocked') : undefined;
      if (seen) out = { ...seen, head: { ...seen.head } };
      else if (blockedSource) out = refuse('blocked_origin', { flow, origin: originOf(blockedSource) ?? 'unknown', when: 'after' });
      if (out.head.status === 'blocked_origin') {
        out.head.message = 'Kav finished, but went to a blocked site: what it read is not returned. The flow did run; its effects stay.';
        if (kavVersion) out.head.kav_version = kavVersion;
      } else if (out.page !== undefined && !(Array.isArray(sources) && sources.length > 0 && sources.every((u) => ctx.policy.urlVerdict(u) === 'allowed'))) {
        // where the content came from cannot be verified: the status stays, the content does not come back
        delete out.page;
        out.head.content = 'withheld';
        out.head.message = 'Kav did not say which pages its content came from (or one is not allowed): the content is withheld.';
      }
    }
    if (first.tripped) {
      out.head.message = `${out.head.message ? `${out.head.message}; ` : ''}Kav was stopped: the result is unknown (the flow may have run part way, `
        + 'e.g. up to the step before a submit, and commands already sent may still complete). Nothing was sent again.';
      if (kavVersion) out.head.kav_version = kavVersion;
    }
  } catch (e) {
    out = refuse('kav_unavailable', { flow, message: `Kav did not run: ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    clearInterval(poll);
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
  }
  // the tabs that showed up while it ran and are still open (maybe none: Kav closes its main tab when it is done)
  if (!b.client.closedWhy) {
    const now = await b.client.call('Target.getTargets').then((r) => r.targetInfos, () => []);
    out.head.tabs = now.filter((/** @type {any} */ x) => x.type === 'page' && opened.has(x.targetId)).map((/** @type {any} */ x) => ctx.alias(x.targetId));
  }
  off();
  if (dir && before && flowSha(dir, kfwHome, flow) !== before.sha) out.head.flow_changed = true;
  if (events) {
    try {
      const backendAtEnd = /** @type {string | null} */ (model.summary().backend);
      const got = decisions.ingest(events.file, events.runId, { flow, kav_version: kavVersion, params,
        backend: backendAtStart === backendAtEnd ? backendAtEnd : 'changed',
        declared: recipe?.params && typeof recipe.params === 'object' ? Object.keys(recipe.params) : [],
        task: { status: out.head.status ?? null, reason: out.head.reason ?? null } }, ctx.redact);
      out.head.decisions = { run_id: events.runId, recorded: got.records };
    } catch {
      out.head.decisions = { run_id: events.runId, recorded: null };
    }
  }
  return out;
}

const MAX_CHOICES = 30;

/**
 * Kav's run_recipe answer as the agent sees it: codes and numbers in the head, page-derived text (hint, rows, steps,
 * the page URL, what Kav hands back to decide) in the untrusted part. @param {any} r @param {string} flow @param {string} kavVersion @param {boolean} detail
 * @returns {FlowOut}
 */
function fromKav(r, flow, kavVersion, detail) {
  /** @type {any} */ let k;
  try {
    k = JSON.parse(String(r?.content?.[0]?.text ?? ''));
  } catch {
    return refuse('error', { reason: 'kav_bad_result', flow, kav_version: kavVersion });
  }
  if (!k || typeof k !== 'object' || typeof k.status !== 'string') return refuse('error', { reason: 'kav_bad_result', flow, kav_version: kavVersion });
  const code = (/** @type {unknown} */ v) => (typeof v === 'string' && /^[a-z_]{1,64}$/.test(v) ? v : undefined);
  const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const kev = k.kev && typeof k.kev === 'object' ? Object.fromEntries(Object.entries(k.kev).filter(([, v]) => num(v) !== undefined)) : undefined;
  const head = { status: code(k.status) ?? 'error', reason: code(k.reason), why: code(k.why), flow, kav_version: kavVersion, total_ms: num(k.total_ms), kev,
    rows_total: num(k.rows_total), rows_skipped: num(k.rows_skipped),
    evidence: typeof k.evidence?.screenshot === 'string' ? { screenshot: k.evidence.screenshot } : typeof k.evidence?.dir === 'string' ? { dir: k.evidence.dir } : undefined };
  /** @type {Record<string, any>} */ const page = {};
  for (const f of ['hint', 'rows', 'product', 'offers', 'best', 'per_site', 'page_url', 'expect_text_missing', 'note']) if (k[f] !== undefined) page[f] = k[f];
  // what Kav hands back to decide when it stops (the model off or unsure): pick / select / compare candidates
  // (Kav's run_flow candidates format); lists cut to MAX_CHOICES so a long page cannot flood the agent's context
  const cut = (/** @type {unknown} */ v) => (Array.isArray(v) ? v.slice(0, MAX_CHOICES) : v);
  for (const f of ['candidates', 'options', 'probabilities', 'values', 'field', 'suspicious', 'dropped_after_verify']) if (k[f] !== undefined) page[f] = cut(k[f]);
  if (Array.isArray(k.needs_help)) {
    page.needs_help = k.needs_help.slice(0, MAX_CHOICES).map((/** @type {any} */ x) => (x && typeof x === 'object' && Array.isArray(x.candidates) ? { ...x, candidates: cut(x.candidates) } : x));
  }
  if (detail && k.steps !== undefined) page.steps = k.steps;
  const clean = Object.fromEntries(Object.entries(head).filter(([, v]) => v !== undefined));
  const sources = Array.isArray(k.sources) ? k.sources.map((/** @type {any} */ x) => (typeof x === 'string' ? x : x?.url)).filter((/** @type {unknown} */ u) => typeof u === 'string') : null;
  return { head: clean, ...(Object.keys(page).length ? { page } : {}), ...(head.status === 'error' ? { isError: true } : {}), ...(sources ? { sources } : {}) };
}
