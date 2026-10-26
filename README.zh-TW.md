# K-Browser

[English](README.md)

讓你 Mac 上的 agent(Claude Code、Codex、Antigravity、Gemini CLI)使用**你自己的 Chrome**:用你已經登入的狀態，在你看得到的視窗裡操作。

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
- **Chrome 擴充**:裝在你的 Chrome 裡，替橋接操作 agent 的分頁。要先用配對碼配對，它才會連上橋接。
- **MCP server**:每家 agent 各一份，各自有自己的 token 和權限。

## 你怎麼保有控制權

- **分頁歸屬**:每個分頁屬於開它的 client(它開出來的彈出視窗也是)。其他東西 client 都列不出、讀不到、動不了。
- **不搶焦點**:agent 的分頁開在獨立的 K-Browser 視窗，這個視窗永遠不會被拉到前面。鍵盤和滑鼠輸入直接送進頁面，不會搶走你的鍵盤。
- **真的輸入，按之前再確認**:點擊和打字走 Chrome 的輸入管線。每次按下去之前，K-Browser 會確認目標還是 agent 原本要的那個元素;不是的話就停下來，不會點到別的東西。
- **封鎖網站類別**:安裝時選擇 agent 不能用的類別:`banking`(網路銀行)、`payments`(支付)、`email`(電子郵件)、`government`(政府網站)、`crypto`(加密貨幣交易所)、`passwords`(密碼管理器)。每個 agent 可以封鎖不同類別，之後也能在側邊面板改。分頁一進到被封鎖的網站，只會回 `blocked_origin`。
- **頁面文字只是資料**:從頁面拿到的內容都包在 `<untrusted-page-content>` 裡，agent 分得出那不是指令。密碼欄位永遠不讀;網路紀錄裡的 token、卡號等會遮掉。
- **交給你處理**:要登入、輸入驗證碼或做決定時,agent 會把分頁交給你。擴充的彈出視窗會出現「**顯示**」和「**交還**」;你交還之前 agent 會一直等。
- **活動面板、隨時撤銷**:側邊面板列出每個 agent 的分頁和動作，也可以在這裡隨時撤銷某個 agent 的權限。
- **高風險工具預設關閉**:`eval` 要你對特定 client 打開才能用。

## 需求

- macOS(橋接以 LaunchAgent 執行)
- Google Chrome 125 以上
- Node.js 22 以上(`node -v` 確認)

## 安裝

以下的 `k-browser` 指的是在這個資料夾裡執行 `node src/cli.js`。想在任何地方直接打 `k-browser`,可以在這個資料夾執行一次 `npm link`。

### 1. 取得程式

```sh
git clone https://github.com/kaiwutech-TW/k-browser.git K-Browser
cd K-Browser
npm install
```

### 2. 登記到你的 agent,並啟動橋接

請在**真正的終端機**裡執行，不要透過 agent 執行:

```sh
k-browser install
```

它會做三件事:
- 問你要替 agent 封鎖哪些網站類別(用逗號分隔;直接按 Enter 表示都不封鎖)。
- 替每家 agent 建立自己的 client(各自的 token),寫進它們的 MCP 設定。每個被改的檔案都會留備份,`k-browser restore <backup.json>` 可以還原。
- 把橋接裝成 LaunchAgent,登入後自動啟動。

沒有終端機可以問問題時(例如在 agent 裡執行),必須直接把答案寫在指令上，否則安裝會拒絕執行:

```sh
k-browser install --block banking,email     # 封鎖這些類別
k-browser install --block ""                # 確定都不封鎖
```

想先看會改哪些檔案，可以加 `--dry-run`。只裝給一家 agent:`--client claude-code|codex|antigravity|gemini-cli`。

### 3. 把擴充載入 Chrome

1. Chrome 網址列打開 `chrome://extensions`
2. 打開右上角的「**開發人員模式**」
3. 按「**載入未封裝項目**」,選這個資料夾裡的 `extension/`(完整路徑可用 `k-browser extension-path` 查)

工具列會出現 K-Browser 的圖示(紅色的 K)。建議把它釘選在工具列上,agent 把分頁交給你時會用到。

### 4. 配對：讓擴充和橋接互相認得

配對碼是橋接和擴充之間的共用密鑰。沒有配對碼，橋接不會接受任何擴充連線，別的程式也冒充不了擴充。

```sh
k-browser pair
```

畫面會印出配對碼(第一次執行時建立，存在 `~/.k-browser/pair.key`)。點工具列的 K-Browser 圖示，把配對碼貼進「配對碼」欄位，按「**配對**」,狀態變成綠色的「**已連線**」就完成了。

