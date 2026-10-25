// Preserve the panel's message protocol; translation transport is isolated below.
importScripts('narrative.js', 'translation.js');

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'TRANSLATE_REQ') return;
  const { requestId, text, targetLang = 'ru' } = msg.payload || {};
  if (!requestId || !text) return;

  const tabId = sender?.tab?.id;
  if (!tabId) return;

  translate(text, targetLang).then(result => {
    chrome.tabs.sendMessage(
      tabId,
      { type: 'TRANSLATE_RES', payload: { requestId, ...result } },
      () => { chrome.runtime.lastError; }
    );
  });
});
