const input = document.getElementById('name');
const saved = document.getElementById('saved');

chrome.storage.local.get({ profileName: '' }, ({ profileName }) => {
  input.value = profileName;
});

document.getElementById('save').addEventListener('click', () => {
  chrome.storage.local.set({ profileName: input.value.trim() }, () => {
    saved.textContent = '已儲存 ✓';
    setTimeout(() => (saved.textContent = ''), 2000);
  });
});
