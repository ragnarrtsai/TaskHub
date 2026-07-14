# AI Task Hub

集中監控多個 AI 任務（Claude Code session、ChatGPT 產圖），狀態變成
「🟡 待決定」或「🟢 已完成」時主動發 macOS 通知，不必切視窗輪詢。
**架構：單檔 Node Hub（localhost:9999）+ Claude Code hooks + Chrome MV3 擴充套件。**

> 👉 只想知道怎麼用？請看 **[OVERVIEW.md](OVERVIEW.md)（白話使用手冊）**。
> 本檔以下為技術向說明：安裝、hooks 設定、資料來源、除錯。
> 專案緣起與規劃見 [ai-task-hub-brief.md](ai-task-hub-brief.md)。

## 架構總覽

```
Claude Code hooks ──(事件當下 curl POST)──▶  Hub (localhost:9999)
Chrome 擴充套件 ─────────────────────────▶      │
                                                ├──▶ macOS 通知（osascript，即時）
                                                └──▶ 網頁總覽＋⧉懸浮視窗（每秒 polling）
```

- **Hub**（[hub.js](hub.js)）：單檔 Node HTTP 服務，零依賴，只聽本機 `127.0.0.1:9999`
- **推送方向**：各來源在事件發生當下主動 POST 給 Hub（push），通知即時
- **狀態落地**：`state.json`（Hub 重啟不掉資料）；超過 24 小時沒更新的任務自動清除

## 通知規則（依 Daniel 的需求定案）

| 通知 | 時機 | 說明 |
|---|---|---|
| 🟡 待決定 | 權限確認、問你問題、等你批准計畫 | 「閒置等你輸入」**刻意不通知** |
| 🟢 已完成 | 整輪回覆結束 | 內容帶這一輪的 prompt 摘要，如「『修登入 bug』 · 經過 3m42s」 |

其他行為：

- 任務名稱 = **在哪裡開的 Claude Code**（session 首次回報的 cwd 資料夾名），中途換目錄不改名
- 同資料夾開多個 session 時，撞名的會附短 ID 區分：`proj-X #a1b2`
- 經過時間從「你最後一句指令」起算，**已完成後凍結**；權限批准後靠 `PostToolUse` 事件把狀態撥回執行中（不重置計時、不發通知）
- **音效分級**：🟡 待決定 = `Funk`（低沉）、🟢 已完成 = `Glass`（清脆），聽聲音就能分辨；設定在 `hub.js` 的 `STATUS_SOUND`（14 種內建音效見 `ls /System/Library/Sounds/`，`afplay` 可試聽）
- 通知想「釘住不消失」→ 系統設定 → 通知 → Script Editor → 樣式改「提示」（per-app 設定，程式無法逐則控制）

---

## 一、啟動/管理 Hub server

Hub 由 **launchd** 管理：開機自動啟動、程序掛掉自動重啟。設定檔在
`~/Library/LaunchAgents/com.daniel.task-hub.plist`，內容重點：

```xml
<key>ProgramArguments</key>
<array>
    <string>/Users/daniel/.nvm/versions/node/v22.22.2/bin/node</string>  <!-- node 絕對路徑，launchd 沒有 nvm 的 PATH -->
    <string>/Users/daniel/projects/task-hub/hub.js</string>
</array>
<key>RunAtLoad</key><true/>    <!-- 登入即啟動 -->
<key>KeepAlive</key><true/>    <!-- 掛掉自動重啟 -->
```

常用指令：

```bash
# 查狀態（state = running 即正常）
launchctl print gui/501/com.daniel.task-hub | head -5

# 重啟（改了 hub.js 之後必須執行，改動才會生效）
launchctl kickstart -k gui/501/com.daniel.task-hub

# 停用 / 重新啟用
launchctl bootout gui/501/com.daniel.task-hub
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.daniel.task-hub.plist

# 健康檢查與 log
curl -s http://localhost:9999/health   # 應回 {"ok":true}
tail -f ~/projects/task-hub/hub.log
```

