#!/usr/bin/env node
// @ts-check
// k-browser command line.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { readConfig } from './activity.js';
import * as auth from './auth.js';
import * as decisions from './decisions.js';
import * as learnings from './learnings.js';
import * as model from './model.js';
import { redactor } from './redact.js';
import { install, InstallError, restore } from './install.js';
import { LABEL, probePort, rotateLogs, ServiceError, serviceInstall, serviceRestart, serviceStatus, serviceUninstall } from './launchd.js';
import { serveMcp } from './mcp/server.js';
import { CATEGORIES } from './sites.js';
import { DEFAULT_PORT, startBridge } from './server.js';
import { EXTENSION_ID, VERSION } from './version.js';

const EXTENSION_DIR = fileURLToPath(new URL('../extension', import.meta.url));

/** @param {number} port @param {string} token */
const endpoint = (port, token) => `http://127.0.0.1:${port}/c/${token}`;

const USAGE = `usage: k-browser [--port N] <command>

  bridge                 run the bridge in the foreground
  pair [--rotate]        show (or rotate) the extension pairing code
  client add|remove|list [name]   named client tokens (one per agent / program)
  client set <name> --eval on|off   let that client use the eval tool (off by default)
  endpoint <name>        print a client's CDP endpoint (for KFW_CDP etc.)
  mcp --client <name>    MCP server on stdio (the token is read from the client's file)
  install [--dry-run] [--client claude-code|codex|antigravity|gemini-cli|all] [--block banking,email,...|""] [--no-service]
          [--kav <dir>|none] [--model kev|off|jev [--consent] [key options as for model jev]]
                         register K-Browser with your agents (each gets its own token); for all of them (the default)
                         also run the bridge as a LaunchAgent (unless --no-service)
  uninstall [--dry-run] [--client ...]   remove only K-Browser's entries and tokens (all: and the LaunchAgent)
  service install|uninstall|status|restart [--dry-run]   the bridge as a macOS LaunchAgent (${LABEL})
  restore [--force] <backup.json>  put a configuration file back as it was before install / uninstall
                         (refused if it changed since K-Browser wrote it, unless --force)
  decisions purge | teach <decision_id> <option_id> --source claude|human
                         the local decision dataset (on with "decisionLog": "on" in ~/.k-browser/config.json)
  learnings list [domain] | add <domain> <api|wall|pitfall|tip> <note…> | remove <id> | export [domain…] | import <file.jsonl>
                         site notes (import asks about each note)
  model [kev [--url U] | off | jev [--consent] [--key-stdin | --key-env-file F --key-var NAME] | jev --forget-key]
                         where Kav's decisions go: the local Kev (default), TypeSafe's JEV (shows what is sent, asks to
                         agree, keeps the key in ~/.k-browser/jev.key), or nowhere (handed back to the agent)
  kav [<dir> | off]      the Kav checkout run_flow uses (needs <dir>/.venv)
  doctor                 check bridge, pairing and extension
  extension-path         print the unpacked extension directory`;

