---
title: 常見問題
description: 常見狀況和處理方式。
---

**先執行 `k-browser doctor`。** 它會回報橋接、配對和擴充的狀態，以及下一步該做什麼。

### 橋接重開後,agent 說找不到之前的分頁

這是刻意的。K-Browser 寧可放掉舊分頁，也不靠猜測認回來，免得把無關的分頁當成 agent 的。之前開的分頁請手動關掉。

### agent 回報 `bridge_version`

橋接和 agent 的 MCP server 版本不一致。橋接比較舊，就 `k-browser service restart`;agent 比較舊，就重開 agent 或重連它的 MCP。

### Chrome 上方出現「正在偵錯此瀏覽器」

這是 Chrome 對擴充使用偵錯介面的固定提示，網頁本身看不到。

### 彈出視窗顯示「橋接未連線」

橋接沒在執行，換配對碼沒有用。執行 `k-browser doctor`,再 `k-browser service restart`。

### 配對碼貼錯了

狀態會變成紅色，配對欄位會再出現。貼上 `k-browser pair` 印出來的碼即可。

### 在 agent 裡執行 `install` 被拒絕

它需要你回答要封鎖哪些網站類別。把答案寫在指令上:`--block banking,email`,或 `--block ""` 表示都不封鎖。
