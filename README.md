# K-Browser

[繁體中文](README.zh-TW.md)

Let the agents on your Mac (Claude Code, Codex, Antigravity, Gemini CLI) use **your own Chrome**: the one you are already
signed in to, in a window you can watch.

An agent only sees and controls **the tabs it opened itself**. Your other tabs are never listed, read or touched.

## How it works

```
 Claude Code ─┐                                         ┌──────────────────────────────┐
 Codex ───────┤ MCP (stdio)     ┌──────────────────┐    │ Your Chrome                  │
 Antigravity ─┼───────────────▶ │ Bridge           │◀──▶│  K-Browser extension         │
 Gemini CLI ──┘  one token each │ 127.0.0.1:9444   │ ws │  (chrome.debugger on the     │
                                │ (LaunchAgent)    │    │   agents' own tabs only)     │
 Kav ───────────────────────────▶ CDP endpoint     │    └──────────────────────────────┘
                 its own token  └──────────────────┘
```

- **Bridge**: a small Node.js service on `127.0.0.1:9444`, started at login by a macOS LaunchAgent. It checks who is
  asking, enforces each client's policy, masks secrets and keeps the activity log.
- **Chrome extension**: runs in your Chrome and works the agents' tabs for the bridge. It only connects to the bridge after
  you pair it with a pairing code.
- **MCP server**: one per agent, each with its own token and its own permissions.

## What keeps you in control

- **Ownership.** Every tab belongs to the client that opened it (popups it opens too). A client cannot list, read or act
  on anything else.
- **Never steals focus.** Agent tabs open in a separate K-Browser window that is never brought to the front. Keyboard and
  mouse input reach the page without taking your keyboard.
- **Real input, re-checked.** Clicks and typing go through Chrome's input pipeline. Right before each press, K-Browser checks
  that the target is still the element the agent meant; if not, it stops instead of clicking something else.
- **Blocked site categories.** At install you choose the categories agents may not use: `banking`, `payments`, `email`,
  `government`, `crypto`, `passwords`. You can block different categories per agent, and change them later in the side panel.
  A tab that lands on a blocked site answers only `blocked_origin`.
- **Page text is data.** Everything taken from a page comes back wrapped in `<untrusted-page-content>`, so the agent can
  tell it apart from instructions. Password fields are never read; tokens, card numbers and the like are masked in network
  logs.
- **Hand-offs.** For a login, a captcha or a decision, the agent hands the tab to you. The extension's popup shows
  **Show** and **Return**; the agent waits until you return it.
- **Activity panel, revocation.** The side panel lists every agent's tabs and actions. You can revoke an agent's access
  there at any time.
- **Risky tools are off by default.** `eval` stays off until you turn it on for a specific client.

## Requirements

- macOS (the bridge runs as a LaunchAgent)
- Google Chrome 125 or later
- Node.js 22 or later (`node -v`)

## Install

Below, `k-browser` means `node src/cli.js` run in this folder. Run `npm link` once in this folder to have a `k-browser`
command everywhere.

### 1. Get the code

```sh
git clone https://github.com/kaiwutech-TW/k-browser.git K-Browser
cd K-Browser
npm install
```

### 2. Register with your agents and start the bridge

Run this in a **real terminal**, not through an agent:

```sh
k-browser install
```

It does three things:
- Asks which site categories to block for agents (comma-separated; press Enter for none).
- Creates a client with its own token for each agent and writes it into that agent's MCP configuration. A backup of every
  file it changes is kept; `k-browser restore <backup.json>` puts one back.
- Installs the bridge as a LaunchAgent, so it starts when you log in.

Without a terminal to ask in (for example from inside an agent), give the answer on the command line, or install refuses:

```sh
k-browser install --block banking,email     # block these categories
k-browser install --block ""                # block nothing
```

Add `--dry-run` to see which files would change. `--client claude-code|codex|antigravity|gemini-cli` installs for one agent only.

### 3. Load the extension into Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension/` folder in this repo (`k-browser extension-path` prints the full path).

