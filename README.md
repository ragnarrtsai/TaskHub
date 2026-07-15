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
| `GET /` | 網頁總覽：欄位有狀態、標識、**標題**（session 頁籤標題）、session ID、處理中的 prompt、最後回應、待辦進度、**模型**、tokens in/out、起始時間（session 開啟時刻）、經過、最後更新。互動：每秒更新、點欄位標題排序（再點反向）、拖曳自訂順序、📌 置頂／⬇️ 置底（含滑動動畫）、狀態變化閃動、**待決定列持續亮橘底**（直到狀態離開）、**點任務列跳到該視窗/分頁**（走 `POST /focus`，懸浮視窗裡也能點）、**⧉ 懸浮視窗**（Document PiP 永遠置頂，精簡五欄；寬度不足時先縮標題/標識、再窄時狀態只留燈號） |
| `GET /tasks` | 所有任務 JSON（含撞名去重後的 `display` 欄位） |
| `GET /health` | 健康檢查 |
| `POST /claude-hook` | Claude Code hooks 專用，直接吃 hook 的原始 stdin JSON |
| `POST /events` | 通用入口 `{source, id, label, status}`，status 可為 `running`/`waiting`/`done`/`ended`（ended = 移除任務），給 Chrome 擴充套件等其他來源用 |
| `POST /images` | 接收 Chrome 擴充套件送來的 ChatGPT 生成圖片 `{dir, label, title, images: [{b64, contentType}]}`，寫入 `dir`（絕對路徑，`~`/`~/` 開頭會展開成家目錄；不存在會自動建立）並發「🖼️ 圖片已儲存」通知。檔名 = `對話標題_日期時間[_序號].副檔名`，撞名自動加流水號 |
| `POST /focus` | 點擊導向 `{source, id}`。claude-code 來源：`open -a <app> <cwd>` 聚焦該專案的編輯器視窗（app 預設 `Antigravity`，可用環境變數 `TASK_HUB_FOCUS_APP` 覆寫；只能到視窗層級，進不到編輯器內的分頁）。chatgpt 來源：立即推給掛在 `/focus/wait` 上的擴充套件、精準切到該分頁。cwd 是功能上線後才開始記錄的，舊任務會回「還沒有 cwd 紀錄」 |
| `GET /focus/wait` | Chrome 擴充套件長輪詢：掛著等 ChatGPT 分頁聚焦請求，一來立即回應（取走即清空），25 秒沒事回空讓它重掛 |
| `GET /focus/pending` | 同上的一次性版本（立即回傳並清空佇列），擴充套件已改用 `/focus/wait`，留著當除錯工具 |
| `POST /pick-folder` | 開原生 macOS「選資料夾」視窗（經 System Events 帶到最前面），回傳 `{ok, path}`；取消回 `{cancelled: true}`。給擴充套件選項頁的「瀏覽…」用，一次只開一個（撞到回 409），5 分鐘沒動作自動收 |

所有 POST 端點**強制要求 `Content-Type: application/json`**（415 退回）：跨來源網頁的
fetch 帶這個標頭會觸發 CORS preflight、而 Hub 不回 CORS 允許 → 瀏覽器整包擋下，
堵死「惡意網頁 drive-by 打 localhost」（`text/plain` 屬簡單請求、原本會直達）。
本機程式（hooks 的 curl、擴充套件）都已帶標頭，不受影響。

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
  "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' http://localhost:9999/claude-hook --data-binary @- >/dev/null 2>&1 || true", "timeout": 5, "async": true }] }],
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

### 點擊導向（切到 ChatGPT 分頁）

Dashboard 點了 ChatGPT 任務列 → Hub 立即回應擴充套件掛著的長輪詢 →
`chrome.tabs.update` + `chrome.windows.update` 切到該分頁（任務 id 裡本來就存著
tab id），實測點擊到切換約 30ms。

為什麼用長輪詢：分頁進背景超過 5 分鐘後 Chrome 會把它的計時器節流到約一分鐘
一次，而點擊導向的時機恰恰就是 ChatGPT 在背景的時候，靠 content script 定時輪詢
最壞要等一分鐘。改成 background 對 `GET /focus/wait` 長輪詢（有請求立即回、
25 秒沒事回空再重掛；25 秒 < MV3 service worker 的 30 秒閒置回收，這條循環
同時讓 worker 保持存活）。長輪詢斷掉時（Hub 重啟、瀏覽器剛開）有兩個喚醒訊號
把它接回：content script 順路捎來的 `focus-poll` 訊息、每分鐘一次的 `chrome.alarms`。

