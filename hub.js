#!/usr/bin/env node
// AI Task Hub — 集中式 AI 任務狀態管理 (Phase 1)
// 聽 localhost:9999，接收各來源事件，狀態轉為「完成/等待指示」時發 macOS 通知。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = process.env.TASK_HUB_PORT ? Number(process.env.TASK_HUB_PORT) : 9999;
const STATE_FILE = path.join(__dirname, 'state.json');
const STALE_MS = 24 * 60 * 60 * 1000; // 超過 24 小時未更新的任務自動清掉

// status: running | waiting | done
// tasks: { [source:id]: { source, id, label, status, updatedAt, startedAt } }
let tasks = {};
try {
  tasks = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch {}

// 清洗舊版殘留：曾把自動衍生名（如 "fwit-model-server-0f"）存成標題，載入時剔除
for (const t of Object.values(tasks)) {
  if (t.title && t.label) {
    const escaped = t.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('^' + escaped + '-[0-9a-f]{2}$').test(t.title)) delete t.title;
  }
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_FILE, JSON.stringify(tasks, null, 2), () => {});
  }, 200);
}

// 音效分級：聽聲音就知道是「做完了」還是「等你決定」
const STATUS_SOUND = { waiting: 'Funk', done: 'Glass' };

function notify(title, message, sound) {
  // osascript 的字串放在 AppleScript 雙引號內，跳脫反斜線與雙引號
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `display notification "${esc(message)}" with title "${esc(title)}" sound name "${esc(sound || 'Glass')}"`;
  execFile('/usr/bin/osascript', ['-e', script], () => {});
}

const STATUS_LABEL = { running: '🔵 執行中', waiting: '🟡 待決定', done: '🟢 已完成' };

// 同名任務（同資料夾開多個 session）加上短 ID 區分，如 "fwit-model-server #a1b2"
function displayLabel(t) {
  const dup = Object.values(tasks).some((o) => o !== t && o.label === t.label);
  return dup ? `${t.label} #${String(t.id).slice(0, 4)}` : t.label;
}

function upsertTask({ source, id, label, title, sessionStart, status, prompt, isPrompt, todos, lastResponse, tokens, model }) {
  const key = `${source}:${id}`;
  const now = Date.now();
  const prev = tasks[key];

  if (status === 'ended') {
    delete tasks[key];
    saveState();
    return;
  }

  // 非同步 hooks 沒有到達順序保證：權限視窗剛跳出時，前一個工具延遲送達的
  // PostToolUse 可能把 waiting 蓋回 running。剛轉 waiting 2 秒內的 running
  //（且不是新 prompt）視為過期訊號忽略——人不可能 2 秒內讀完並按允許。
  if (prev && prev.status === 'waiting' && status === 'running' && !isPrompt && now - prev.updatedAt < 2000) {
    return;
  }

  // 累積這一輪收到的指令，完成通知時帶出來；lastPrompt 給總覽頁顯示、完成後保留
  const prompts = (prev && prev.prompts) || [];
  let lastPrompt = prev && prev.lastPrompt;
  let firstPrompt = prev && prev.firstPrompt; // 當「標題」用：session 的開場話題
  if (status === 'running' && prompt) {
    const raw = String(prompt).replace(/\s+/g, ' ').trim();
    // 過濾 <task-notification> 等系統注入訊息，只記使用者親手打的
    if (raw && !raw.startsWith('<')) {
      prompts.push(raw.slice(0, 40));
      while (prompts.length > 10) prompts.shift();
      lastPrompt = raw.slice(0, 80);
      if (!firstPrompt) firstPrompt = raw.slice(0, 60);
    }
  }

  tasks[key] = {
    source,
    id,
    // label 以 session 首次回報的 cwd 為準（＝在哪裡開的 Claude Code），中途換目錄不改名
    label: (prev && prev.label) || label || id,
    status,
    // 經過時間從「最後一句指令」起算；PostToolUse 之類的活動訊號不重置
    startedAt: (!prev || isPrompt) ? now : prev.startedAt,
    updatedAt: now,
    prompts,
    lastPrompt,
    todos: todos || (prev && prev.todos),
    lastResponse: lastResponse || (prev && prev.lastResponse),
    tokens: tokens || (prev && prev.tokens),
    model: model || (prev && prev.model),
    title: title || (prev && prev.title),
    firstPrompt,
    // session 真正的開啟時間；非 Claude Code 來源以第一次回報為準
    sessionStart: sessionStart || (prev && prev.sessionStart) || now,
  };
  saveState();

  // 只在「狀態改變」且新狀態是 waiting / done 時通知
  const prevStatus = prev && prev.status;
  if (status !== prevStatus && (status === 'waiting' || status === 'done')) {
    const t = tasks[key];
    const elapsed = Math.round((now - t.startedAt) / 1000);
    const mins = Math.floor(elapsed / 60);
    const timeStr = mins > 0 ? `${mins}m${elapsed % 60}s` : `${elapsed}s`;
    let msg = `${source} · 經過 ${timeStr}`;
    if (status === 'done' && prompts.length) {
      const more = prompts.length > 1 ? `（等 ${prompts.length} 件）` : '';
      msg = `「${prompts[0]}」${more} · 經過 ${timeStr}`;
      t.prompts = []; // 這一輪結清，下一輪重新累積
      saveState();
    }
    notify(`${STATUS_LABEL[status]} — ${displayLabel(t)}`, msg, STATUS_SOUND[status]);
  }
}

