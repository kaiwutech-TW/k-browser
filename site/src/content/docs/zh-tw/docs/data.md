---
title: 資料存在哪
description: K-Browser 存的東西都在 ~/.k-browser,只有你讀得到。
---

全部在 `~/.k-browser/`(可用 `KBROWSER_HOME` 改位置)。資料夾和檔案都只有你讀得到。

| 路徑 | 內容 |
|---|---|
| `pair.key` | 配對碼 |
| `clients/<名稱>.json` | 每個 client 的 token 和設定 |
| `config.json` | 設定:`activityLog`、`decisionLog`、`kav`、模型選擇 |
| `files/` | 每個 client 各自的檔案區 |
| `learnings/` | 網站筆記 |
| `activity/` | 活動紀錄，設了 `"activityLog": "disk"` 才有(7 天) |
| `decisions/` | 決策資料集，打開才有(30 天) |
| `jev.key` | JEV 金鑰，選了 `jev` 才有 |

截圖永遠不存檔。不要把這個資料夾同步到雲端或分享出去。
