# AI Task Hub — 專案簡報

> 集中式 AI 任務狀態管理：監控多個 AI 任務（Claude Code、ChatGPT 圖片生成），
> 在「完成」或「等待指示」時主動通知，不必再頻繁切換視窗輪詢。

## 背景與問題

使用 AI 開發/產圖的工作型態是「間歇性互動」：發出指令後要等數十秒到數分鐘，
期間會切去做別的任務。目前的痛點：

- 必須**頻繁切換視窗**去看「好了沒」，輪詢動作本身不斷打斷手上的工作
- AI 常常早就完成（或卡在等權限/等輸入），時間浪費在「沒發現」
- 任務來源多且分散：
  - **Claude Code**：多個 session 並行（不同專案）
  - **ChatGPT 網頁版圖片生成**：多個 Chrome profile 登入不同帳號，各自跑生成任務

## 目標

1. 任務狀態改變時（**已完成** / **等待指示**）主動發 macOS 通知，附上來源識別（哪個專案 / 哪個帳號）
2. 一個集中的總覽介面，看到所有任務的即時狀態（執行中 / 等待 / 完成、經過時間）
3. 零日常維護成本：開機自動啟動，平常感覺不到它存在

## 架構

```
Claude Code hooks ──(curl POST)──┐
                                 ├──▶  本機 Hub (localhost HTTP 服務)
Chrome 各 profile 的擴充套件 ────┘         │
    (偵測 ChatGPT 圖片生成狀態)            ├──▶ macOS 通知
                                          └──▶ 選單列 (SwiftBar) / dashboard 總覽
```

### 元件 1：本機 Hub

- 一支小型 Node 或 Python HTTP 服務，聽 localhost（例如 port 9999）
- 接收各來源 POST 的事件：`{source, id, label, status, timestamp}`
- 維護目前所有任務的狀態（in-memory + 落地 JSON 檔）
- 狀態變成「完成」「等待指示」時發 macOS 通知（`osascript` 或 `terminal-notifier`）
- 提供查詢 endpoint 給呈現層讀取
- 用 launchd / 登入項目設成開機自動啟動

### 元件 2：Claude Code hooks（最簡單、最穩定）

在 `settings.json` 設定 hooks，事件發生時 `curl` 打到 Hub。
hooks stdin 會收到 JSON（含 `session_id`、`cwd` 可推導專案名）：

| Hook 事件 | 對應狀態 |
|---|---|
| `UserPromptSubmit` | 🔵 執行中 |
| `Notification`（需要權限/等輸入） | 🟡 等待指示 |
| `Stop`（回覆完畢） | 🟢 已完成 |

不需安裝任何東西，純設定。

### 元件 3：Chrome 擴充套件（主要開發量、最脆弱的部分）

- Manifest V3，自己寫、不上架：用「開發人員模式 → 載入未封裝項目」安裝
- 擴充套件是 **per-profile**，每個 ChatGPT 帳號的 profile 各裝一次（同一資料夾，一次性設定）
- 設定頁可幫 profile 取名（如「帳號A」），作為通知的識別
- **content script**：跑在 chatgpt.com 頁面，用 `MutationObserver` 監看 DOM——
  偵測「生成中」佔位元素出現 → 回報執行中；最終圖片元素渲染 → 回報完成
- **background service worker**：接收 content script 的訊息，負責 fetch Hub

#### 已確認的技術決策（CORS 相關）

- content script **不直接** fetch localhost——會撞 CORS 與 Chrome 的
  Local Network Access 限制
- 正確路徑：content script → `chrome.runtime.sendMessage()` → background
  service worker → fetch Hub
- manifest 宣告 `"host_permissions": ["http://localhost:9999/*"]`，
  background 的 fetch 即不受 CORS 與 local network 攔查
- mixed content 不是問題：`localhost` 是瀏覽器豁免的可信任來源，Hub 不需 https

#### 已知風險

- ChatGPT 前端改版頻繁，DOM 偵測的 selector 可能數月需修一次
  （屬預期維護成本，通常只是改一個 selector）
- ⚠️ 實作時需實際打開 ChatGPT 生成圖片，觀察 DOM 找出「生成中」與
  「完成」的可靠特徵，這部分無法事先寫死

### 元件 4：呈現層

- **SwiftBar/xbar plugin**：選單列常駐顯示摘要（如 `▶2 ⏸1`），
  點開列出所有任務（來源、標識、狀態、經過時間）
- 網頁 dashboard 為未來選項，MVP 不做

## 分階段計劃

| Phase | 內容 | 預估 |
|---|---|---|
| 1 | Hub + Claude Code hooks + macOS 通知 | 一個下午，立即有感 |
| 2 | Chrome 擴充套件（DOM 偵測 + 多 profile 識別） | 主要開發量 |
| 3 | SwiftBar 選單列總覽 | 1–2 小時 |

## 尚未確認的開放問題

1. 瀏覽器確定是 Chrome？（Edge/Arc/Firefox 擴充套件寫法略有差異）大概幾個 profile？
2. ChatGPT 上除了圖片生成，是否還要監控其他長任務（如 Deep Research）？
3. 通知的深度：純 macOS 通知即可，還是點通知要能跳到對應視窗/profile？
4. Hub 技術選型：Node 或 Python（依偏好，功能上皆可）
5. 新專案的名稱與位置

## 環境

- macOS（Darwin），主力瀏覽器待確認
- Claude Code 使用中（VSCode extension + CLI）
- 使用者：Daniel（citiesocial）

---
*整理自 2026-07-13 的規劃討論。*