function pruneStale() {
  const cutoff = Date.now() - STALE_MS;
  let changed = false;
  for (const [key, t] of Object.entries(tasks)) {
    if (t.updatedAt < cutoff) {
      delete tasks[key];
      changed = true;
    }
  }
  if (changed) saveState();
}
setInterval(pruneStale, 60 * 60 * 1000).unref();

// session 標題與開始時間：Claude Code 把各 session 註冊在 ~/.claude/sessions/*.json
const SESSIONS_DIR = path.join(require('os').homedir(), '.claude', 'sessions');
const sessionCache = new Map(); // sessionId -> { info: {title, startedAt}, ts }
async function sessionInfo(sessionId) {
  const c = sessionCache.get(sessionId);
  const now = Date.now();
  if (c && now - c.ts < 30000) return c.info; // 30 秒快取，改名最慢半分鐘反映
  const info = {};
  try {
    for (const f of await fs.promises.readdir(SESSIONS_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const o = JSON.parse(await fs.promises.readFile(path.join(SESSIONS_DIR, f), 'utf8'));
        if (o.sessionId === sessionId) {
          // derived（資料夾+短碼）的自動名稱沒資訊量，只採用使用者親自取的名字
          if (o.nameSource && o.nameSource !== 'derived') info.title = o.name;
          info.startedAt = o.startedAt;
          break;
        }
      } catch {}
    }
  } catch {}
  sessionCache.set(sessionId, { info, ts: now });
  return info;
}

// 讀整份 session transcript（JSONL）：撈最後一則 assistant 回應 + 加總 token 消耗
async function transcriptSummary(transcriptPath) {
  try {
    const data = await fs.promises.readFile(transcriptPath, 'utf8');
    let lastText;
    let model;
    let aiTitle;
    let inTok = 0;
    let outTok = 0;
    for (const line of data.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'ai-title' && o.aiTitle) { aiTitle = o.aiTitle; continue; } // 頁籤標題
      if (o.type !== 'assistant' || !o.message) continue;
      if (o.message.model) model = o.message.model; // 取最後看到的（中途換模型以最新為準）
      const u = o.message.usage;
      if (u) {
        // input 含快取讀寫（都是實際消耗的 input tokens，只是計價不同）
        inTok += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        outTok += u.output_tokens || 0;
      }
      if (Array.isArray(o.message.content)) {
        const text = o.message.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) lastText = text.slice(0, 300);
      }
    }
    return { lastText, model, aiTitle, inTok, outTok };
  } catch {
    return null;
  }
}

