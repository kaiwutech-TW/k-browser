---
title: Overview
description: What K-Browser is, how its three parts fit together, and what it never does.
---

K-Browser lets the agents on your Mac — Claude Code, Codex, Antigravity, Gemini CLI — use **your own Chrome**: the one you
are already signed in to, in a window you can watch.

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

- **Bridge** — a small Node.js service on `127.0.0.1:9444`, started at login by a macOS LaunchAgent. It checks who is
  asking, enforces each client's policy, masks secrets and keeps the activity log.
- **Chrome extension** — runs in your Chrome and works the agents' tabs for the bridge. It connects to the bridge only after
  you pair it with a pairing code.
- **MCP server** — one per agent, each with its own token and its own permissions.

## What it never does

- Read, list or act on a tab an agent did not open.
- Bring its window to the front or take your keyboard.
- Log in, solve a captcha or decide for you: the agent hands the tab to you instead.
- Send anything off your machine, unless you choose the cloud model for [Kav flows](/docs/kav/) and agree to what is sent.

## Next

- [Install](/docs/install/) — about ten minutes.
- [Safety model](/docs/safety/) — what keeps you in control.
- [Agent tools](/docs/tools/) — the 15 tools an agent gets.
