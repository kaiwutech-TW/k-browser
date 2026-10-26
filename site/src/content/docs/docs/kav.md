---
title: Kav flows (optional)
description: Run saved Kav flows through K-Browser, and choose where Kav's judgement calls go.
---

[Kav-FastwebAgent](https://github.com/kaiwutech-TW/kav-fastwebagent) runs saved, hand-written website flows quickly,
without a model call per step. With Kav set up, agents get a `run_flow` tool that runs a flow in your Chrome **as that
agent**, under the same ownership and blocking rules. K-Browser works fully without Kav.

```sh
k-browser kav <path to your Kav checkout>     # needs Kav 0.0.8 or later, with uv sync done there
k-browser kav off                             # stop offering run_flow
```

## Kav on its own

Kav can also connect to K-Browser directly: `k-browser client add kav`, then set `KFW_CDP` to the URL that
`k-browser endpoint kav` prints. The endpoint supports the subset of the Chrome DevTools Protocol that Kav uses, with
K-Browser's rules applied; other CDP libraries may hit methods it refuses.

## Where judgement calls go

Some flow steps need a judgement — "which row is the one the user wants?". Kav asks the bridge, which forwards the
question as you chose:

| `k-browser model …` | Where the question goes |
|---|---|
| `kev` (default) | A local Kev model on this machine. |
| `jev` | TypeSafe's cloud JEV model. Before turning it on, K-Browser shows what will be sent and asks you to agree. The key is kept in `~/.k-browser/jev.key`, never in an agent's configuration. Passwords, tokens, card and phone numbers are masked first (rule-based). Clients with blocked sites cannot use JEV. |
| `off` | Nowhere: Kav hands the choice back to the agent, with the candidates. |

The side panel can switch this too. Switching back to `kev` or `off` stops cloud requests from the next question on.

## Decision dataset (off by default)

With `"decisionLog": "on"` in `~/.k-browser/config.json` (or the switch in the side panel), each judgement Kav makes during
`run_flow` is kept, redacted, in `~/.k-browser/decisions/` for 30 days, so model choices can be compared later.
`k-browser decisions purge` deletes it all.