> 注意：升級 node 版本後 nvm 路徑會變，記得同步改 plist 裡的 node 路徑再重載。

### Hub 的 API

| 端點 | 用途 |
|---|---|
| `GET /` | 網頁總覽：欄位有狀態、標識、**標題**（session 頁籤標題）、session ID、處理中的 prompt、最後回應、待辦進度、**模型**、tokens in/out、起始時間（session 開啟時刻）、經過、最後更新。互動：每秒更新、點欄位標題排序（再點反向）、拖曳自訂順序、📌 置頂／⬇️ 置底（含滑動動畫）、狀態變化閃動、**待決定列持續亮橘底**（直到狀態離開）、**⧉ 懸浮視窗**（Document PiP 永遠置頂，精簡五欄；寬度不足時先縮標題/標識、再窄時狀態只留燈號） |
| `GET /tasks` | 所有任務 JSON（含撞名去重後的 `display` 欄位） |
| `GET /health` | 健康檢查 |
| `POST /claude-hook` | Claude Code hooks 專用，直接吃 hook 的原始 stdin JSON |
| `POST /events` | 通用入口 `{source, id, label, status}`，status 可為 `running`/`waiting`/`done`/`ended`（ended = 移除任務），給 Chrome 擴充套件等其他來源用 |
| `POST /images` | 接收 Chrome 擴充套件送來的 ChatGPT 生成圖片 `{dir, label, title, images: [{b64, contentType}]}`，寫入 `dir`（絕對路徑，`~`/`~/` 開頭會展開成家目錄；不存在會自動建立）並發「🖼️ 圖片已儲存」通知。檔名 = `對話標題_日期時間[_序號].副檔名`，撞名自動加流水號 |

---

## 二、Claude Code hooks 設定

設定在**使用者層級** `~/.claude/settings.json` 的 `hooks` 區塊——一次設定，
**所有專案的所有 session 都生效**，不用逐專案植入。

原理：Claude Code 在特定事件發生時執行 hook 指令，並把事件 JSON（含
`hook_event_name`、`session_id`、`cwd`、`prompt`）餵給指令的 stdin。
我們的 hook 指令只做一件事：把這包 JSON 原封不動 POST 給 Hub，判斷邏輯全部在 Hub 端。

五個事件都掛同一條指令：

```json
"hooks": {
  "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST http://localhost:9999/claude-hook --data-binary @- >/dev/null 2>&1 || true", "timeout": 5, "async": true }] }],
  "PostToolUse":       [{ "hooks": [{ "type": "command", "command": "（同上）", "timeout": 5, "async": true }] }],
  "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "（同上）", "timeout": 5, "async": true }] }],
  "Stop":              [{ "hooks": [{ "type": "command", "command": "（同上）", "timeout": 5, "async": true }] }],
  "SessionEnd":        [{ "hooks": [{ "type": "command", "command": "（同上）", "timeout": 5, "async": true }] }]
}
```

（實際檔案裡每個 `command` 都是完整那串 curl，JSON 不支援「同上」，這裡只是省版面。）

事件 → 狀態的對應（在 `hub.js` 的 `HOOK_STATUS`）：

| Hook 事件 | 觸發時機 | Hub 狀態 |
|---|---|---|
| `UserPromptSubmit` | 你送出 prompt | 🔵 running（重置計時、記錄 prompt；`<task-notification>` 等系統注入訊息會被過濾） |
| `PostToolUse` | 每個工具執行完 | 🔵 running（權限批准後的「復工」訊號）；若是 `TodoWrite` 則同時擷取待辦清單給總覽頁 |
| `PermissionRequest` | 跳權限確認/問題 | 🟡 waiting → **發通知** |
| `Stop` | 整輪回覆結束 | 🟢 done → **發通知**（帶 prompt 摘要）；同時讀 transcript 撈最後回應、tokens 加總、模型、頁籤標題（`ai-title` 行） |
| `SessionEnd` | session 關閉 | 移除任務 |
| `Notification` | 閒置等輸入等 | **刻意不掛**（避免無意義通知） |

