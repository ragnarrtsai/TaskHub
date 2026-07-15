const input = document.getElementById('name');
const dirInput = document.getElementById('dir');
const saved = document.getElementById('saved');

chrome.storage.local.get({ profileName: '', saveDir: '' }, ({ profileName, saveDir }) => {
  input.value = profileName;
  dirInput.value = saveDir;
});

// 「瀏覽…」：請 Hub 開原生 macOS 選資料夾視窗，選好把絕對路徑填回輸入框。
// 瀏覽器的資料夾選擇器故意不給絕對路徑，所以繞道本機的 Hub 來開。
// （選項頁是擴充套件頁面、有 localhost 的 host_permissions，可直接 fetch）
document.getElementById('pick').addEventListener('click', async () => {
  saved.textContent = '選資料夾視窗已開啟（可能在最前面）…';
  saved.style.color = '';
  try {
    const r = await (await fetch('http://localhost:9999/pick-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })).json();
    if (r.ok) {
      dirInput.value = r.path;
      saved.textContent = '已選擇，記得按儲存';
    } else if (r.cancelled) {
      saved.textContent = '';
    } else {
      saved.textContent = '✗ ' + (r.error || '開啟失敗');
      saved.style.color = 'crimson';
    }
  } catch {
    saved.textContent = '✗ 連不上 Hub（沒開？）';
    saved.style.color = 'crimson';
  }
  setTimeout(() => (saved.textContent = ''), 6000);
});

document.getElementById('save').addEventListener('click', () => {
  const dir = dirInput.value.trim();
  // 格式先在這裡擋：存了錯格式，Hub 端只會靜默退回，使用者完全不會發現
  if (dir && !dir.startsWith('/') && dir !== '~' && !dir.startsWith('~/')) {
    saved.textContent = '✗ 路徑要以 / 或 ~/ 開頭';
    saved.style.color = 'crimson';
    setTimeout(() => (saved.textContent = ''), 4000);
    return;
  }
  chrome.storage.local.set({ profileName: input.value.trim(), saveDir: dir }, () => {
    saved.textContent = '已儲存 ✓';
    saved.style.color = 'green';
    setTimeout(() => (saved.textContent = ''), 2000);
  });
});
