// Extension background: performs network requests for the collector and holds the CRM collector credential.
// The page only ever sees the placeholder below; the real key is added here for the CRM's collector endpoints.
const PLACEHOLDER = '__extension__';
const KEY = 'crmCollectorKey';
// Hosts the collector may reach through the extension (the same list the userscript declares).
const ALLOWED = [/(^|\.)1688\.com$/, /(^|\.)alibaba\.com$/, /(^|\.)alicdn\.com$/, /(^|\.)videocdn\.alibaba\.com$/, /^itemcdn\.tmall\.com$/, /^xt\.tlh666\.cn$/, /^127\.0\.0\.1$/, /^localhost$/];
const allowed = raw => { try { const u = new URL(raw); return ['https:', 'http:'].includes(u.protocol) && (u.protocol === 'https:' || ['127.0.0.1', 'localhost'].includes(u.hostname)) && ALLOWED.some(r => r.test(u.hostname)) } catch { return false } };
const collectorPath = raw => /\/api\/product-collections\/(session|import)$/.test(new URL(raw).pathname);
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function request({ method = 'GET', url, headers = {}, data }) {
  if (!allowed(url)) return { error: `不允许访问 ${url}` };
  const outgoing = { ...headers };
  delete outgoing.Referer; delete outgoing.referer;
  if (outgoing['X-Collector-Key'] === PLACEHOLDER) {
    if (!collectorPath(url)) return { error: '凭证只能用于采集接口' };
    const stored = (await chrome.storage.local.get(KEY))[KEY];
    if (!stored || new URL(url).origin !== stored.origin) return { status: 401, statusText: 'Unauthorized', responseText: JSON.stringify({ message: '请先连接 CRM' }) };
    outgoing['X-Collector-Key'] = stored.key;
  }
  try {
    const response = await fetch(url, { method, headers: outgoing, body: data, credentials: 'include' });
    const text = await response.text();
    if (response.status === 401 && headers['X-Collector-Key'] === PLACEHOLDER) await chrome.storage.local.remove(KEY);
    return { status: response.status, statusText: response.statusText, responseText: text, finalUrl: response.url };
  } catch (error) { return { error: error instanceof Error ? error.message : '网络请求失败' } }
}

/** Approval connect: the verifier never leaves the background; the CRM tab only gets its SHA-256. */
async function connect({ apiBase, origin }) {
  if (!allowed(apiBase) || new URL(apiBase).origin !== origin) return { error: 'CRM 地址无效' };
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  await chrome.tabs.create({ url: `${origin}/#/collector-connect?c=${challenge}` });
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const response = await fetch(`${apiBase}/connect/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verifier, client: 'extension' }) })
    const body = await response.json().catch(() => ({}));
    if (response.status === 200 && body?.data?.key) {
      await chrome.storage.local.set({ [KEY]: { key: body.data.key, origin } });
      return { key: PLACEHOLDER, user: body.data.user };
    }
    if (response.status !== 202) return { error: body?.message || `授权失败（HTTP ${response.status}）` };
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return { error: '等待授权超时，请重新连接' };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const work = message?.type === 'request' ? request(message.payload) : message?.type === 'connect' ? connect(message.payload) : Promise.resolve({ error: '未知请求' });
  work.then(sendResponse, error => sendResponse({ error: error instanceof Error ? error.message : '处理失败' }));
  return true;
});