設計要點（重架時別漏）：

- `-m 2`＋`|| true`＋`async: true`：Hub 沒開也**不會拖慢或卡住** Claude Code，失敗就靜默放棄
- 改 `~/.claude/settings.json` 會被**熱載入**，連已開啟的 session 都即時生效，
  不用重開（若沒生效，在該 session 打一次 `/hooks` 重載）
- 只通知「狀態改變」的瞬間，running→running 之類不會重複轟炸
- **競態防護**：async hooks 不保證到達順序，剛轉 waiting 的 2 秒內忽略過期的
  running 訊號（否則前一個工具遲到的 PostToolUse 會把「待決定」蓋掉）
- 標題與 session 開始時間讀自 `~/.claude/sessions/*.json`（手動 `/rename` 的名字
  優先，其次 transcript 的 `ai-title`，再其次第一句 prompt）

---

## 三、驗證與除錯

### 手動模擬事件（不用真的開 session）

```bash
# 模擬「執行中 → 完成」，第二步應跳出 🟢 通知
echo '{"hook_event_name":"UserPromptSubmit","session_id":"t1","cwd":"/tmp/demo","prompt":"測試"}' \
  | curl -s -X POST http://localhost:9999/claude-hook --data-binary @-
echo '{"hook_event_name":"Stop","session_id":"t1","cwd":"/tmp/demo"}' \
  | curl -s -X POST http://localhost:9999/claude-hook --data-binary @-

# 看 Hub 目前記錄的任務
curl -s http://localhost:9999/tasks | jq

# 清掉測試任務
echo '{"hook_event_name":"SessionEnd","session_id":"t1"}' \
  | curl -s -X POST http://localhost:9999/claude-hook --data-binary @-
```

### 常見問題

| 症狀 | 檢查順序 |
|---|---|
| 完全沒通知 | ① `curl localhost:9999/health` Hub 活著嗎 → ② `launchctl print gui/501/com.daniel.task-hub` → ③ `jq '.hooks \| keys' ~/.claude/settings.json` hooks 還在嗎（五個事件）→ ④ 用上面的手動模擬打一發，跳通知代表 Hub 正常、問題在 hooks 端 |
| 通知有跳但某個 session 沒被追蹤 | 該 session 是在 hooks 設定**之前**開的且熱載入失敗 → 在那個 session 打 `/hooks` 或重開 |
| 狀態卡在 🟡 待決定 | 正常會被下一個 `PostToolUse` 撥回；若一直卡著，確認 settings.json 裡 `PostToolUse` hook 還在 |
| port 9999 被占用 | `lsof -ti:9999` 看誰占的；要換 port 的話改 plist 加環境變數 `TASK_HUB_PORT`，並同步改 hooks 指令裡的 URL |
| 改了 hub.js 沒生效 | 忘了 `launchctl kickstart -k gui/501/com.daniel.task-hub` |
| 通知被系統靜音 | 系統設定 → 通知 → Script Editor，確認允許通知；勿擾模式也會擋 |

### 檔案一覽

| 檔案 | 用途 |
|---|---|
| `hub.js` | Hub 本體（服務＋通知＋網頁總覽＋懸浮視窗，單檔） |
| `chrome-extension/` | ChatGPT 偵測擴充套件（MV3，未封裝載入） |
| `state.json` | 任務狀態落地（自動產生，可隨時刪除重來；**不進版控**） |
| `hub.log` | 服務 stdout/stderr（**不進版控**） |
| `~/Library/LaunchAgents/com.daniel.task-hub.plist` | launchd 開機自啟設定 |
| `~/.claude/settings.json` 的 `hooks` 區塊 | Claude Code 端的事件推送設定 |
| `~/.claude/sessions/*.json`（唯讀） | session 標題/開始時間的資料來源 |
| `~/.claude/projects/**/*.jsonl`（唯讀） | transcript：最後回應、tokens、模型、頁籤標題的資料來源 |

