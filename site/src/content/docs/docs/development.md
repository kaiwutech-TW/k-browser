---
title: Development
description: Running the tests and working on K-Browser.
---

```sh
npm test              # unit tests
npm run typecheck     # tsc --checkJs over src/, extension/ and test/
npm run test:chrome   # end-to-end in Chrome for Testing with the real extension
npm run test:pack     # npm pack, install the tarball elsewhere, run what got installed
```

- **Chrome for Testing.** Branded Chrome no longer loads unpacked extensions from the command line, so `test:chrome` uses
  Chrome for Testing: set `KBROWSER_TEST_CHROME` to its binary, or run `npx playwright install chromium` and the newest one
  in Playwright's cache is used (Apple silicon). Without it these tests are skipped. `KBROWSER_TEST_HEADED=1` shows the window.
- **Isolation.** Tests never use your `~/.k-browser` or the bridge on port 9444; each one starts its own.
- **Kav.** Tests against a real Kav run when `KBROWSER_TEST_KAV` points at a Kav checkout (or one sits next to the repo),
  and are skipped otherwise.
- **Versions.** `package.json` and `extension/manifest.json` carry the same version; a test checks it. Bump both when the
  bridge or the extension changes, so `doctor` can tell old code from new.

## Code map

| Path | What |
|---|---|
| `src/server.js`, `src/relay.js` | The bridge: websocket server, CDP relay, ownership |
| `src/policy.js` | Which CDP methods a client may send |
| `src/mcp/` | The MCP server and its tools |
| `src/sdk/` | Snapshots, refs and re-checked input |
| `src/redact.js` | Masking of secrets |
| `extension/` | The Chrome extension (service worker, popup, side panel) |
| `test/` | Unit tests; `test/integration/` runs in real Chrome |
