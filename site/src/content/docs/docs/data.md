---
title: Where data is kept
description: Everything K-Browser stores lives in ~/.k-browser, readable only by you.
---

Everything lives in `~/.k-browser/` (override with `KBROWSER_HOME`). Directories and files are readable only by you.

| Path | What |
|---|---|
| `pair.key` | The pairing code |
| `clients/<name>.json` | Each client's token and settings |
| `config.json` | Settings: `activityLog`, `decisionLog`, `kav`, model choice |
| `files/` | Each client's own file area |
| `learnings/` | Site notes |
| `activity/` | Activity log, only with `"activityLog": "disk"` (7 days) |
| `decisions/` | Decision dataset, only when turned on (30 days) |
| `jev.key` | The JEV key, only if you chose `jev` |

Screenshots are never stored. Do not sync this folder to the cloud or share it.