// Claude Code hook 事件 → 任務狀態
const HOOK_STATUS = {
  UserPromptSubmit: 'running',
  PostToolUse: 'running', // 權限批准後沒有專屬事件，靠「工具在動」把狀態撥回執行中
  PermissionRequest: 'waiting',
  Stop: 'done',
  SessionEnd: 'ended',
};

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<title>AI Task Hub</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "PingFang TC", sans-serif; margin: 1.5rem 2rem; }
  th, td { white-space: nowrap; }
  td.prompt { max-width: 16rem; overflow: hidden; text-overflow: ellipsis; font-size: .85rem; opacity: .75; }
  td.resp { max-width: 9rem; }
  h1 { font-size: 1.2rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid rgba(128,128,128,.3); }
  th { font-size: .8rem; opacity: .6; font-weight: 600; }
  th.sortable { cursor: pointer; user-select: none; text-decoration: underline dotted; }
  th.sortable:hover { opacity: 1; }
  .empty { opacity: .5; padding: 2rem 0; text-align: center; }
  @keyframes rowflash { 0% { background: rgba(255, 140, 0, .65); } 60% { background: rgba(255, 140, 0, .35); } 100% { background: transparent; } }
  tr.flash td { animation: rowflash .98s ease-out; }
  tr.waiting td { background: rgba(255, 165, 0, .25); } /* 待決定：持續亮底，直到狀態改變 */
  .toolbar { display: flex; gap: .5rem; align-items: center; margin-bottom: .8rem; font-size: .85rem; }
  .toolbar button { padding: .25rem .7rem; border: 1px solid rgba(128,128,128,.4); background: transparent; border-radius: 6px; cursor: pointer; color: inherit; font-size: .85rem; }
  .toolbar button.active { background: rgba(128,128,128,.25); font-weight: 600; }
  tr[draggable] { cursor: grab; }
  tr.dragging td { opacity: .4; }
  .pin { cursor: pointer; opacity: .2; user-select: none; }
  .pin.on { opacity: 1; }
  .pipbtn { font-size: .75rem; padding: .25rem .7rem; margin-left: .8rem; vertical-align: middle; cursor: pointer; border: 1px solid rgba(128,128,128,.4); background: transparent; color: inherit; border-radius: 6px; }
  .meta { font-size: .8rem; opacity: .5; margin-top: 1rem; }
</style>
</head>
<body>
<h1>AI Task Hub <button id="pip-btn" class="pipbtn" title="開一個永遠置頂的浮動狀態小窗">⧉ 懸浮視窗</button></h1>
<div id="content">載入中…</div>
<p class="meta">每秒自動更新 · 資料來源 <code>GET /tasks</code></p>
<script>
const ICON = { running: '🔵 執行中', waiting: '🟡 待決定', done: '🟢 已完成' };
let prevStatuses = null; // 上一輪各任務的狀態，用來偵測「有變化」以閃動提示
let flashUntil = {};     // 各任務閃動的截止時間
let sortMode = localStorage.getItem('th-sort') || 'started';
let sortDir = localStorage.getItem('th-dir') || 'asc';
let manualOrder = [];
try { manualOrder = JSON.parse(localStorage.getItem('th-order') || '[]'); } catch {}
let pinnedIds = [];
try { pinnedIds = JSON.parse(localStorage.getItem('th-pin') || '[]'); } catch {}
let bottomIds = [];
try { bottomIds = JSON.parse(localStorage.getItem('th-bottom') || '[]'); } catch {}
let dragging = false;
let animLock = false; // 置頂/置底動畫播放中暫停重繪，避免動畫被腰斬

// 置頂與置底互斥：加入一邊時自動從另一邊移除
function togglePlace(id, list, other) {
  const i = list.indexOf(id);
  if (i === -1) {
    list.push(id);
    const j = other.indexOf(id);
    if (j !== -1) other.splice(j, 1);
  } else {
    list.splice(i, 1);
  }
  localStorage.setItem('th-pin', JSON.stringify(pinnedIds));
  localStorage.setItem('th-bottom', JSON.stringify(bottomIds));
  animateMove(id);
}

