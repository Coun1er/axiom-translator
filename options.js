'use strict';
if(new URLSearchParams(location.search).get('popup')==='1') document.documentElement.classList.add('in-popup');
const keyInput = document.querySelector('#key');
const modelInput = document.querySelector('#model');
const status = document.querySelector('#status');
async function load() {
  const s = await chrome.runtime.sendMessage({type:'NARRATIVE_SETTINGS_GET'});
  modelInput.value = s.model;
  document.querySelector('#key-state').textContent = s.hasKey ? 'Ключ сохранён. Оставь поле пустым, чтобы его не менять.' : 'Ключ ещё не указан.';
}
document.querySelector('#settings').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const r = await chrome.runtime.sendMessage({type:'NARRATIVE_SETTINGS_SAVE',key:keyInput.value,model:modelInput.value});
    status.textContent = r.ok ? 'Сохранено. Можно вернуться в Pulse.' : r.error;
    if (r.ok) { keyInput.value = ''; await load(); }
  } catch { status.textContent = 'Не удалось сохранить настройки. Открой их заново.'; }
});
document.querySelector('#remove').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({type:'NARRATIVE_SETTINGS_SAVE',removeKey:true,model:modelInput.value});
  status.textContent = r.ok ? 'Ключ удалён.' : r.error;
  keyInput.value = ''; await load();
});
load().catch(() => { status.textContent = 'Не удалось загрузить настройки.'; });
