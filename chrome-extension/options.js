const input = document.getElementById('name');
const dirInput = document.getElementById('dir');
const saved = document.getElementById('saved');

chrome.storage.local.get({ profileName: '', saveDir: '' }, ({ profileName, saveDir }) => {
  input.value = profileName;
  dirInput.value = saveDir;
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
