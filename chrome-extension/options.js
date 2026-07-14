const input = document.getElementById('name');
const dirInput = document.getElementById('dir');
const saved = document.getElementById('saved');

chrome.storage.local.get({ profileName: '', saveDir: '' }, ({ profileName, saveDir }) => {
  input.value = profileName;
  dirInput.value = saveDir;
});

document.getElementById('save').addEventListener('click', () => {
  chrome.storage.local.set(
    { profileName: input.value.trim(), saveDir: dirInput.value.trim() },
    () => {
      saved.textContent = '已儲存 ✓';
      setTimeout(() => (saved.textContent = ''), 2000);
    }
  );
});
