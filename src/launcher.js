// @ts-check
// What a launcher copy (see locate.js) does with a command: `install` puts the same version at <home>/app and runs
// install from there; everything else is run by <home>/app. Returns null when this copy should run the command itself
// (nothing was ever installed at <home>/app: `doctor` before installing, the release test). What the launcher itself
// says goes to stderr: stdout belongs to the command it hands on (an agent's MCP stdio for `mcp`).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { CLIENTS, ENTRY, InstallError, withLock } from './install.js';
import { plistArgs, plistPath } from './launchd.js';
import { AppError, appCli, appDir, compareVersions, delegate, everInstalled, recover, specFor, stage, swapIn, usable } from './locate.js';
import { VERSION } from './version.js';

/** @param {string} p */
function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Is this cli.js <home>/app's? @param {string} cli */
const isAppCli = (cli) => cli === appCli() || (real(cli) !== null && real(cli) === real(appCli()));

/** @typedef {(cmd: string, args: string[]) => { status: number | null, stdout: string, missing?: boolean }} Run */
/** @type {Run} */
const realRun = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? '', missing: /** @type {any} */ (r.error)?.code === 'ENOENT' };
};

/**
 * K-Browser installed from somewhere other than <home>/app (a git clone): the LaunchAgent, or an agent's "k-browser"
 * MCP entry, running a K-Browser cli.js elsewhere. Only reads.
 * @param {{ run?: Run, plist?: string }} [o] @returns {{ where: string, cli: string }[]}
 */
export function otherInstalls({ run = realRun, plist = plistPath() } = {}) {
  /** @type {{ where: string, cli: string }[]} */ const found = [];
  const looks = (/** @type {unknown} */ cli) => typeof cli === 'string' && /(^|\/)cli\.js$/.test(cli) && !isAppCli(cli);
  try {
    const argv = plistArgs(fs.readFileSync(plist, 'utf8'));
    if (argv && argv.at(-1) === 'bridge' && looks(argv[1])) found.push({ where: plist, cli: /** @type {string} */ (argv[1]) });
  } catch { /* no LaunchAgent */ }
  for (const [name, spec] of Object.entries(CLIENTS)) {
    /** @type {any} */ let entry = null;
    if (spec.kind === 'json') {
      try {
        entry = JSON.parse(fs.readFileSync(spec.file(), 'utf8'))?.mcpServers?.[ENTRY] ?? null;
      } catch { /* no such file, or not ours to judge */ }
    } else {
      const r = run(spec.cmd, spec.get);
      if (!r.missing && r.status === 0) entry = spec.parse(r.stdout);
    }
    if (entry && Array.isArray(entry.args) && entry.args[1] === 'mcp' && looks(entry.args[0])) found.push({ where: name, cli: entry.args[0] });
  }
  return found;
}

/**
 * @param {string[]} argv everything after `k-browser`, as given @param {string} cmd @param {string[]} rest after the command
 * @param {{ say?: (s: string) => void, run?: Run }} [o] @returns {Promise<number | null>}
 */
export async function launcherMain(argv, cmd, rest, { say = (s) => console.error(s), run } = {}) {
  try {
    if (cmd === 'install') return await install(argv, rest, { say, run });
    if (usable().ok) return await delegate(argv);
    if (!everInstalled()) {
      if (cmd === 'update') {
        console.error('K-Browser is not installed here yet: run `npx k-browser@latest install`');
        return 1;
      }
      return null;
    }
    await withLock(async () => recover(say));
    const u = usable();
    if (!u.ok) {
      console.error(`the K-Browser install at ${appDir()} cannot be used (${u.why}): run \`npx k-browser@latest install\` again`);
      return 1;
    }
    return await delegate(argv);
  } catch (e) {
    console.error(e instanceof AppError || e instanceof InstallError || e instanceof Error ? e.message : String(e));
    return 1;
  }
}

/** @param {string[]} argv @param {string[]} rest @param {{ say: (s: string) => void, run?: Run }} o */
async function install(argv, rest, { say, run }) {
  const others = otherInstalls({ run });
  if (others.length) {
    console.error(`K-Browser is already installed from ${[...new Set(others.map((o) => o.cli))].join(', ')} `
      + `(${others.map((o) => o.where).join(', ')}). Nothing was changed.\n`
      + 'Keep using it (`k-browser update` there), or to switch to the npx install see "Switching from a git clone" in the README.');
    return 1;
  }
  const have = usable();
  const newer = have.ok && compareVersions(have.version, VERSION) > 0;
  if (rest.includes('--dry-run')) {
    if (!have.ok || have.version !== VERSION) {
      say(newer ? `(dry run) ${appDir()} has ${have.ok && have.version}, newer than this ${VERSION}: kept`
        : `(dry run) would put k-browser ${VERSION} at ${appDir()}`);
    }
    if (have.ok) return delegate(argv);
    say(`(dry run) what install would register is shown once K-Browser is at ${appDir()}; nothing was changed`);
    return 0;
  }
  await withLock(async () => {
    recover(say);
    const now = usable();
    if (now.ok && compareVersions(now.version, VERSION) >= 0) {
      say(now.version === VERSION ? `K-Browser ${VERSION} is at ${appDir()}` : `${appDir()} has ${now.version}, newer than this ${VERSION}: kept`);
      return;
    }
    const v = stage(specFor(VERSION), { say });
    swapIn();
    say(`K-Browser ${v} is at ${appDir()}`);
  });
  // the lock is let go first: install there takes it itself
  return delegate(argv);
}
