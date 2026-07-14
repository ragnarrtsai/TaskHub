// AI Task Hub — background service worker
// content script 不能直接 fetch localhost（CORS / Local Network Access 限制），
// 所以統一由這裡代打。manifest 的 host_permissions 已放行 localhost:9999。

const HUB = 'http://localhost:9999/events';
const activeTabs = new Set(); // 回報過狀態的 tab，關閉時通知 Hub 移除任務

async function post(body) {
  try {
    await fetch(HUB, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // Hub 沒開就靜默放棄，不影響瀏覽
  }
}

function getProfileName() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ profileName: '' }, ({ profileName }) => {
      resolve(profileName || 'ChatGPT');
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'status' || !sender.tab) return;
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
