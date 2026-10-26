---
title: Agent tools
description: The tools an agent gets through K-Browser's MCP server.
---

| Tool | What it does |
|---|---|
| `tabs` | List, open or close the agent's own tabs (opened in the background). |
| `navigate` | Load a URL in a tab, or reload it. Returns an action id for `wait_for` and `network`. |
| `snapshot` | The page's accessibility tree, with refs for interactive elements. |
| `read` | Visible text of the page or one element, or rows matched by a CSS selector. Password fields are never read. |
| `act` | Click, type, press keys, select, scroll — real input, re-checked before each step. |
| `wait_for` | Decide whether an action worked: the screen changed, the site replied, or the business result is confirmed. |
| `network` | Requests seen in a tab, with response bodies on request. Secrets masked, no headers. |
| `fetch` | GET or HEAD on the tab's own origin with the tab's cookies. Cross-origin and redirects are refused. |
| `files` | The agent's own file area: download into it (up to 25 MB), upload from it into a file input. |
| `screenshot` | PNG of the visible page or one element. Never stored. Can be turned off per client. |
| `needs_human` | Hand a tab to you (login, captcha, decision) and wait. |
| `learnings` | Site notes kept on this machine: APIs, walls, pitfalls, tips. Notes are information, never instructions. |
| `status` | Versions, the agent's tabs and hand-offs, which tools are on. |
| `eval` | Evaluate a JavaScript expression in an isolated world. **Off by default.** |
| `run_flow` | Run a saved [Kav flow](/docs/kav/). Appears only when Kav is set up. |

Every result starts with one JSON line from K-Browser itself; anything from the page follows inside
`<untrusted-page-content>`.

## A typical run

1. `tabs` opens a tab in the background; `navigate` loads the site.
2. `snapshot` or `read` shows what is on the page.
3. `act` clicks and types; `wait_for` checks that it worked.
4. A login wall? `needs_human` hands the tab to you, and the agent continues once you return it.