/** @param {string[]} argv */
export async function main(argv) {
  let port = DEFAULT_PORT;
  const args = [...argv];
  const i = args.indexOf('--port');
  if (i >= 0) {
    port = Number(args[i + 1]);
    args.splice(i, 2);
  }
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'bridge': {
      const b = await startBridge({ port });
      console.error(`k-browser bridge ${VERSION} on 127.0.0.1:${b.port}`);
      rotateLogs();
      setInterval(rotateLogs, 3600e3).unref(); // a bridge runs for weeks under launchd
      const stop = () => void b.close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return 0;
    }
    case 'pair': {
      const rotate = rest.includes('--rotate');
      const key = auth.pairKey({ create: true, rotate });
      if (rotate) fs.rmSync(auth.profileFile(), { force: true }); // the next profile to pair becomes the one
      console.log(`Pairing code (paste into the K-Browser extension popup):\n\n  ${key}\n`);
      if (rotate) console.log('The old code no longer works and the connected extension is dropped: paste the new code to reconnect.');
      return 0;
    }
    case 'client': {
      const [action, name] = rest;
      if (action === 'list') {
        for (const n of auth.clients().keys()) console.log(n);
        return 0;
      }
      if (action === 'set') {
        // eval stays off unless the user turns it on here; the panel only shows it
        const v = rest[rest.indexOf('--eval') + 1];
        if (!name || !rest.includes('--eval') || !['on', 'off'].includes(v)) break;
        if (!auth.clientRecord(name)) {
          console.error(`no client ${JSON.stringify(name)}: see \`k-browser client list\``);
          return 1;
        }
        auth.updateClient(name, { eval: v === 'on' });
        console.log(`${name}: eval ${v} (restart that agent, or reconnect its k-browser MCP server, for it to take effect)`);
        return 0;
      }
      if (!name || !['add', 'remove'].includes(action)) break;
      if (action === 'add') console.log(endpoint(port, auth.addClient(name)));
      else console.log(auth.removeClient(name) ? 'removed (connections close within a second)' : 'no such client');
      return 0;
    }
    case 'endpoint': {
      const token = rest[0] && auth.clients().get(rest[0]);
      if (!token) {
        console.error(`no client ${JSON.stringify(rest[0] ?? '')}: run \`k-browser client add <name>\``);
        return 1;
      }
      console.log(endpoint(port, token));
      return 0;
    }
    case 'mcp': {
      const j = rest.indexOf('--client');
      const name = j >= 0 ? rest[j + 1] : undefined;
      if (!name) break;
      return serveMcp({ name, port });
    }
    case 'install':
    case 'uninstall': {
      const opt = (/** @type {string} */ f) => { const k = rest.indexOf(f); return k >= 0 ? rest[k + 1] : undefined; };
      const dryRun = rest.includes('--dry-run');
      let block = opt('--block')?.split(',').map((x) => x.trim()).filter(Boolean);
      if (cmd === 'install' && block === undefined && process.stdin.isTTY) {
        console.log('要替 agent 封鎖哪些高風險網站類別?(之後可在 ~/.k-browser/clients/<名稱>.json 的 blockedOrigins 修改)');
        for (const [k, c] of Object.entries(CATEGORIES)) console.log(`  ${k.padEnd(11)} ${c.label}`);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question('輸入類別(逗號分隔，直接 Enter = 不封鎖): ');
        rl.close();
        block = answer.split(',').map((x) => x.trim()).filter(Boolean);
      } else if (cmd === 'install' && block === undefined) {
        // no terminal to ask in (`!` in an agent, a background shell): never decide "block nothing" silently
        const ask = `沒有終端機可以詢問要封鎖哪些網站類別(${Object.keys(CATEGORIES).join(', ')})。` +
          '請加上 --block <類別,…>;確定都不封鎖就加 --block ""';
        if (!dryRun) {
          console.error(ask);
          return 2;
        }
        console.log(`(dry run)${ask}`);
      }
      // Kav and the model: not asked without a terminal; the defaults (no Kav, the local Kev) send nothing
      // off this machine, so unlike --block they never stop the install
      let kavDir = opt('--kav');
      let modelChoice = opt('--model');
      if (cmd === 'install' && process.stdin.isTTY && !dryRun && (kavDir === undefined || modelChoice === undefined)) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        if (kavDir === undefined) kavDir = (await rl.question('要讓 run_flow 接 Kav 嗎?輸入 Kav 資料夾路徑(直接 Enter = 不接): ')).trim() || 'none';
        if (modelChoice === undefined) {
          modelChoice = (await rl.question('Kav 的判斷模型:kev(本機,預設)/ jev(雲端,會先說明送出什麼並請你同意)/ off(交回 agent): ')).trim() || 'kev';
        }
        rl.close();
      }
      if (modelChoice !== undefined && !['kev', 'jev', 'off'].includes(modelChoice)) {
        console.error('--model: kev, jev or off');
        return 2;
      }
      const all = (opt('--client') ?? 'all') === 'all' && !rest.includes('--no-service');
      try {
        const r = await install({ client: opt('--client'), dryRun, block: block ?? [], uninstall: cmd === 'uninstall' });
        let code = r.ok ? 0 : 1;
        if (cmd === 'install' && r.ok) {
          if (dryRun) {
            if (kavDir && kavDir !== 'none') console.log(`(dry run) would set Kav to ${path.resolve(kavDir)}`);
            if (modelChoice) console.log(`(dry run) would set the model to ${modelChoice}`);
          } else {
            if (kavDir && kavDir !== 'none') code = Math.max(code, kavCommand([kavDir]));
            if (modelChoice) {
              const pass = ['--consent', '--key-stdin'].filter((f) => rest.includes(f));
              for (const f of ['--key-env-file', '--key-var']) if (opt(f) !== undefined) pass.push(f, /** @type {string} */ (opt(f)));
              code = Math.max(code, await modelCommand([modelChoice, ...pass]));
            }
          }
        }
        if (!all) return code;
        const s = cmd === 'install' ? await serviceInstall({ port, dryRun }) : await serviceUninstall({ port, dryRun });
        return code === 0 && s.ok ? 0 : code || 1;
      } catch (e) {
        console.error(e instanceof InstallError || e instanceof Error ? e.message : String(e));
        return 1;
      }
    }
    case 'service': {
      const dryRun = rest.includes('--dry-run');
      try {
        switch (rest[0]) {
          case 'install': return (await serviceInstall({ port, dryRun })).ok ? 0 : 1;
          case 'uninstall': return (await serviceUninstall({ port, dryRun })).ok ? 0 : 1;
          case 'restart': serviceRestart({ port, dryRun }); return 0;
          case 'status': console.log(JSON.stringify(serviceStatus({ port }), null, 2)); return 0;
        }
      } catch (e) {
        console.error(e instanceof ServiceError || e instanceof Error ? e.message : String(e));
        return 1;
      }
      break;
    }
    case 'restore': {
      const file = rest.find((x) => x !== '--force');
      if (!file) break;
      try {
        console.log(`restored ${restore(file, { force: rest.includes('--force') })}`);
        return 0;
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        return 1;
      }
    }
    case 'learnings': {
      const r = redactor({ secrets: [auth.pairKey(), ...auth.clients().values()] });
      try {
        switch (rest[0]) {
          case 'list':
          case 'export': {
            const notes = rest[0] === 'list' && rest[1] ? learnings.get(rest[1]) : learnings.exportNotes(rest.slice(1));
            for (const n of notes) console.log(rest[0] === 'export' ? JSON.stringify(n) : `${n.id}  ${n.domain}  [${n.kind}]  ${n.author}  ${n.note}`);
            return 0;
          }
          case 'add':
            if (!rest[1] || !rest[2] || !rest[3]) break;
            console.log(learnings.add({ domain: rest[1], kind: rest[2], note: rest.slice(3).join(' '), author: 'user', principal: null, redact: (x) => r.text(x) }).id);
            return 0;
          case 'remove':
            console.log(`removed ${learnings.remove(rest[1], null).id}`);
            return 0;
          case 'import': {
            if (!rest[1]) break;
            if (!process.stdin.isTTY) {
              console.error('import asks about each note: run it in a terminal');
              return 1;
            }
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const got = await learnings.importNotes(rest[1], async (n) => {
              console.log(`\n${n.domain}  [${n.kind}]  (from ${n.author})\n  ${n.note}`);
              return /^y(es)?$/i.test((await rl.question('import this note? [y/N] ')).trim());
            }, (x) => r.text(x));
            rl.close();
            console.log(`imported ${got.added}, skipped ${got.skipped}`);
            return 0;
          }
        }
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        return 1;
      }
      break;
    }
    case 'decisions': {
      if (rest[0] === 'purge') {
        decisions.purge();
        console.log(`deleted ${decisions.dir()}`);
        return 0;
      }
      const src = rest[rest.indexOf('--source') + 1];
      if (rest[0] === 'teach' && rest[1] && rest[2] && rest.includes('--source') && (src === 'claude' || src === 'human')) {
        decisions.teach(rest[1], rest[2], src);
        return 0;
      }
      break;
    }
    case 'doctor': {
      /** @type {Record<string, any>} */
      const report = { version: VERSION, extensionDir: EXTENSION_DIR, extensionId: EXTENSION_ID,
        paired: auth.pairKey() !== null, clients: [...auth.clients().keys()] };
      const service = serviceStatus({ port });
      report.launchAgent = service.loaded ? `loaded${service.pid ? ` (pid ${service.pid})` : ' (not running)'}` : service.plist ? 'plist present, not loaded' : 'not installed';
      const p = await probePort(port);
      if (p.kind === 'bridge') {
        const h = p.health;
        Object.assign(report, { bridge: 'running', bridgeVersion: h.version, startedBy: service.pid !== null && h.pid === service.pid ? 'launchd' : 'by hand',
          extensionOnline: Boolean(h.extension), extensionVersion: h.extensionVersion ?? null });
      } else {
        Object.assign(report, { bridge: p.kind === 'other' ? `not running (port ${port} is in use by ${p.who})` : 'not running', extensionOnline: false });
      }
      // an older bridge does not report the extension's version: unknown, not a mismatch
      const extMismatch = report.extensionOnline && typeof report.extensionVersion === 'string' && report.extensionVersion !== VERSION;
      const versionsMatch = report.bridge !== 'running' || (report.bridgeVersion === VERSION && !extMismatch);
      report.model = model.summary();
      report.ok = report.bridge === 'running' && report.extensionOnline && report.paired && versionsMatch && report.model.problem !== 'config_unreadable';
      const next = [];
      if (report.model.problem === 'config_unreadable') next.push('~/.k-browser/config.json cannot be read or understood: Kav gets no model at all until it is fixed (see `k-browser model`)');
      else if (report.model.problem === 'cloud_not_enabled') next.push('JEV is chosen without a current consent (or model.url is not local): run `k-browser model jev` or `k-browser model kev`');
      else if (report.model.problem === 'jev_key_missing') next.push('JEV has no usable key: run `k-browser model jev` to import one');
      if (!report.paired) next.push('run `k-browser pair`, then paste the code into the extension popup');
      if (report.bridge !== 'running') next.push('start the bridge: `k-browser service install` (runs it at login) or `k-browser bridge`');
      else if (!report.extensionOnline) next.push(`load ${EXTENSION_DIR} at chrome://extensions (Developer mode -> Load unpacked) and pair it`);
      if (report.bridge === 'running' && report.bridgeVersion !== VERSION) {
        next.push(`the bridge runs ${report.bridgeVersion}, this is ${VERSION}: ${report.startedBy === 'launchd' ? '`k-browser service restart`' : 'restart `k-browser bridge`'}`);
      }
      if (extMismatch) {
        next.push(`the extension is ${report.extensionVersion}, this is ${VERSION}: reload it at chrome://extensions`);
      }
      if (next.length) report.next = next;
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
    case 'model': {
      try {
        return await modelCommand(rest);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        return 1;
      }
    }
    case 'kav': {
      try {
        return kavCommand(rest);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        return 1;
      }
    }
    case 'extension-path':
      console.log(EXTENSION_DIR);
      return 0;
  }
  console.error(USAGE);
  return 2;
}