function animateMove(id) {
  // FLIP：記住舊位置 → 重繪 → 從舊位置滑到新位置
  const sel = 'tr[data-id="' + CSS.escape(id) + '"]';
  const oldRow = document.querySelector(sel);
  const oldTop = oldRow ? oldRow.getBoundingClientRect().top : null;
  refresh().then(() => {
    const row = document.querySelector(sel);
    if (!row || oldTop === null) return;
    const delta = oldTop - row.getBoundingClientRect().top;
    if (!delta) return;
    animLock = true;
    setTimeout(() => { animLock = false; }, 500);
    row.style.transition = 'none';
    row.style.transform = 'translateY(' + delta + 'px)';
    requestAnimationFrame(() => {
      row.style.transition = 'transform .4s cubic-bezier(.2,.8,.3,1)';
      row.style.transform = '';
    });
  });
}

const DEFAULT_DIR = { started: 'asc', updated: 'desc', label: 'asc' };

function sortTasks(list) {
  const d = sortDir === 'desc' ? -1 : 1;
  if (sortMode === 'updated') list.sort((a, b) => d * (a.updatedAt - b.updatedAt));
  else if (sortMode === 'label') list.sort((a, b) =>
    d * String(a.display || a.label).localeCompare(String(b.display || b.label), 'zh-Hant') || (a.startedAt - b.startedAt));
  else if (sortMode === 'manual') {
    const pos = id => { const i = manualOrder.indexOf(id); return i === -1 ? 1e15 : i; };
    list.sort((a, b) => (pos(a.id) - pos(b.id)) || (a.startedAt - b.startedAt));
  } else list.sort((a, b) => d * ((a.sessionStart || a.startedAt) - (b.sessionStart || b.startedAt))); // 預設：起始時間
  // 釘選置頂／置底不受排序模式影響：置頂群 → 一般（維持排序）→ 置底群
  const rank = id => {
    let i = pinnedIds.indexOf(id);
    if (i !== -1) return i;
    i = bottomIds.indexOf(id);
    if (i !== -1) return 2e6 + i;
    return 1e6;
  };
  list.sort((a, b) => rank(a.id) - rank(b.id));
}
function setSort(mode) {
  if (mode !== 'manual' && mode === sortMode) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc'; // 點同一欄 → 反轉方向
  } else if (mode !== 'manual') {
    sortDir = DEFAULT_DIR[mode] || 'asc';
  }
  sortMode = mode;
  localStorage.setItem('th-sort', mode);
  localStorage.setItem('th-dir', sortDir);
  refresh();
}
function fmt(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
}
function absTime(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString('zh-TW', { hour12: false });
  const today = new Date().toDateString() === d.toDateString();
  return today ? time : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + time;
}
async function refresh() {
  if (dragging || animLock) return; // 拖曳／動畫中暫停重繪，避免列被抽換
  try {
    const { tasks, now } = await (await fetch('/tasks')).json();
    const el = document.getElementById('content');
    if (!tasks.length) { el.innerHTML = '<p class="empty">目前沒有任務</p>'; lastTasks = []; renderPip(); return; }
    sortTasks(tasks);
    const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const promptCell = t => {
      const ps = (t.prompts && t.prompts.length) ? t.prompts : (t.lastPrompt ? [t.lastPrompt] : []);
      if (!ps.length) return '—';
      const text = ps.length > 1 ? ps.map((p, i) => (i + 1) + '. ' + esc(p)).join('　') : esc(ps[0]);
      return '<span title="' + esc(ps.map((p, i) => (i + 1) + '. ' + p).join('\\n')) + '">' + text + '</span>';
    };
    const todoCell = t => {
      const td = t.todos || [];
      if (!td.length) return '—';
      const done = td.filter(x => x.status === 'completed').length;
      const tip = td.map(x => (x.status === 'completed' ? '✅' : x.status === 'in_progress' ? '▶️' : '⬜') + ' ' + x.content).join('\\n');
      return '<span title="' + esc(tip) + '">' + done + '/' + td.length + '</span>';
    };
    // 狀態有變的列閃動提示；持續約 2 秒（每秒重繪會重播動畫 → 閃兩下更醒目）
    const changed = t => prevStatuses !== null && prevStatuses[t.id] !== t.status;
    const flashing = t => {
      if (changed(t)) flashUntil[t.id] = Date.now() + 1900;
      return flashUntil[t.id] && Date.now() < flashUntil[t.id];
    };
    const fmtTok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n || 0);
    const arrow = m => sortMode === m ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    el.innerHTML = '<table><tr><th></th><th>狀態</th>' +
      '<th class="sortable" data-sort="label">標識' + arrow('label') + '</th>' +
      '<th>標題</th><th>session</th><th>處理中的 prompt</th><th>最後回應</th><th>待辦</th><th>模型</th><th>tokens in/out</th>' +
      '<th class="sortable" data-sort="started">起始時間' + arrow('started') + '</th>' +
      '<th>經過</th>' +
      '<th class="sortable" data-sort="updated">最後更新' + arrow('updated') + '</th></tr>' +
      tasks.map(t => '<tr draggable="true" data-id="' + esc(t.id) + '"' + (t.status === 'waiting' ? ' class="waiting"' : (flashing(t) ? ' class="flash"' : '')) + '>' +
        '<td><span class="pin' + (pinnedIds.includes(t.id) ? ' on' : '') + '" data-pin="' + esc(t.id) + '" title="釘選置頂">📌</span> ' +
        '<span class="pin' + (bottomIds.includes(t.id) ? ' on' : '') + '" data-sink="' + esc(t.id) + '" title="沉到最底">⬇️</span>' +
        '</td><td>' + (ICON[t.status] || t.status) +
        '</td><td>' + esc(t.display || t.label) +
        '</td><td class="prompt">' + (esc(t.title || t.firstPrompt) || '—') +
        '</td><td><code title="' + esc(t.id) + '">' + esc(String(t.id).slice(0, 8)) + '</code>' +
        '</td><td class="prompt">' + promptCell(t) +
        '</td><td class="prompt resp" title="' + esc(t.lastResponse) + '">' + (esc(t.lastResponse) || '—') +
        '</td><td class="prompt">' + todoCell(t) +
        '</td><td>' + (t.model ? '<span title="' + esc(t.model) + '">' + esc(String(t.model).replace(/^claude-/, '')) + '</span>' : '—') +
        '</td><td>' + (t.tokens ? fmtTok(t.tokens.in) + ' / ' + fmtTok(t.tokens.out) : '—') +
        '</td><td>' + absTime(t.sessionStart || t.startedAt) +
        '</td><td>' + fmt((t.status === 'done' ? t.updatedAt : now) - t.startedAt) +
        '</td><td>' + absTime(t.updatedAt) + '</td></tr>').join('') + '</table>';
    prevStatuses = Object.fromEntries(tasks.map(t => [t.id, t.status]));
    lastTasks = tasks;
    renderPip();
  } catch { document.getElementById('content').innerHTML = '<p class="empty">連不上 Hub</p>'; }
}
// 點欄位標題排序（表格每秒重建，所以用事件委派掛在外層）
const content = document.getElementById('content');
content.addEventListener('click', e => {
  const pin = e.target.closest('[data-pin]');
  if (pin) { togglePlace(pin.dataset.pin, pinnedIds, bottomIds); return; }
  const sink = e.target.closest('[data-sink]');
  if (sink) { togglePlace(sink.dataset.sink, bottomIds, pinnedIds); return; }
  const th = e.target.closest('th[data-sort]');
  if (th) setSort(th.dataset.sort);
});

