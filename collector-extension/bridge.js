// Isolated world: relays the collector's requests (page world) to the extension background. Nothing secret passes here:
// the CRM credential stays in the background and is added there.
(() => {
  const CHANNEL = 'cc-collector-bridge';
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window || !data || data.channel !== CHANNEL || data.dir !== 'toBridge') return;
    chrome.runtime.sendMessage({ type: data.type, payload: data.payload }, response => {
      const reply = chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : response;
      window.postMessage({ channel: CHANNEL, dir: 'toPage', id: data.id, reply }, location.origin);
    });
  });
})();