/** A line typed without echo (the JEV key). @param {string} prompt */
async function hidden(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  process.stdout.write(prompt);
  /** @type {any} */ (rl)._writeToOutput = () => {};
  try {
    return (await rl.question('')).trim();
  } finally {
    rl.close();
    process.stdout.write('\n');
  }
}

/** All of stdin. */
async function readStdin() {
  /** @type {Buffer[]} */ const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** k-browser model …: show, or choose where Kav's decisions go. @param {string[]} rest */
export async function modelCommand(rest) {
  const [choice] = rest;
  const opt = (/** @type {string} */ f) => { const k = rest.indexOf(f); return k >= 0 ? rest[k + 1] : undefined; };
  if (choice === undefined) {
    console.log(JSON.stringify(model.summary(), null, 2));
    return 0;
  }
  if (choice === 'kev' || choice === 'off') {
    model.choose(choice, { kevUrl: opt('--url') });
    console.log(choice === 'kev' ? 'Kav 的判斷改用本機 Kev。' : 'Kav 的判斷模型已關閉:需要判斷的步驟會交回 agent。');
    return 0;
  }
  if (choice !== 'jev') throw new Error('k-browser model kev|off|jev');
  if (rest.includes('--forget-key')) {
    model.forgetJevKey();
    console.log('JEV 金鑰已刪除。');
    return 0;
  }
  const tty = process.stdin.isTTY === true;
  for (const line of model.CONSENT_TEXT) console.log(line);
  const limited = [...auth.clients().keys()].filter((n) => model.restricted(auth.clientRecord(n)));
  if (limited.length) console.log(`\n這些 client 有網站限制,不能用 JEV:${limited.join(', ')}`);
  // the key first: a consent without a usable key would only fail later
  let key = null;
  const envFile = opt('--key-env-file');
  if (envFile !== undefined) {
    const name = opt('--key-var');
    if (!name) throw new Error('--key-env-file needs --key-var <NAME>');
    key = model.envValue(fs.readFileSync(path.resolve(envFile), 'utf8'), name);
    if (key === null) throw new Error(`${name} is not in ${envFile}`);
  } else if (rest.includes('--key-stdin')) {
    key = await readStdin();
  } else if (model.jevKey() === null) {
    if (!tty) throw new Error('no JEV key: add --key-env-file <file> --key-var <NAME>, or --key-stdin');
    key = await hidden('\n貼上 JEV 金鑰(不會顯示): ');
  }
  if (rest.includes('--consent')) {
    // said on the command line
  } else if (tty) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('\n同意以上內容並改用 JEV?(y/N) ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      console.log('沒有變更。');
      return 1;
    }
  } else {
    console.error('沒有終端機可以詢問同意:讀完上面的說明後,加上 --consent 再執行一次。');
    return 2;
  }
  if (key !== null) model.saveJevKey(key);
  model.choose('jev');
  console.log('Kav 的判斷改用 JEV。隨時可以 `k-browser model kev` 改回本機。');
  return 0;
}

/** k-browser kav [<dir> | off]: the Kav checkout run_flow uses. @param {string[]} rest */
export function kavCommand(rest) {
  const [arg] = rest;
  if (arg === undefined) {
    console.log(readConfig().kav?.dir ?? '(not set)');
    return 0;
  }
  if (arg === 'off') {
    model.updateConfig((c) => { delete c.kav; });
    console.log('run_flow 不再接 Kav(重開 agent 後生效)。');
    return 0;
  }
  const dir = path.resolve(arg);
  if (!fs.existsSync(path.join(dir, '.venv', 'bin', 'python'))) throw new Error(`${dir}/.venv/bin/python is missing: run \`uv sync\` in ${dir} first`);
  if (!fs.existsSync(path.join(dir, 'kfw'))) throw new Error(`${dir} does not look like a Kav checkout (no kfw/)`);
  model.updateConfig((c) => { c.kav = { ...(c.kav ?? {}), dir }; });
  console.log(`run_flow 會用 ${dir} 的 Kav(重開 agent 後生效)。`);
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { if (code !== 0) process.exitCode = code; });
}
