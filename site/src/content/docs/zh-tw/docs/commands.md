---
title: 指令與側邊面板
description: 平常會用到的 k-browser 指令，以及側邊面板能改什麼。
---

## 平常會用到的指令

| 要做什麼 | 指令 |
|---|---|
| 檢查一切是否正常 | `k-browser doctor` |
| 重開橋接(更新程式後) | `k-browser service restart`,接著在 `chrome://extensions` 按 K-Browser 的 ↻(不要移除) |
| 列出 / 新增 / 移除 client | `k-browser client list`、`client add <名稱>`、`client remove <名稱>` |
| 讓某個 client 可以用 `eval` | `k-browser client set <名稱> --eval on`,之後重開那個 agent |
| 給 CDP 程式端點 | `k-browser endpoint <名稱>`(網址裡含 token,不要貼到別處) |
| 管理網站筆記 | `k-browser learnings list / add / remove / export / import` |
| 還原 install 改過的檔案 | `k-browser restore <backup.json>` |
| 移除 K-Browser 的所有登記 | `k-browser uninstall`(只移除 K-Browser 自己的設定項目與 token) |

## 側邊面板

點 K-Browser 圖示，按「開啟活動面板」。面板跟著系統的淺色或深色主題。

- 每個 agent 的分頁和動作，即時更新。
- 等你處理的交接。
- 對每個 agent:撤銷、關閉它的分頁、改它封鎖的網站類別、開關它的截圖、關掉 `eval`。
- Kav 的判斷交給哪個模型，以及決策資料集有沒有開(見 [Kav 流程](/zh-tw/docs/kav/))。

封鎖網站、截圖和 `eval` 的變更，要等那個 agent 重開或重連它的 MCP 才生效。

## 活動紀錄存到磁碟

在 `~/.k-browser/config.json` 設 `"activityLog": "disk"`,紀錄會寫到 `~/.k-browser/activity/`,保留 7 天。
