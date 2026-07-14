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

function send(status) {
  chrome.runtime.sendMessage({ type: 'status', status, model: getModel(), title: getConvTitle() }).catch(() => {});
}

setInterval(() => {
  const { state, why } = detect();
  if (state === reported) { pending = null; return; }
  if (pending === state) {
    // 連續兩次讀到同一個新狀態 → 確認轉換
    reported = state;
    pending = null;
    const status = state === 'running' ? 'running' : 'done';
    log('狀態轉換 →', status, '｜依據:', why, '｜圖片數:', q(SELECTORS.resultImage) ? '有結果圖' : '無');
    send(status);
  } else {
    pending = state;
    log('候選狀態:', state, '｜依據:', why, '（等下一輪確認）');
  }
}, 1500);

log('content script 已載入，開始輪詢偵測');
