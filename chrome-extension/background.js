// AI Task Hub — background service worker
// content script 不能直接 fetch localhost（CORS / Local Network Access 限制），
// 所以統一由這裡代打。manifest 的 host_permissions 已放行 localhost:9999。

const HUB = 'http://localhost:9999/events';
const HUB_IMAGES = 'http://localhost:9999/images';
const HUB_FOCUS_WAIT = 'http://localhost:9999/focus/wait';
const activeTabs = new Set(); // 回報過狀態的 tab，關閉時通知 Hub 移除任務

async function post(body, endpoint = HUB) {
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.ok ? 'ok' : `Hub 回 ${r.status}: ${(await r.text()).slice(0, 120)}`;
  } catch (e) {
    // Hub 沒開就放棄，不影響瀏覽；原因回報給呼叫端
    return `連不上 Hub（沒開？）: ${e}`;
  }
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ profileName: '', saveDir: '' }, (o) => {
      resolve({ profileName: o.profileName || 'ChatGPT', saveDir: o.saveDir || '' });
    });
  });
}

function getProfileName() {
  return getSettings().then((s) => s.profileName);
}

// 圖片抓取：簽名 URL 會過期，所以收到訊息就馬上抓，轉成 base64 交給 Hub 寫檔。
// 在這裡抓（而不是 Hub 端）是因為 host_permissions 放行了 oaiusercontent，
// 可以帶著瀏覽器的登入 cookie，就算是需要授權的圖也抓得到。
async function fetchAsBase64(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const contentType = r.headers.get('content-type') || '';
  const bytes = new Uint8Array(await r.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000; // String.fromCharCode 的參數上限，分段避免爆 call stack
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return { b64: btoa(bin), contentType };
}

// items: [{b64, contentType}]（blob: 圖，content script 已轉好）或 [{url}]（https 圖，這裡抓）
// 回傳處理結果字串，content script 會印在頁面 Console，方便一站式除錯。
async function downloadImages(items, title) {
  const { profileName, saveDir } = await getSettings();
  if (!saveDir) return '未設定儲存資料夾（擴充功能選項），略過下載';
  const images = [];
  const errors = [];
  for (const item of items) {
    if (item.b64) {
      images.push({ b64: item.b64, contentType: item.contentType });
      continue;
    }
    try {
      images.push(await fetchAsBase64(item.url));
    } catch (e) {
      errors.push(`${String(item.url).slice(0, 60)}… → ${e}`);
    }
  }
  if (!images.length) return `全部 ${items.length} 張抓取失敗: ${errors.join('; ')}`;
  // 保險絲：同一批裡內容完全相同的只留一份（同張圖多個 img 元素、網址參數不同時）
  const seenB64 = new Set();
  const uniq = images.filter((img) => !seenB64.has(img.b64) && seenB64.add(img.b64));
  const dropped = images.length - uniq.length;
  const r = await post({ dir: saveDir, label: profileName, title, images: uniq }, HUB_IMAGES);
  return r === 'ok'
    ? `已送 Hub ${uniq.length} 張 → ${saveDir}` +
      (dropped ? `（${dropped} 張重複略過）` : '') +
      (errors.length ? `（${errors.length} 張失敗）` : '')
    : `送 Hub 失敗: ${r}`;
}

// Dashboard 點了 ChatGPT 任務列 → hub 立即回應掛著的長輪詢 → 這裡切到該分頁。
// 用長輪詢而不是定時輪詢，是因為分頁進背景後 Chrome 會節流計時器（最慢一分鐘一次），
// 而點擊導向的時機恰恰就是 ChatGPT 在背景的時候。長輪詢 25 秒一循環（< MV3
// service worker 的 30 秒閒置回收），既是即時推送通道、也順便讓 worker 保持存活。
async function focusTabs(ids) {
  for (const id of ids || []) {
    const m = /#tab(\d+)$/.exec(id); // 任務 id 格式：<profileName>#tab<tabId>
    if (!m) continue;
    try {
      const tab = await chrome.tabs.update(Number(m[1]), { active: true });
      if (tab) await chrome.windows.update(tab.windowId, { focused: true });
    } catch {} // 分頁已關就放掉（hub 端 24h 後也會清）
  }
}

let waiting = false; // 已經有一條長輪詢掛著就不再開第二條
async function waitFocusLoop() {
  if (waiting) return;
  waiting = true;
  try {
    while (true) {
      const r = await fetch(HUB_FOCUS_WAIT);
      if (!r.ok) break;
      await focusTabs((await r.json()).ids);
    }
  } catch {} // Hub 沒開／重啟中：先退出，等下面的喚醒訊號再重掛
  waiting = false;
}
waitFocusLoop(); // service worker 每次醒來（任何事件）都會跑到這行，斷線自動接回

// 喚醒訊號其二：每分鐘的鬧鐘，涵蓋「沒有任何 ChatGPT 分頁在動」的死角
chrome.alarms.create('focus-reconnect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => waitFocusLoop());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender.tab) return;
  if (msg.type === 'focus-poll') {
    waitFocusLoop(); // 喚醒訊號其一：ChatGPT 分頁的偵測循環順路捎來的
    return;
  }
  if (msg.type === 'images' && Array.isArray(msg.items) && msg.items.length) {
    downloadImages(msg.items, msg.title)
      .then(sendResponse)
      .catch((e) => sendResponse('background 錯誤: ' + e));
    return true; // 保持 message channel 開著等非同步回覆
  }
  if (msg.type !== 'status') return;
  activeTabs.add(sender.tab.id);
  getProfileName().then((name) => {
    post({
      source: 'chatgpt',
      id: `${name}#tab${sender.tab.id}`,
      label: name,
      status: msg.status, // running | done
      model: msg.model,
      title: msg.title,
    });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!activeTabs.has(tabId)) return;
  activeTabs.delete(tabId);
  getProfileName().then((name) => {
    post({ source: 'chatgpt', id: `${name}#tab${tabId}`, status: 'ended' });
  });
});
