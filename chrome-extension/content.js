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
  // 生成完成的圖片（舊：oaiusercontent CDN；新：自家 backend estuary 端點）
  resultImage: [
    'img[src*="oaiusercontent"]',
    'img[src*="backend-api/estuary/content"]',
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

// 產圖時 ChatGPT 常常沒有停止鈕、進度文字也常改版，但有一個藏不住的信號：
// 畫面上的 img 會一路把 src 從模糊換到清晰。「同一個 img 元素的 src 這一輪
// 跟上一輪不同」＝有圖正在生成中。每輪輪詢都要呼叫（維持記憶）。
const imgSrcMemo = new WeakMap();
function imageChurn() {
  let churn = false;
  for (const img of document.images) {
    const prev = imgSrcMemo.get(img);
    if (prev !== undefined && prev !== img.src) churn = true;
    imgSrcMemo.set(img, img.src);
  }
  return churn;
}

function detect() {
  const churn = imageChurn(); // 先跑：side effect 是記住這一輪所有 img 的 src
  const stop = q(SELECTORS.stopButton);
  if (stop) return { state: 'running', why: 'stopButton: ' + stop.sel };
  if (churn) return { state: 'running', why: 'imgChurn: 有圖片的 src 正在更換（生成中）' };
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
// 不依賴訊息容器（一般對話/專案/Canvas 的 DOM 都不同、常改版）：
// 「閒置時」持續把頁面上現有的大圖記成基準線，done 時掃全頁，
// 基準線之後新出現的大圖＝這一輪生成的，一張是一張、多張全收。
// 生成當下 img 的 src 常是 blob:（重新整理後才會變成 oaiusercontent 的正式網址），
// blob: 只有頁面自己讀得到，所以在這裡直接轉 base64；https 的交給 background 抓。
function qualifyingImages() {
  const out = [];
  for (const img of document.images) {
    const src = img.src || '';
    const isBlob = src.startsWith('blob:');
    // 舊版出圖走 oaiusercontent CDN；新版（實測 2026-07）走自家 backend：
    // chatgpt.com/backend-api/estuary/content?id=file_xxx（同源、靠 cookie 授權）
    const isCdn = src.startsWith('https://') && src.includes('oaiusercontent');
    const isBackend = src.startsWith(location.origin) && src.includes('/backend-api/estuary/content');
    if (!isBlob && !isCdn && !isBackend) continue;
    // 避開頭像、icon 之類的小圖
    if (Math.max(img.naturalWidth, img.clientWidth) < 200) continue;
    // 去重 key：CDN 圖去掉會輪換的簽名參數；backend 圖以 ?id=file_xxx 為準
    //（同一張圖會渲染成多個 img 元素、其他參數不同，用全網址會重複下載）
    let key = src;
    if (isCdn) {
      key = src.split('?')[0];
    } else if (isBackend) {
      try {
        key = 'estuary:' + (new URL(src).searchParams.get('id') || src);
      } catch {}
    }
    if (out.some((o) => o.key === key)) continue; // 同張圖的重複渲染只留一份
    out.push({ src, key });
  }
  return out;
}

// 閒置時呼叫：把目前可見的大圖標成「已看過」（含捲動載入的歷史訊息、切換的對話）
function markSeen() {
  for (const { key } of qualifyingImages()) sentImages.add(key);
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

// done 之後不是抓一次就走：ChatGPT 產圖階段常常偵測不到（停止鈕消失、
// 進度文字對不上），done 會提早發、圖片幾十秒後才出現在 DOM。
// 所以 done 後開一個觀察窗，窗內每輪輪詢掃描新圖，
// 新圖連續兩輪 src 相同（漸進式預覽換完、就緒）才送出下載。
const WATCH_MS = 120000; // 產圖從 done（可能提早發）到圖片上桌可能要一分多鐘，寬一點
let watchUntil = 0;   // 觀察窗截止時間；0 = 沒在觀察
let watchPrev = null; // 上一輪看到的候選新圖 src 簽名（等穩定用）

function harvestImages() {
  watchUntil = Date.now() + WATCH_MS;
  watchPrev = null;
}

async function sendImages(srcs) {
  const items = [];
  for (const src of srcs) {
    // blob 只有頁面讀得到；同源 backend 圖在頁面抓 cookie 自動帶，一起在這裡轉
    if (src.startsWith('blob:') || src.startsWith(location.origin)) {
      try {
        items.push(await blobToB64(src));
      } catch (e) {
        log('抓圖：頁面內讀取失敗', src, e);
      }
    } else {
      items.push({ url: src });
    }
  }
  if (!items.length || !alive()) return;
  log('偵測到', items.length, '張新圖片，送出下載');
  chrome.runtime.sendMessage({ type: 'images', items, title: getConvTitle() })
    .then((r) => log('下載結果:', r))
    .catch((e) => log('下載訊息送不出去:', e));
}

function watchTick() {
  if (!watchUntil) return;
  if (Date.now() > watchUntil) {
    watchUntil = 0;
    watchPrev = null;
    // 沒等到新圖：dump 頁面圖片概況，供調 selector 用
    const dump = [...document.images].slice(0, 20)
      .map((i) => `${(i.src || '').slice(0, 70)} [${i.naturalWidth}x${i.naturalHeight}]`);
    log('抓圖：觀察窗結束仍無新圖。頁面 img 概況:', dump);
    return;
  }
  const fresh = qualifyingImages().filter((o) => !sentImages.has(o.key));
  if (!fresh.length) return;
  const sig = fresh.map((o) => o.src).sort().join('|');
  if (watchPrev !== sig) {
    watchPrev = sig; // 還在變（漸進式預覽），下一輪再看
    return;
  }
  watchUntil = 0;
  watchPrev = null;
  fresh.forEach((o) => sentImages.add(o.key));
  sendImages(fresh.map((o) => o.src));
}

const poller = setInterval(() => {
  if (!alive()) {
    // 套件被重載，這份是孤兒了：停止輪詢（新版 script 會隨分頁重整注入）
    clearInterval(poller);
    log('extension 已重載，此舊 script 停止輪詢（重整分頁即換新版）');
    return;
  }
  const { state, why } = detect();
  watchTick(); // done 後的觀察窗：掃描並送出新出現的圖
  // 完全閒置時持續更新圖片基準線；生成中/觀察窗開著時凍結，免得吃掉新圖
  if (reported === 'idle' && state === 'idle' && !watchUntil) markSeen();
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

markSeen(); // 開頁時的既有圖片是基準線，只下載之後新生成的
log('content script 已載入，開始輪詢偵測｜基準線圖片數:', sentImages.size);
