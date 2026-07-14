// AI Task Hub — ChatGPT 狀態偵測 content script
// 跑在 chatgpt.com 頁面上，偵測「生成中 / 完成」並透過 background 回報 Hub。
//
// 偵測策略：每 1.5 秒輪詢一次 DOM（比 MutationObserver 好調校、也更耐改版），
// 連續兩次讀到相同狀態才視為轉換（避免瞬間閃爍誤判）。
// ⚠️ SELECTORS / GEN_TEXT_RE 是「最可能中的猜測」，ChatGPT 改版時只需調這一區。

const DEBUG = true; // 校準期開著，打開 DevTools Console 看 [task-hub] 記錄

// ---- 偵測特徵（改版時調這裡）----
const SELECTORS = {
  // 回覆進行中（含圖片生成）會出現的「停止」按鈕
  stopButton: [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="停止串流"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="停止"]',
  ],
  // 生成完成的圖片（ChatGPT 產圖的最終 img 來源多半在 oaiusercontent）
  resultImage: [
    'img[src*="oaiusercontent"]',
    'img[alt*="Generated image"]',
    'img[alt*="生成的圖片"]',
  ],
};
// 「圖片生成中」的文字特徵（zh-TW / en）
const GEN_TEXT_RE = /(正在(建立|生成|製作)圖|建立圖片|Creating image|Generating image|Making image)/i;

// 目前使用模型（左上角模型切換按鈕的文字）
const MODEL_SELECTORS = [
  'button[data-testid="model-switcher-dropdown-button"]',
  '[data-testid*="model-switcher"]',
  'button[aria-label*="Model selector"]',
  'button[aria-label*="模型"]',
];

// ---- 以下通常不用動 ----
const log = (...a) => DEBUG && console.log('[task-hub]', ...a);

function q(list) {
  for (const sel of list) {
    try {
      const el = document.querySelector(sel);
      if (el) return { el, sel };
    } catch {}
  }
  return null;
}

function detect() {
  const stop = q(SELECTORS.stopButton);
  if (stop) return { state: 'running', why: 'stopButton: ' + stop.sel };
  // 停止鈕沒有時，再看有沒有「生成圖片中」的文字（有些階段沒有停止鈕）
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  let count = 0;
  while ((n = walker.nextNode()) && count < 4000) {
    count++;
    if (n.nodeValue && GEN_TEXT_RE.test(n.nodeValue)) {
      return { state: 'running', why: 'genText: ' + n.nodeValue.trim().slice(0, 30) };
    }
  }
  return { state: 'idle', why: 'no activity signal' };
}

let reported = 'idle'; // 已回報給 Hub 的狀態
let pending = null;    // 待確認的新狀態（要連續兩次相同才算數）
const sentImages = new Set(); // 這個分頁已送出下載的圖片（以去掉簽名參數的 URL 為 key）

function getModel() {
  const hit = q(MODEL_SELECTORS);
  if (!hit) return undefined;
  const text = hit.el.textContent.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 40) : undefined;
}

function getConvTitle() {
  // ChatGPT 會把對話名稱放進分頁標題
  const t = document.title.replace(/\s*[-|–]\s*ChatGPT.*$/i, '').trim();
  return t && t !== 'ChatGPT' ? t.slice(0, 60) : undefined;
}

// 擴充套件重載後，舊的 content script 會變成孤兒：chrome.runtime 消失，
// 再呼叫 sendMessage 就丟 TypeError。偵測到就停掉輪詢、安靜退場。
const alive = () => typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;

function send(status) {
  if (!alive()) return;
  chrome.runtime.sendMessage({ type: 'status', status, model: getModel(), title: getConvTitle() }).catch(() => {});
}

// ---- 圖片自動下載（方案 B：抓圖交給 background → Hub 落地）----
// 只掃「最後一則 assistant 回覆」（找不到就退回最後一個對話 turn），
// 歷史訊息的舊圖不會被撈到；同一張圖去重，done 訊號閃兩次也只送一次。
// 生成當下 img 的 src 常是 blob:（重新整理後才會變成 oaiusercontent 的正式網址），
// blob: 只有頁面自己讀得到，所以在這裡直接轉 base64；https 的交給 background 抓。
function lastAssistantScope() {
  const msgs = document.querySelectorAll('div[data-message-author-role="assistant"]');
  if (msgs.length) return msgs[msgs.length - 1];
  const turns = document.querySelectorAll('article[data-testid*="conversation-turn"], article');
  return turns.length ? turns[turns.length - 1] : null;
}

function collectNewImages() {
  const scope = lastAssistantScope();
  if (!scope) { log('抓圖：找不到 assistant 訊息容器'); return []; }
  const srcs = [];
  for (const img of scope.querySelectorAll('img')) {
    const src = img.src || '';
    const isBlob = src.startsWith('blob:');
    const isRemote = src.startsWith('https://') && src.includes('oaiusercontent');
    if (!isBlob && !isRemote) continue;
    // 避開頭像、icon 之類的小圖
    if (Math.max(img.naturalWidth, img.clientWidth) < 200) continue;
    const key = isBlob ? src : src.split('?')[0];
    if (sentImages.has(key)) continue;
    sentImages.add(key);
    srcs.push(src);
  }
  return srcs;
}

async function blobToB64(url) {
  const blob = await (await fetch(url)).blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return { b64: btoa(bin), contentType: blob.type || 'image/png' };
}

function harvestImages() {
  // 生成剛結束時 img 的 src 可能還在從漸進預覽換成最終圖，緩 2.5 秒再抓
  setTimeout(async () => {
    const srcs = collectNewImages();
    if (!srcs.length) { log('抓圖：最後一則回覆沒有符合條件的圖片'); return; }
    const items = [];
    for (const src of srcs) {
      if (src.startsWith('blob:')) {
        try {
          items.push(await blobToB64(src));
        } catch (e) {
          log('抓圖：blob 讀取失敗', src, e);
        }
      } else {
        items.push({ url: src });
      }
    }
    if (!items.length || !alive()) return;
    log('偵測到', items.length, '張新圖片，送出下載');
    chrome.runtime.sendMessage({ type: 'images', items, title: getConvTitle() }).catch(() => {});
  }, 2500);
}

const poller = setInterval(() => {
  if (!alive()) {
    // 套件被重載，這份是孤兒了：停止輪詢（新版 script 會隨分頁重整注入）
    clearInterval(poller);
    log('extension 已重載，此舊 script 停止輪詢（重整分頁即換新版）');
    return;
  }
  const { state, why } = detect();
  if (state === reported) { pending = null; return; }
  if (pending === state) {
    // 連續兩次讀到同一個新狀態 → 確認轉換
    reported = state;
    pending = null;
    const status = state === 'running' ? 'running' : 'done';
    log('狀態轉換 →', status, '｜依據:', why, '｜圖片數:', q(SELECTORS.resultImage) ? '有結果圖' : '無');
    send(status);
    if (status === 'done') harvestImages();
  } else {
    pending = state;
    log('候選狀態:', state, '｜依據:', why, '（等下一輪確認）');
  }
}, 1500);

log('content script 已載入，開始輪詢偵測');