// 拖曳調整順序（放開後自動切到「自訂」並存進 localStorage）
let dragRow = null;
content.addEventListener('dragstart', e => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  dragRow = tr;
  dragging = true;
  tr.classList.add('dragging');
});
content.addEventListener('dragover', e => {
  if (!dragRow) return;
  e.preventDefault();
  const tr = e.target.closest('tr[data-id]');
  if (!tr || tr === dragRow) return;
  const rect = tr.getBoundingClientRect();
  const after = e.clientY > rect.top + rect.height / 2;
  tr.parentNode.insertBefore(dragRow, after ? tr.nextSibling : tr);
});
content.addEventListener('dragend', () => {
  if (!dragRow) return;
  dragRow.classList.remove('dragging');
  manualOrder = Array.from(content.querySelectorAll('tr[data-id]')).map(r => r.dataset.id);
  localStorage.setItem('th-order', JSON.stringify(manualOrder));
  dragRow = null;
  dragging = false;
  setSort('manual');
});

// ---- 懸浮視窗（Document Picture-in-Picture，永遠置頂）----
let pipWin = null;
let lastTasks = [];

function renderPip() {
  if (!pipWin) return;
  const el = pipWin.document.getElementById('pip');
  if (!el) return;
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  if (!lastTasks.length) { el.innerHTML = '<p class="empty">目前沒有任務</p>'; return; }
  // 固定欄寬：狀態/待辦/起始不縮；視窗變窄時由標題、標識吃截斷；再窄的話狀態只留燈號
  const compact = pipWin.innerWidth < 340;
  el.innerHTML = '<table><colgroup><col style="width:' + (compact ? '2.4em' : '7em') + '"><col><col style="width:26%"><col style="width:3.4em"><col style="width:5.2em"></colgroup>' +
    '<tr><th>狀態</th><th>標題</th><th>標識</th><th>待辦</th><th>起始</th></tr>' +
    lastTasks.map(t => {
      const td = t.todos || [];
      const todo = td.length ? td.filter(x => x.status === 'completed').length + '/' + td.length : '—';
      const title = esc(t.title || t.firstPrompt) || '—';
      const label = esc(t.display || t.label);
      const status = ICON[t.status] || t.status;
      return '<tr' + (t.status === 'waiting' ? ' class="waiting"' : '') + '><td title="' + status + '">' + (compact ? status.split(' ')[0] : status) +
        '</td><td title="' + title + '">' + title +
        '</td><td title="' + label + '">' + label +
        '</td><td>' + todo +
        '</td><td>' + absTime(t.sessionStart || t.startedAt) + '</td></tr>';
    }).join('') + '</table>';
}