---

## 四、Chrome 擴充套件

程式碼在 [chrome-extension/](chrome-extension/)：content script 每 1.5 秒輪詢
ChatGPT 頁面 DOM（停止鈕、「正在建立圖片」文字），連續兩次讀到相同狀態才回報，
並順帶讀取目前模型（模型切換鈕文字）與對話標題（分頁標題），
經 background service worker POST 到 Hub 的 `/events`（content script 不能直接
fetch localhost，會撞 CORS／Local Network Access 限制）。

### 圖片自動下載

在「擴充功能選項」設定**儲存資料夾**（`/` 或 `~/` 開頭，選項頁儲存時會驗證格式）後啟用；留空 = 關閉。流程：

```
content script（done 瞬間 +2.5s）             background                    Hub
  掃全頁，基準線之後新出現的大圖         ──▶  湊齊 base64            ──▶  POST /images
  blob: → 頁面內轉 base64                    （https 的在這裡抓，          寫檔＋🖼️ 通知
  https(oaiusercontent) → 送 URL              帶瀏覽器 cookie）
```

設計要點：

- **基準線判定，不依賴訊息容器**（一般對話/專案/Canvas 的 DOM 都不同、常改版）：
  閒置時持續把頁面上現有的大圖標成「已看過」，done 時掃全頁，新出現的才下載——
  歷史舊圖、捲動載入、切換對話都不會誤觸；同張圖去重（https 以去掉簽名參數的
  URL 為 key），done 訊號抖動也只送一次；**寬度 < 200px 的小圖（頭像/icon）跳過**
- **產圖當下的 `src` 常是 `blob:`**（重整頁面後才變 `oaiusercontent` 正式網址），
  blob 只有頁面 context 讀得到 → content script 直接轉 base64；https 的則由
  **background 抓**（簽名 URL 會過期、可能需要 cookie；`host_permissions` 已放行
  `*.oaiusercontent.com`）
- done 後**延遲 2.5 秒**再抓：產圖結尾 `img` 的 `src` 還在從漸進式預覽換成最終圖
- 因設定是 per-profile 的，**不同 ChatGPT 帳號可以各存到不同資料夾**
- Hub 沒開時靜默放棄（與狀態回報一致），不影響瀏覽
- 除錯：頁面 Console 看 `[task-hub] 抓圖：…` log；background 的錯誤在
  `chrome://extensions` → 服務工作處理程序的 Console

改了 `chrome-extension/` 底下的程式碼後，要到 `chrome://extensions`
按套件卡片的 ↻ 重載、再重整 chatgpt.com 分頁才會生效。

> 支援範圍：**Chromium 系瀏覽器**（Chrome / Brave / Edge / Arc…），載入方式相同、零改動。
> Firefox 刻意不支援（已評估：MV3 background 寫法不同、未簽署套件重開就消失、無 Document PiP，維護成本不值得）。

### 安裝（每個 profile 做一次）

1. 該 profile 開 `chrome://extensions` → 右上開「開發人員模式」
2. 「載入未封裝項目」→ 選 `~/projects/task-hub/chrome-extension` 資料夾
3. 點擴充套件的「詳細資料 → 擴充功能選項」，幫這個 profile 取名（如「帳號A」）；
   要用圖片自動下載的話，順便填**儲存資料夾**（如 `~/Desktop/chatgpt-images`）→ 儲存
4. 開 chatgpt.com 產一張圖驗證；DevTools Console 會有 `[task-hub]` 開頭的偵測記錄

### 改版維修

ChatGPT 前端改版導致偵測失效時，只需要調 `content.js` 最上方的
`SELECTORS` 與 `GEN_TEXT_RE`（打開 Console 看 `[task-hub]` log 找新特徵），
其他都不用動。`DEBUG` 旗標校準完可改為 `false`。

## 後續階段

- ~~Phase 3：SwiftBar 選單列摘要~~ 已取消——dashboard 的 ⧉ 懸浮視窗（永遠置頂）已覆蓋此需求
