---
title: 總覽
description: K-Browser 是什麼、三個部分怎麼配合，以及它絕對不做的事。
---

K-Browser 讓你 Mac 上的 agent(Claude Code、Codex、Antigravity、Gemini CLI)使用**你自己的 Chrome**:用你已經登入的狀態，在你看得到的視窗裡操作。

agent 只看得到、只操作得了**它自己開的分頁**。你的其他分頁不會被列出、讀取或碰到。

## 運作方式

```
 Claude Code ─┐                                         ┌──────────────────────────────┐
 Codex ───────┤ MCP (stdio)     ┌──────────────────┐    │ 你的 Chrome                  │
 Antigravity ─┼───────────────▶ │ 橋接             │◀──▶│  K-Browser 擴充              │
 Gemini CLI ──┘  各自一個 token │ 127.0.0.1:9444   │ ws │  (只對 agent 自己的分頁     │
                                │ (LaunchAgent)    │    │   使用 chrome.debugger)      │
 Kav ───────────────────────────▶ CDP 端點         │    └──────────────────────────────┘
                 自己的 token   └──────────────────┘
```

- **橋接**:在 `127.0.0.1:9444` 常駐的小型 Node.js 服務，登入 macOS 時由 LaunchAgent 自動啟動。它確認是誰在要求、套用每個 client 的規則、遮掉秘密、留下活動紀錄。
- **Chrome 擴充**:裝在你的 Chrome 裡，替橋接操作 agent 的分頁。要先用配對碼配對，才會連上橋接。
- **MCP server**:每家 agent 各一份，各自有自己的 token 和權限。

## 它絕對不做的事

- 讀取、列出或操作不是 agent 自己開的分頁。
- 把視窗拉到前面，或搶走你的鍵盤。
- 替你登入、解驗證碼或做決定：這些時候 agent 會把分頁交給你。
- 把任何東西送出你的電腦：除非你替 [Kav 流程](/zh-tw/docs/kav/)選了雲端模型，並同意送出的內容。

## 接下來

- [安裝](/zh-tw/docs/install/):大約十分鐘。
- [安全設計](/zh-tw/docs/safety/):你怎麼保有控制權。
- [agent 工具](/zh-tw/docs/tools/):agent 拿到的 15 個工具。