- **配對碼錯了**:狀態變成紅色的「錯誤」,配對欄位會再出現，重新貼正確的碼即可。
- **想換配對碼**(例如懷疑外洩):`k-browser pair --rotate`。舊碼立刻失效，已連線的擴充會被斷開;把新碼貼進擴充即可。已經連線時，按彈出視窗裡的「重新配對…」打開欄位。
- **狀態是「橋接未連線」**:這不是配對的問題，是橋接沒在執行。請執行 `k-browser doctor` 看原因。

### 5. 確認

```sh
k-browser doctor
```

看到 `"ok": true`,而且 `startedBy` 是 `launchd`,就全部就緒。接著**重開你的 agent**(或在 agent 裡重連 k-browser 的 MCP),它就有 K-Browser 的工具可以用了。

## agent 拿到的工具

| 工具 | 做什麼 |
|---|---|
| `tabs` | 列出、開啟或關閉 agent 自己的分頁(在背景開)。 |
| `navigate` | 在分頁載入網址，或重新整理。 |
| `snapshot` | 頁面的無障礙樹，可互動的元素有 ref。 |
| `read` | 整頁或某個元素的可見文字，或用 CSS selector 抓出一列列資料。 |
| `act` | 點擊、打字、按鍵、選擇、捲動：真的輸入，每一步按之前再確認。 |
| `wait_for` | 判斷動作成功沒：畫面變了、網站回應了，或業務結果確認了。 |
| `network` | 分頁裡的請求，可以要回應內容;秘密會遮掉，不給 header。 |
| `fetch` | 用分頁的 cookie,對分頁自己的網域做 GET 或 HEAD。 |
| `files` | agent 自己的檔案區：下載進來、從這裡上傳到檔案欄位。 |
| `screenshot` | 可見頁面或某個元素的 PNG,不會存檔。可以對個別 client 關掉。 |
| `needs_human` | 把分頁交給你(登入、驗證碼、決定)並等你交還。 |
| `learnings` | 存在本機的網站筆記(API、障礙、陷阱、技巧)。筆記只是資訊，不是指令。 |
| `status` | 版本、agent 的分頁和交接、哪些工具有開。 |
| `eval` | 在隔離環境執行 JavaScript 運算式。**預設關閉。** |
| `run_flow` | 執行存好的 [Kav](#選用kav-流程) 流程。有設定 Kav 才會出現。 |

## 平常會用到的

| 要做什麼 | 指令 |
|---|---|
| 檢查一切是否正常 | `k-browser doctor` |
| 重開橋接(更新程式後) | `k-browser service restart`,接著在 `chrome://extensions` 按 K-Browser 的 ↻(不要移除) |
| 列出 / 新增 / 移除 client | `k-browser client list`、`client add <名稱>`、`client remove <名稱>` |
| 讓某個 client 可以用 `eval` | `k-browser client set <名稱> --eval on`,之後重開那個 agent |
| 給 CDP 程式端點 | `k-browser endpoint <名稱>`(端點裡含 token,不要貼到別處) |
| 管理網站筆記 | `k-browser learnings list / add / remove / export / import` |
| 移除 K-Browser 的所有登記 | `k-browser uninstall`(只移除 K-Browser 自己的設定項目與 token) |

**側邊面板**:點 K-Browser 圖示，按「開啟活動面板」。面板會列出每個 agent 的分頁和動作紀錄。也可以在這裡撤銷某個 agent、改它封鎖的網站類別、開關它的截圖，以及關掉 `eval`。

**活動紀錄存到磁碟**:在 `~/.k-browser/config.json` 設 `"activityLog": "disk"`,紀錄會寫到 `~/.k-browser/activity/`,保留 7 天。

## 選用:Kav 流程

[Kav-FastwebAgent](https://github.com/kaiwutech-TW/kav-fastwebagent) 執行事先寫好的網站流程，速度快，每一步都不用呼叫模型。設定 Kav 之後,agent 會多一個 `run_flow` 工具，以那個 agent 的身分在你的 Chrome 裡跑流程，分頁歸屬和網站封鎖的規則一樣適用。沒有 Kav,K-Browser 的其他功能都能完整使用。

```sh
k-browser kav <你的 Kav 資料夾>     # 需要 Kav 0.0.8 以上，並先在那裡執行 uv sync
k-browser kav off                   # 不再提供 run_flow
```

Kav 也可以自己接 K-Browser:先 `k-browser client add kav`,再把 `KFW_CDP` 設成 `k-browser endpoint kav` 印出來的網址。這個端點支援 Kav 用到的 Chrome DevTools Protocol 子集，並套用 K-Browser 的規則;其他 CDP 函式庫可能會碰到被拒絕的方法。

**Kav 的判斷交給誰**:流程中有些步驟要判斷(例如「哪一列是使用者要的」)。Kav 會問橋接，橋接依你的設定轉送:

| `k-browser model …` | 判斷交給誰 |
|---|---|
| `kev`(預設) | 本機的 Kev 模型。 |
| `jev` | TypeSafe 的雲端 JEV 模型。打開前會列出會送出什麼，請你同意;金鑰存在 `~/.k-browser/jev.key`,不會寫進任何 agent 的設定。送出前會遮掉密碼、token、卡號、手機號碼等(規則式，擋不住所有個資)。有封鎖網站的 client 不能用 JEV。 |
| `off` | 不交給模型:Kav 把候選項目交回給 agent 自己選。 |

側邊面板也能切換。改回 `kev` 或 `off` 後，從下一個問題起就不再送雲端。

**決策資料集(預設關閉)**:在 `~/.k-browser/config.json` 設 `"decisionLog": "on"`(或在側邊面板打開),`run_flow` 期間 Kav 做的每個判斷會遮罩後存在 `~/.k-browser/decisions/`,保留 30 天，方便之後比較不同模型。`k-browser decisions purge` 會全部刪除。

## 資料存在哪

全部在 `~/.k-browser/`(可用 `KBROWSER_HOME` 改位置),只有你讀得到:

| 路徑 | 內容 |
|---|---|
| `pair.key` | 配對碼 |
| `clients/<名稱>.json` | 每個 client 的 token 和設定 |
| `config.json` | 設定(`activityLog`、`decisionLog`、`kav`、模型選擇) |
| `files/` | 每個 client 各自的檔案區 |
| `activity/`、`decisions/` | 紀錄，有打開才會有 |
| `jev.key` | JEV 金鑰，選了 `jev` 才會有 |

不要把這個資料夾同步到雲端或分享出去。

## 常見問題

- **橋接重開後,agent 說找不到之前的分頁**:這是刻意的。K-Browser 寧可放掉舊分頁，也不靠猜測認回來，免得把無關的分頁當成 agent 的。之前開的分頁請手動關掉。
- **agent 回報 `bridge_version`**:橋接和 agent 的 MCP server 版本不一致。橋接比較舊，就 `k-browser service restart`;agent 比較舊，就重開 agent 或重連它的 MCP。
- **Chrome 上方出現「正在偵錯此瀏覽器」**:這是 Chrome 對擴充使用偵錯介面的固定提示，網頁本身看不到。
- **其他狀況**:`k-browser doctor` 會回報橋接、配對和擴充的狀態，以及下一步該做什麼。

## 限制

- 目前只支援 macOS。
- 擴充的介面跟著 Chrome 的語言:繁體中文，其他語言一律顯示英文。
- CDP 端點是刻意限縮的子集(見上面),不是通用的遠端偵錯埠。
- 遮罩是規則式的。網站封鎖和 `untrusted-page-content` 包裝可以降低風險，但不代表可以把 agent 放到你不信任它去的網站。

## 開發

```sh
npm test              # 單元測試
npm run typecheck     # 對 src/、extension/、test/ 做 tsc --checkJs
npm run test:chrome   # 在 Chrome for Testing 裡用真的擴充跑端到端測試
npm run test:pack     # npm pack 後裝到別處，跑裝出來的那份
```

- `test:chrome` 需要 Chrome for Testing(品牌版 Chrome 已經不能從命令列載入未封裝擴充):把 `KBROWSER_TEST_CHROME` 設成它的執行檔，或執行 `npx playwright install chromium`,會用 Playwright 快取裡最新的那份(Apple Silicon)。沒有的話這些測試會略過。想看畫面就設 `KBROWSER_TEST_HEADED=1`。
- 測試不會用到你的 `~/.k-browser`,也不會連 9444 的橋接;每個測試都自己開一個。
- `KBROWSER_TEST_KAV` 指向 Kav 的資料夾(或這個 repo 旁邊就有 Kav)時，會跑接真 Kav 的測試，否則略過。
- `package.json` 和 `extension/manifest.json` 的版本要一致，有測試會檢查。改了橋接或擴充就兩個一起升版,`doctor` 才分得出舊程式。

## 致謝

K-Browser 的設計參考了對 [BeatBrowser](https://github.com/BeatAPI/BeatBrowser)(MIT)的審查，沒有使用它的程式碼。

## 授權

[MIT](LICENSE)
