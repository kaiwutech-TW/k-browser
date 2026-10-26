---
title: Commands & side panel
description: Everyday k-browser commands and what the side panel can change.
---

## Everyday commands

| To | Run |
|---|---|
| Check that everything works | `k-browser doctor` |
| Restart the bridge (after updating) | `k-browser service restart`, then click ↻ for K-Browser in `chrome://extensions` (do not remove it) |
| List / add / remove clients | `k-browser client list`, `client add <name>`, `client remove <name>` |
| Let a client use `eval` | `k-browser client set <name> --eval on`, then restart that agent |
| Give a CDP program its endpoint | `k-browser endpoint <name>` (the URL contains a token; keep it private) |
| Manage site notes | `k-browser learnings list / add / remove / export / import` |
| Put back a file install changed | `k-browser restore <backup.json>` |
| Remove everything K-Browser registered | `k-browser uninstall` (only K-Browser's own entries and tokens) |

## Side panel

Click the K-Browser icon and open the activity panel. It follows your system's light or dark theme.

- Each agent's tabs and its actions, as they happen.
- Hand-offs waiting for you.
- Per agent: revoke it, close its tabs, change its blocked site categories, turn its screenshots on or off, turn `eval` off.
- Which model Kav's judgement calls go to, and whether the decision dataset is on (see [Kav flows](/docs/kav/)).

Changes to blocked sites, screenshots and `eval` take effect when that agent restarts or reconnects its MCP server.

## Activity log on disk

Set `"activityLog": "disk"` in `~/.k-browser/config.json`. Logs go to `~/.k-browser/activity/` and are kept for 7 days.
