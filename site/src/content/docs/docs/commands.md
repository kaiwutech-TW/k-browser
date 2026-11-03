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
| Let a client use `eval` | `k-browser client set <name> --eval on` (from its next call) |
| Manage the paired Chrome profiles | `k-browser profile list`, `rename <old> <new>`, `remove <name>`, `default <name>` |
| Give a CDP program its endpoint | `k-browser endpoint <name>` (the URL contains a token; keep it private) |
| Manage site notes | `k-browser learnings list / add / remove / export / import` |
| Put back a file install changed | `k-browser restore <backup.json>` |
| Remove everything K-Browser registered | `k-browser uninstall` (only K-Browser's own entries and tokens) |

## Several Chrome profiles

**Several Chrome profiles.** Load the extension in each Chrome profile you want agents to use (work, personal...) and
paste the **same** code in each. From the second profile on, also give it a name in the popup. Agents then pick one with
`tabs {action: "open", profile: "work"}` (default: the profile paired first, or `k-browser profile default <name>`);
`status` and `tabs list` say which profile each tab is in. Every agent can use every paired profile. Manage them with
`k-browser profile list | rename | remove | default`. A removed profile stays out until you pair it again from its popup.

## Side panel

Click the K-Browser icon and open the activity panel. It follows your system's light or dark theme.

- Each agent's tabs and its actions, as they happen.
- Hand-offs waiting for you.
- Per agent: revoke it, close its tabs, change its blocked site categories, turn its screenshots on or off, turn `eval` off.
- Which model Kav's judgement calls go to, and whether the decision dataset is on (see [Kav flows](/docs/kav/)).

Changes to blocked sites, screenshots and `eval` take effect from that agent's next K-Browser call (an agent started
before 0.5.0: after reconnecting its MCP server once).

## Activity log on disk

Set `"activityLog": "disk"` in `~/.k-browser/config.json`. Logs go to `~/.k-browser/activity/` and are kept for 7 days.