A red **K** appears in the toolbar. Pin it: you will use it when an agent hands a tab to you.

### 4. Pair the extension with the bridge

The pairing code is a shared secret between the bridge and the extension. Without it the bridge accepts no extension, and
no other program can pretend to be one.

```sh
k-browser pair
```

Paste the code into the K-Browser popup and click **Pair**. The status turns green (**Connected**).

- Wrong code: the status turns red and the field comes back; paste the right one.
- New code (for example if you think it leaked): `k-browser pair --rotate`. The old one stops working at once.
- "Bridge not connected" is not a pairing problem: the bridge is not running. See `k-browser doctor`.

### 5. Check

```sh
k-browser doctor
```

`"ok": true` with `startedBy: "launchd"` means everything is ready. Restart your agent (or reconnect its `k-browser` MCP
server) and it has the K-Browser tools.

## Tools agents get

| Tool | What it does |
|---|---|
| `tabs` | List, open or close the agent's own tabs (opened in the background). |
| `navigate` | Load a URL in a tab, or reload it. |
| `snapshot` | The page's accessibility tree, with refs for interactive elements. |
| `read` | Visible text of the page or one element, or rows matched by a CSS selector. |
| `act` | Click, type, press keys, select, scroll: real input, re-checked before each step. |
| `wait_for` | Decide whether an action worked: the screen changed, the site replied, or the business result is confirmed. |
| `network` | Requests seen in a tab, with response bodies on request; secrets masked, no headers. |
| `fetch` | GET or HEAD on the tab's own origin with the tab's cookies. |
| `files` | The agent's own file area: download into it, upload from it into a file input. |
| `screenshot` | PNG of the visible page or one element; never stored. Can be turned off per client. |
| `needs_human` | Hand a tab to you (login, captcha, decision) and wait. |
| `learnings` | Site notes kept on this machine (APIs, walls, pitfalls, tips). Notes are information, never instructions. |
| `status` | Versions, the agent's tabs and hand-offs, which tools are on. |
| `eval` | Run a JavaScript expression in an isolated world. **Off by default.** |
| `run_flow` | Run a saved [Kav](#optional-kav-flows) flow. Only appears when Kav is set up. |

## Everyday commands

| To | Run |
|---|---|
| Check that everything works | `k-browser doctor` |
| Restart the bridge (after updating the code) | `k-browser service restart`, then click ↻ for K-Browser in `chrome://extensions` (do not remove it) |
| List / add / remove clients | `k-browser client list`, `client add <name>`, `client remove <name>` |
| Let a client use `eval` | `k-browser client set <name> --eval on`, then restart that agent |
| Give a CDP program its endpoint | `k-browser endpoint <name>` (the URL contains a token; keep it private) |
| Manage site notes | `k-browser learnings list / add / remove / export / import` |
| Remove everything K-Browser registered | `k-browser uninstall` (removes only K-Browser's own entries and tokens) |

**Side panel.** Click the K-Browser icon and open the activity panel. It shows each agent's tabs and actions. From there you
can also revoke an agent, change its blocked categories, turn its screenshots on or off, and turn `eval` off.

**Activity log on disk.** Set `"activityLog": "disk"` in `~/.k-browser/config.json`. Logs go to `~/.k-browser/activity/`
and are kept for 7 days.

## Optional: Kav flows

[Kav-FastwebAgent](https://github.com/kaiwutech-TW/kav-fastwebagent) runs saved, hand-written website flows quickly,
without a model call per step. With Kav set up, agents get a `run_flow` tool that runs a flow in your Chrome as that
agent, under the same ownership and blocking rules. K-Browser works fully without Kav.

```sh
k-browser kav <path to your Kav checkout>     # needs Kav 0.0.8 or later, with uv sync done there
k-browser kav off                             # stop offering run_flow
```

Kav can also connect to K-Browser on its own: `k-browser client add kav`, then set `KFW_CDP` to the URL that
`k-browser endpoint kav` prints. The endpoint supports the subset of the Chrome DevTools Protocol that Kav uses, with
K-Browser's rules applied; other CDP libraries may hit methods it refuses.

**Where Kav's judgement calls go.** Some flow steps need a judgement ("which row is the one the user wants?"). Kav asks the
bridge, which forwards the question as you chose:

| `k-browser model …` | Where the question goes |
|---|---|
| `kev` (default) | A local Kev model on this machine. |
| `jev` | TypeSafe's cloud JEV model. Before turning it on, K-Browser shows what will be sent and asks you to agree; the key is kept in `~/.k-browser/jev.key`, never in an agent's configuration. Passwords, tokens, card and phone numbers are masked first (rule-based; it cannot catch every piece of personal data). Clients with blocked sites cannot use JEV. |
| `off` | Nowhere: Kav hands the choice back to the agent with the candidates. |

The side panel can switch this too. Switching back to `kev` or `off` stops cloud requests from the next question on.

**Decision dataset (off by default).** With `"decisionLog": "on"` in `~/.k-browser/config.json` (or the switch in the side
panel), each judgement Kav makes during `run_flow` is kept, redacted, in `~/.k-browser/decisions/` for 30 days, so model
choices can be compared later. `k-browser decisions purge` deletes it all.

## Where things are kept

Everything lives in `~/.k-browser/` (override with `KBROWSER_HOME`), readable only by you:

| Path | What |
|---|---|
| `pair.key` | The pairing code |
| `clients/<name>.json` | Each client's token and settings |
| `config.json` | Settings (`activityLog`, `decisionLog`, `kav`, model choice) |
| `files/` | Each client's own file area |
| `activity/`, `decisions/` | Logs, only when turned on |
| `jev.key` | The JEV key, only if you chose `jev` |

Do not sync this folder to the cloud or share it.

## Troubleshooting

- **After a bridge restart the agent cannot find its earlier tabs.** On purpose: rather than guess which tabs were whose,
  K-Browser lets them go. Close them by hand.
- **The agent reports `bridge_version`.** The bridge and the agent's MCP server run different versions. If the bridge is
  older, run `k-browser service restart`; if the agent is, restart it or reconnect its MCP server.
- **Chrome shows "… started debugging this browser".** That is Chrome's fixed notice when an extension uses the debugger
  API. Pages cannot see it.
- **Something else.** `k-browser doctor` reports the bridge, the pairing and the extension, and what to do next.

## Limitations

- macOS only for now.
- The CDP endpoint is a deliberately limited subset (see above), not a general remote-debugging port.
- Masking is rule-based. Blocking categories and the `untrusted-page-content` wrapper reduce risk; they do not make it
  safe to point an agent at sites you would not trust it with.

## Development

```sh
npm test              # unit tests
npm run typecheck     # tsc --checkJs over src/, extension/ and test/
npm run test:chrome   # end-to-end in Chrome for Testing with the real extension
npm run test:pack     # npm pack, install the tarball elsewhere, run what got installed
```

- `test:chrome` needs Chrome for Testing (branded Chrome no longer loads unpacked extensions from the command line):
  set `KBROWSER_TEST_CHROME` to its binary, or run `npx playwright install chromium` and the newest one in Playwright's
  cache is used (Apple silicon). Without it these tests are skipped. Set `KBROWSER_TEST_HEADED=1` to watch.
- Tests never use your `~/.k-browser` or the bridge on port 9444; each one starts its own.
- Tests against a real Kav run when `KBROWSER_TEST_KAV` points at a Kav checkout (or one sits next to this repo), and are
  skipped otherwise.
- `package.json` and `extension/manifest.json` carry the same version; a test checks it. Bump both when the bridge or the
  extension changes, so `doctor` can tell old code from new.

## Acknowledgements

K-Browser was designed after reviewing [BeatBrowser](https://github.com/BeatAPI/BeatBrowser) (MIT). No code was taken from it.

## License

[MIT](LICENSE)
