---
title: Troubleshooting
description: Common situations and what to do.
---

**Start with `k-browser doctor`.** It reports the bridge, the pairing and the extension, and what to do next.

### After a bridge restart the agent cannot find its earlier tabs

On purpose: rather than guess which tabs were whose, K-Browser lets them go. Close them by hand.

### The agent reports `bridge_version`

The bridge and the agent's MCP server run different versions. If the bridge is older, run `k-browser service restart`; if
the agent is, restart it or reconnect its MCP server.

### Chrome shows "… started debugging this browser"

That is Chrome's fixed notice when an extension uses the debugger API. Pages cannot see it.

### The popup says the bridge is not connected

The bridge is not running; a new pairing code will not help. Run `k-browser doctor`, then `k-browser service restart`.

### The pairing code was wrong

The status turns red and the field comes back. Paste the code `k-browser pair` prints.

### `install` refuses to run inside an agent

It needs your answer about blocked site categories. Pass it on the command line: `--block banking,email`, or
`--block ""` for none.
