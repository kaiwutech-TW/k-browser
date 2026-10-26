---
title: 開發與測試
description: 跑測試、參與 K-Browser 開發。
---

```sh
npm test              # 單元測試
npm run typecheck     # 對 src/、extension/、test/ 做 tsc --checkJs
npm run test:chrome   # 在 Chrome for Testing 裡用真的擴充跑端到端測試
npm run test:pack     # npm pack 後裝到別處，跑裝出來的那份
```

- **Chrome for Testing**:品牌版 Chrome 已經不能從命令列載入未封裝擴充，所以 `test:chrome` 用 Chrome for Testing。把 `KBROWSER_TEST_CHROME` 設成它的執行檔，或執行 `npx playwright install chromium`,會用 Playwright 快取裡最新的那份(Apple Silicon)。沒有的話這些測試會略過。`KBROWSER_TEST_HEADED=1` 會顯示視窗。
- **隔離**:測試不會用到你的 `~/.k-browser`,也不會連 9444 的橋接;每個測試都自己開一個。
- **Kav**:`KBROWSER_TEST_KAV` 指向 Kav 資料夾(或 repo 旁邊就有 Kav)時，會跑接真 Kav 的測試，否則略過。
- **版本**:`package.json` 和 `extension/manifest.json` 的版本要一致，有測試會檢查。改了橋接或擴充就兩個一起升版,`doctor` 才分得出舊程式。

## 程式地圖

| 路徑 | 內容 |
|---|---|
| `src/server.js`、`src/relay.js` | 橋接:websocket 服務、CDP 轉送、分頁歸屬 |
| `src/policy.js` | client 可以送哪些 CDP 方法 |
| `src/mcp/` | MCP server 和它的工具 |
| `src/sdk/` | snapshot、ref 和按之前再確認的輸入 |
| `src/redact.js` | 秘密遮罩 |
| `extension/` | Chrome 擴充(service worker、彈出視窗、側邊面板) |
| `test/` | 單元測試;`test/integration/` 在真 Chrome 裡跑 |