async function openPip() {
  if (!window.documentPictureInPicture) { alert('懸浮視窗需要 Chrome 116 以上'); return; }
  if (pipWin) { pipWin.focus(); return; }
  pipWin = await documentPictureInPicture.requestWindow({ width: 560, height: 300 });
  const st = pipWin.document.createElement('style');
  st.textContent = ':root{color-scheme:light dark;}' +
    'body{font-family:-apple-system,"PingFang TC",sans-serif;margin:.6rem;font-size:.85rem;}' +
    'table{width:100%;border-collapse:collapse;table-layout:fixed;}' +
    'th,td{text-align:left;padding:.3rem .45rem;border-bottom:1px solid rgba(128,128,128,.3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    'th{font-size:.7rem;opacity:.6;font-weight:600;}' +
    'tr.waiting td{background:rgba(255,165,0,.25);}' +
    '.empty{opacity:.5;text-align:center;padding:1.5rem 0;}';
  pipWin.document.head.appendChild(st);
  const div = pipWin.document.createElement('div');
  div.id = 'pip';
  pipWin.document.body.appendChild(div);
  pipWin.addEventListener('pagehide', () => { pipWin = null; });
  pipWin.addEventListener('resize', renderPip); // 縮放時即時切換精簡/完整顯示
  renderPip();
}
document.getElementById('pip-btn').addEventListener('click', openPip);

