---
title: Troubleshooting
description: Common situations and what to do.
---

**Start with `k-browser doctor`.** It reports the bridge, the pairing and the extension, and what to do next.

### After a bridge restart the agent cannot find its earlier tabs

On purpose: rather than guess which tabs were whose, K-Browser lets them go. Close them by hand.

### The agent reports `bridge_version`

The bridge and the agent's MCP server run different versions. If the bridge is older, run `k-browser service restart`; if
the agent is, restart it or reconnect its MCP server. From 0.5.0 on, an agent's MCP server follows updates by itself
(after `k-browser service restart`); one started before 0.5.0 needs reconnecting once.

### `chrome://extensions` still shows an old version

Chrome runs the extension from the folder you chose with **Load unpacked**, and does not reload it when the files change.
After `git pull` or `k-browser update`, click ↻ for K-Browser at `chrome://extensions`, in each Chrome profile. If it
still shows the old version, look at the path on the K-Browser card (Developer mode on): it must be the folder
`k-browser extension-path` prints. If it is another copy (an older clone), click **Remove**, **Load unpacked** the right
folder and pair it again.

### Chrome shows "… started debugging this browser"

That is Chrome's fixed notice when an extension uses the debugger API. Pages cannot see it.

### The popup says the bridge is not connected

The bridge is not running; a new pairing code will not help. Run `k-browser doctor`, then `k-browser service restart`.

### The pairing code was wrong

The status turns red and the field comes back. Paste the code `k-browser pair` prints.

### `install` refuses to run inside an agent

It needs your answer about blocked site categories. Pass it on the command line: `--block banking,email`, or
`--block ""` for none.
