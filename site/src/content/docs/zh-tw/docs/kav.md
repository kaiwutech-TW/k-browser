---
title: Kav 流程(選用)
description: 透過 K-Browser 執行存好的 Kav 流程，並選擇 Kav 的判斷交給誰。
---

[Kav-FastwebAgent](https://github.com/kaiwutech-TW/kav-fastwebagent) 執行事先寫好的網站流程，速度快，每一步都不用呼叫模型。設定 Kav 之後,agent 會多一個 `run_flow` 工具，以**那個 agent 的身分**在你的 Chrome 裡跑流程，分頁歸屬和網站封鎖的規則一樣適用。沒有 Kav,K-Browser 的其他功能都能完整使用。

```sh
k-browser kav <你的 Kav 資料夾>     # 需要 Kav 0.0.8 以上，並先在那裡執行 uv sync
k-browser kav off                   # 不再提供 run_flow
```

## Kav 自己接

Kav 也可以直接接 K-Browser:先 `k-browser client add kav`,再把 `KFW_CDP` 設成 `k-browser endpoint kav` 印出來的網址。這個端點支援 Kav 用到的 Chrome DevTools Protocol 子集，並套用 K-Browser 的規則;其他 CDP 函式庫可能會碰到被拒絕的方法。

## 判斷交給誰

流程中有些步驟要判斷，例如「哪一列是使用者要的」。Kav 會問橋接，橋接依你的設定轉送:

| `k-browser model …` | 判斷交給誰 |
|---|---|
| `kev`(預設) | 本機的 Kev 模型。 |
| `jev` | TypeSafe 的雲端 JEV 模型。打開前會列出會送出什麼，請你同意。金鑰存在 `~/.k-browser/jev.key`,不會寫進任何 agent 的設定。送出前會遮掉密碼、token、卡號、手機號碼等(規則式)。有封鎖網站的 client 不能用 JEV。 |
| `off` | 不交給模型:Kav 把候選項目交回給 agent 自己選。 |

側邊面板也能切換。改回 `kev` 或 `off` 後，從下一個問題起就不再送雲端。

## 決策資料集(預設關閉)

在 `~/.k-browser/config.json` 設 `"decisionLog": "on"`(或在側邊面板打開),`run_flow` 期間 Kav 做的每個判斷會遮罩後存在 `~/.k-browser/decisions/`,保留 30 天，方便之後比較不同模型。`k-browser decisions purge` 會全部刪除。