### 圖片自動下載

在「擴充功能選項」設定**儲存資料夾**後啟用；留空 = 關閉。可按「**瀏覽…**」開
原生選資料夾視窗（經 Hub 的 `/pick-folder`；瀏覽器自己的選擇器故意不給絕對路徑，
所以繞道本機 Hub），或手動填 `/`、`~/` 開頭的路徑（儲存時會驗證格式）。流程：

```
content script（done 後 120s 觀察窗）          background                    Hub
  每輪掃全頁，基準線之後新出現的大圖，    ──▶  湊齊 base64、           ──▶  POST /images
  連兩輪 src 穩定才收：                        同批內容去重                  寫檔＋🖼️ 通知
  blob:/同源 backend 圖 → 頁面內轉 base64     （oaiusercontent 的
  oaiusercontent → 送 URL                      在這裡帶 cookie 抓）
```

圖片來源三種（實測 2026-07，`qualifyingImages()`）：

| src 特徵 | 說明 | 抓取位置 | 去重 key |
|---|---|---|---|
| `chatgpt.com/backend-api/estuary/content?id=file_xxx` | **現行主要來源**（專案頁實測）；同源、靠 cookie 授權；同張圖會渲染成多個 img 元素（參數不同） | content script（同源 fetch） | `?id=` 的 file id |
| `blob:` | 生成當下的暫存網址 | content script（只有頁面讀得到） | 完整 src |
| `*.oaiusercontent.com` | 舊版 CDN，簽名 URL 會過期 | background（host_permissions 放行、帶 cookie） | 去掉簽名參數的 URL |

設計要點：

- **基準線判定，不依賴訊息容器**（一般對話/專案/Canvas 的 DOM 都不同、常改版）：
  閒置時持續把頁面上現有的大圖標成「已看過」，之後新出現的才下載——歷史舊圖、
  捲動載入、切換對話都不會誤觸；**寬度 < 200px 的小圖（頭像/icon）跳過**
- **done 後開 120 秒觀察窗**，不是抓一次就走：偵測對產圖階段可能全盲（停止鈕
  消失、進度文字改版），done 會提早發、圖片幾十秒後才出現——窗內每輪輪詢掃描，
  新圖**連續兩輪 src 相同**（漸進式渲染換完）才送出；窗結束仍無圖會把頁面 img
  概況 dump 到 Console 供調 selector
- **img 的 src 更換本身是「生成中」信號**（`imageChurn()`，WeakMap 記每個 img
  元素上一輪的 src）：按鈕/文字特徵失效時靠它把 running 撐住
- 兩層去重：content script 以來源 key 去重；background 再把同批 base64 內容
  相同的過濾一次（同張圖多個 img 元素的保險絲）
- 因設定是 per-profile 的，**不同 ChatGPT 帳號可以各存到不同資料夾**
- Hub 沒開時靜默放棄（與狀態回報一致），不影響瀏覽
- 除錯一站式：頁面 Console 看 `[task-hub]` log——`抓圖：…` 是掃描過程，
  `下載結果: …` 是 background 回傳的最終結局（含沒設資料夾、抓取失敗、Hub
  退件原因）；Hub 端 `hub.log` 也記每筆 `/images` 請求與寫檔結果

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

ChatGPT 前端改版導致失效時，要調的地方集中在 `content.js`：

- **狀態偵測失效** → 最上方的 `SELECTORS` 與 `GEN_TEXT_RE`（打開 Console 看
  `[task-hub]` log 找新特徵）。就算都沒中，`imageChurn()` 通常還撐得住產圖的 running
- **圖片抓不到** → `qualifyingImages()` 的來源判斷。觀察窗結束時 Console 會自動
  dump 頁面上所有 img 的網址與尺寸，新的來源網址直接從那裡抄（estuary 這個來源
  當初就是這樣找到的）

`DEBUG` 旗標校準完可改為 `false`。

## 後續階段

- ~~Phase 3：SwiftBar 選單列摘要~~ 已取消——dashboard 的 ⧉ 懸浮視窗（永遠置頂）已覆蓋此需求
