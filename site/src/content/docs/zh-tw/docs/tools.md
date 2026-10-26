---
title: agent 工具
description: agent 透過 K-Browser 的 MCP server 拿到的工具。
---

| 工具 | 做什麼 |
|---|---|
| `tabs` | 列出、開啟或關閉 agent 自己的分頁(在背景開)。 |
| `navigate` | 在分頁載入網址，或重新整理。回傳動作 id,給 `wait_for` 和 `network` 用。 |
| `snapshot` | 頁面的無障礙樹，可互動的元素有 ref。 |
| `read` | 整頁或某個元素的可見文字，或用 CSS selector 抓出一列列資料。密碼欄位永遠不讀。 |
| `act` | 點擊、打字、按鍵、選擇、捲動：真的輸入，每一步按之前再確認。 |
| `wait_for` | 判斷動作成功沒：畫面變了、網站回應了，或業務結果確認了。 |
| `network` | 分頁裡的請求，可以要回應內容。秘密會遮掉，不給 header。 |
| `fetch` | 用分頁的 cookie,對分頁自己的網域做 GET 或 HEAD。跨網域和轉址會被拒絕。 |
| `files` | agent 自己的檔案區：下載進來(最多 25 MB)、從這裡上傳到檔案欄位。 |
| `screenshot` | 可見頁面或某個元素的 PNG。不會存檔，可以對個別 client 關掉。 |
| `needs_human` | 把分頁交給你(登入、驗證碼、決定)並等你交還。 |
| `learnings` | 存在本機的網站筆記:API、障礙、陷阱、技巧。筆記只是資訊，不是指令。 |
| `status` | 版本、agent 的分頁和交接、哪些工具有開。 |
| `eval` | 在隔離環境執行 JavaScript 運算式。**預設關閉。** |
| `run_flow` | 執行存好的 [Kav 流程](/zh-tw/docs/kav/)。有設定 Kav 才會出現。 |

每個結果的第一行都是 K-Browser 自己的 JSON;頁面來的內容接在後面，包在 `<untrusted-page-content>` 裡。

## 一次典型的操作

1. `tabs` 在背景開一個分頁,`navigate` 載入網站。
2. `snapshot` 或 `read` 看頁面上有什麼。
3. `act` 點擊和打字,`wait_for` 確認成功。
4. 碰到登入?`needs_human` 把分頁交給你，你交還後 agent 繼續。
