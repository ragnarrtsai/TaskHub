// AI Task Hub — background service worker
// content script 不能直接 fetch localhost（CORS / Local Network Access 限制），
// 所以統一由這裡代打。manifest 的 host_permissions 已放行 localhost:9999。

const HUB = 'http://localhost:9999/events';
const HUB_IMAGES = 'http://localhost:9999/images';
const activeTabs = new Set(); // 回報過狀態的 tab，關閉時通知 Hub 移除任務

async function post(body, endpoint = HUB) {
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // Hub 沒開就靜默放棄，不影響瀏覽
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

async function downloadImages(urls, title) {
  const { profileName, saveDir } = await getSettings();
  if (!saveDir) return; // 沒設定儲存位置 = 功能關閉
  const images = [];
  for (const url of urls) {
    try {
      images.push(await fetchAsBase64(url));
    } catch (e) {
      console.warn('[task-hub] 圖片抓取失敗，略過：', url, e);
    }
  }
  if (images.length) {
    await post({ dir: saveDir, label: profileName, title, images }, HUB_IMAGES);
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !sender.tab) return;
  if (msg.type === 'images' && Array.isArray(msg.urls) && msg.urls.length) {
    downloadImages(msg.urls, msg.title);
    return;
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
