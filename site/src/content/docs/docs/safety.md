---
title: Safety model
description: Ownership, focus, re-checked input, blocked sites, untrusted page text, hand-offs and revocation.
---

K-Browser is built on one assumption: an agent driving your signed-in browser must be easy to watch, easy to stop, and
unable to wander.

## Ownership

Every tab belongs to the client that opened it, and so do the popups that tab opens. A client cannot list, read or act on
anything else — not your tabs, not another agent's. Each agent has its own token, so the bridge always knows who is
asking.

## Never steals focus

Agent tabs open in a separate K-Browser window that is never brought to the front. Input reaches the page without taking
your keyboard, so you can keep working while an agent works.

## Real input, re-checked

Clicks and typing go through Chrome's input pipeline, like a person's. Right before each press, K-Browser checks that the
target is still the element the agent meant. If the page moved underneath, it stops instead of clicking something else,
and says how far it got.

## Blocked site categories

At install you choose the categories agents may not use:

| Category | Covers |
|---|---|
| `banking` | Online banking |
| `payments` | Payment services |
| `email` | Email |
| `government` | Government sites |
| `crypto` | Crypto exchanges |
| `passwords` | Password managers |

Each agent can block different categories, and you can change them later in the side panel. A tab that lands on a blocked
site answers only `blocked_origin`; screenshots of a tab showing a blocked frame are refused.

## Page text is data

Everything taken from a page comes back wrapped in `<untrusted-page-content>`, so the agent can tell it apart from your
instructions. Password fields are never read. Tokens, card numbers and similar values are masked in network logs.

## Hand-offs

For a login, a captcha or a decision, the agent hands the tab to you. The extension's popup shows **Show** and
**Return**; until you return it, every tool on that tab answers `handed_off`. K-Browser never brings the tab
forward on its own.

## Watching and revoking

The side panel lists every agent's tabs and actions as they happen. Revoke an agent there and its access ends at once.
The activity log can also be written to disk.

## Risky tools are off by default

`eval` runs JavaScript in the page (in an isolated world, but still able to change the page). It stays off until you turn
it on for one specific client. Screenshots can be turned off per client.

## What it does not promise

Masking is rule-based and cannot catch every piece of personal data. Blocked categories and the untrusted-content wrapper
reduce risk; they do not make it safe to point an agent at sites you would not trust it with.
