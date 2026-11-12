// Page world: the userscript's Tampermonkey APIs, provided by the extension. Requests go through the bridge to the
// background; settings live in this site's localStorage; the CRM credential is never here (only a placeholder).
(() => {
  const CHANNEL = 'cc-collector-bridge', PREFIX = 'cc_ext_';
  const pending = new Map();
  let seq = 0;
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window || !data || data.channel !== CHANNEL || data.dir !== 'toPage') return;
    const done = pending.get(data.id);
    if (done) { pending.delete(data.id); done(data.reply || { error: '扩展没有响应' }) }
  });
  const call = (type, payload) => new Promise(resolve => { const id = `${Date.now()}-${++seq}`; pending.set(id, resolve); window.postMessage({ channel: CHANNEL, dir: 'toBridge', id, type, payload }, location.origin) });
  globalThis.GM_xmlhttpRequest = options => {
    call('request', { method: options.method, url: options.url, headers: options.headers, data: options.data }).then(reply => {
      if (reply.error) { options.onerror?.({ error: reply.error }); return }
      let response = reply.responseText;
      if (options.responseType === 'json') { try { response = JSON.parse(reply.responseText) } catch { response = null } }
      options.onload?.({ status: reply.status, statusText: reply.statusText, responseText: reply.responseText, response, finalUrl: reply.finalUrl });
    });
  };
  globalThis.GM_getValue = (key, fallback) => { try { const raw = localStorage.getItem(PREFIX + key); return raw == null ? fallback : JSON.parse(raw) } catch { return fallback } };
  globalThis.GM_setValue = (key, value) => { try { localStorage.setItem(PREFIX + key, JSON.stringify(value)) } catch { /* storage unavailable */ } };
  globalThis.GM_deleteValue = key => { try { localStorage.removeItem(PREFIX + key) } catch { /* storage unavailable */ } };
  globalThis.GM_addStyle = css => { const style = document.createElement('style'); style.textContent = css; (document.head || document.documentElement).appendChild(style); return style };
  globalThis.GM_notification = () => {};
  globalThis.unsafeWindow = window;
  globalThis.__CC_EXTENSION__ = {
    connect: async (apiBase, origin) => { const reply = await call('connect', { apiBase, origin }); if (reply.error) throw new Error(reply.error); return reply },
  };
})();