refresh();
setInterval(refresh, 1000);
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(DASHBOARD_HTML);
  }

  if (req.method === 'GET' && url.pathname === '/tasks') {
    pruneStale();
    const list = Object.values(tasks).map((t) => ({ ...t, display: displayLabel(t) }));
    return json(res, 200, { tasks: list, now: Date.now() });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true });
  }

  // 通用事件入口：{source, id, label, status}
  if (req.method === 'POST' && url.pathname === '/events') {
    let ev;
    try {
      ev = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }
    if (!ev.source || !ev.id || !ev.status) {
      return json(res, 400, { error: 'source, id, status required' });
    }
    upsertTask(ev);
    return json(res, 200, { ok: true });
  }

  // Chrome 擴充套件送來的 ChatGPT 生成圖片：{dir, label, title, images: [{b64, contentType}]}
  // 圖片由 extension 抓好轉 base64（簽名 URL 會過期，且可能需要瀏覽器 cookie），這裡只負責落地。
  if (req.method === 'POST' && url.pathname === '/images') {
    let ev;
    try {
      ev = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }
    // ~ 開頭展開成家目錄，其餘仍要求絕對路徑
    let dir = String(ev.dir || '');
    if (dir === '~' || dir.startsWith('~/')) dir = path.join(require('os').homedir(), dir.slice(2));
    if (!dir || !path.isAbsolute(dir) || !Array.isArray(ev.images) || !ev.images.length) {
      return json(res, 400, { error: 'dir (absolute or ~/ path) and images required' });
    }
    const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
    // 檔名：對話標題_日期時間（多張加序號），標題裡的路徑危險字元換掉
    const base = String(ev.title || 'chatgpt')
      .replace(/[/\\:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 50) || 'chatgpt';
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const saved = [];
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      for (let i = 0; i < ev.images.length; i++) {
        const img = ev.images[i];
        if (!img || !img.b64) continue;
        const ext = EXT[String(img.contentType || '').split(';')[0].trim()] || '.png';
        const seq = ev.images.length > 1 ? `_${pad(i + 1)}` : '';
        let file = path.join(dir, `${base}_${stamp}${seq}${ext}`);
        for (let n = 2; fs.existsSync(file); n++) {
          file = path.join(dir, `${base}_${stamp}${seq}-${n}${ext}`);
        }
        await fs.promises.writeFile(file, Buffer.from(img.b64, 'base64'));
        saved.push(file);
      }
    } catch (e) {
      notify(`⚠️ 圖片儲存失敗 — ${ev.label || 'ChatGPT'}`, String(e.message || e).slice(0, 100), 'Basso');
      return json(res, 500, { error: String(e.message || e), saved });
    }
    if (saved.length) {
      notify(`🖼️ 圖片已儲存 — ${ev.label || 'ChatGPT'}`, `${saved.length} 張 → ${dir}`, 'Glass');
    }
    return json(res, 200, { ok: true, saved });
  }

  // Claude Code hooks 專用：直接吃 hook stdin 的原始 JSON
  if (req.method === 'POST' && url.pathname === '/claude-hook') {
    let hook;
    try {
      hook = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }
    const status = HOOK_STATUS[hook.hook_event_name];
    if (!status) return json(res, 200, { ok: true, ignored: hook.hook_event_name });
    // TodoWrite 的 PostToolUse 事件帶著完整待辦清單，順手撿起來給總覽頁
    let todos;
    if (hook.tool_name === 'TodoWrite' && hook.tool_input && Array.isArray(hook.tool_input.todos)) {
      todos = hook.tool_input.todos.map((t) => ({ content: t.content, status: t.status }));
    }
    // 完成時從 transcript 撈最後一則回應 + token 消耗
    let lastResponse;
    let tokens;
    let model;
    let aiTitle;
    if (hook.hook_event_name === 'Stop' && hook.transcript_path) {
      const s = await transcriptSummary(hook.transcript_path);
      if (s) {
        lastResponse = s.lastText;
        tokens = { in: s.inTok, out: s.outTok };
        model = s.model;
        aiTitle = s.aiTitle;
      }
    }
    const sess = await sessionInfo(hook.session_id);
    upsertTask({
      source: 'claude-code',
      id: hook.session_id || 'unknown',
      label: hook.cwd ? path.basename(hook.cwd) : undefined,
      title: sess.title || aiTitle, // 手動 /rename 的名字優先，其次是自動生成的頁籤標題
      sessionStart: sess.startedAt,
      status,
      prompt: hook.prompt,
      isPrompt: hook.hook_event_name === 'UserPromptSubmit',
      todos,
      lastResponse,
      tokens,
      model,
    });
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[task-hub] listening on http://127.0.0.1:${PORT}`);
});
