// MCP Chrome Bridge - service worker
const DEFAULT_PORT = 8765;
let ws = null;
let connected = false;
let reconnectTimer = null;
const buffers = {};
const attached = new Set();
const MAX_EVENTS = 2000;

function buf(tabId) {
  if (!buffers[tabId]) buffers[tabId] = { network: [], console: [], events: [] };
  return buffers[tabId];
}

async function getConfig() {
  const r = await chrome.storage.local.get(['serverHost','serverPort','token']);
  return {
    host: r.serverHost || '127.0.0.1',
    port: r.serverPort || DEFAULT_PORT,
    token: r.token || '',
  };
}

function wsUrl(cfg) {
  const u = new URL('ws://' + cfg.host + ':' + cfg.port);
  if (cfg.token) u.searchParams.set('token', cfg.token);
  return u.toString();
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  getConfig().then(cfg => {
    try {
      ws = new WebSocket(wsUrl(cfg));
      ws.onopen = () => { ws.send(JSON.stringify({ type: 'hello', token: cfg.token })); };
      ws.onmessage = async (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'hello_ack') {
          connected = !!msg.ok;
          if (msg.ok) chrome.action.setBadgeText({ text: 'ON' }); else chrome.action.setBadgeText({ text: 'ERR' });
          return;
        }
        if (msg.type === 'command') {
          try {
            const result = await handleCommand(msg.cmd, msg.params || {});
            ws.send(JSON.stringify({ id: msg.id, type: 'response', result }));
          } catch (e) {
            ws.send(JSON.stringify({ id: msg.id, type: 'response', error: (e && e.message) || String(e) }));
          }
        }
      };
      ws.onclose = () => { connected = false; chrome.action.setBadgeText({ text: '' }); scheduleReconnect(); };
      ws.onerror = () => {};
    } catch (e) { scheduleReconnect(); }
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
}
function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  connected = false;
  chrome.action.setBadgeText({ text: '' });
}

function pushEvent(tabId, method, params) {
  const b = buf(tabId);
  const entry = { method, params, ts: Date.now() };
  b.events.push(entry);
  if (b.events.length > MAX_EVENTS) b.events.splice(0, b.events.length - MAX_EVENTS);
  if (method === 'Network.requestWillBeSent') b.network.push({ kind: 'request', ...params, ts: Date.now() });
  else if (method === 'Network.responseReceived') b.network.push({ kind: 'response', ...params, ts: Date.now() });
  else if (method === 'Network.loadingFinished') b.network.push({ kind: 'finished', ...params, ts: Date.now() });
  else if (method === 'Network.loadingFailed') b.network.push({ kind: 'failed', ...params, ts: Date.now() });
  else if (method === 'Console.messageAdded') b.console.push({ ...params, ts: Date.now() });
  else if (method === 'Runtime.consoleAPICalled') b.console.push({ type: params.type, args: params.args, ts: Date.now() });
}

async function sendCDP(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve(res);
    });
  });
}

async function attachDebugger(tabId) {
  if (tabId == null) {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = t.id;
  }
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', async () => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      attached.add(tabId);
      buf(tabId);
      for (const m of ['Page.enable','Network.enable','Runtime.enable','DOM.enable','Console.enable','Log.enable']) {
        try { await sendCDP(tabId, m, {}); } catch (e) {}
      }
      resolve({ tabId, attached: true });
    });
  });
}

async function detachDebugger(tabId) {
  if (tabId == null) {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = t.id;
  }
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => { attached.delete(tabId); resolve({ tabId, detached: true }); });
  });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId != null) pushEvent(source.tabId, method, params);
});
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
});

async function handleCommand(cmd, params) {
  switch (cmd) {
    case 'listTabs': {
      const tabs = await chrome.tabs.query({});
      return tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId, status: t.status }));
    }
    case 'attachDebugger': return attachDebugger(params.tabId);
    case 'detachDebugger': return detachDebugger(params.tabId);
    case 'navigate': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      await chrome.tabs.update(tabId, { url: params.url });
      return { tabId, url: params.url };
    }
    case 'reload': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      await chrome.tabs.reload(tabId, { bypassCache: !!params.ignoreCache });
      return { tabId };
    }
    case 'evaluate': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (attached.has(tabId)) {
        const r = await sendCDP(tabId, 'Runtime.evaluate', {
          expression: params.expression, awaitPromise: !!params.awaitPromise, returnByValue: params.returnByValue !== false,
        });
        return r;
      }
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (expr) => { try { return eval(expr); } catch (e) { throw e && e.message ? e.message : String(e); } },
        args: [params.expression],
      });
      return { result: { type: 'return', value: res.result } };
    }
    case 'queryDom': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => Array.from(document.querySelectorAll(sel)).slice(0,100).map(e=>e.outerHTML),
        args: [params.selector],
      });
      return { matches: res.result };
    }
    case 'click': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => { const e=document.querySelector(sel); if(!e) return {ok:false}; e.click(); return {ok:true}; },
        args: [params.selector],
      });
      return res.result;
    }
    case 'typeText': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel, text) => {
          const e = document.querySelector(sel); if(!e) return {ok:false};
          e.focus();
          if ('value' in e) { e.value = text; e.dispatchEvent(new Event('input',{bubbles:true})); }
          else { e.textContent = text; }
          return {ok:true};
        },
        args: [params.selector, params.text],
      });
      return res.result;
    }
    case 'cdpSend': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      const r = await sendCDP(tabId, params.method, params.params || {});
      return r;
    }
    case 'getNetwork': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const b = buf(tabId);
      let items = b.network.slice();
      if (params.urlFilter) items = items.filter(i => JSON.stringify(i).includes(params.urlFilter));
      if (params.limit) items = items.slice(-params.limit);
      return { tabId, count: items.length, items };
    }
    case 'getConsole': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const b = buf(tabId);
      let items = b.console.slice();
      if (params.limit) items = items.slice(-params.limit);
      return { tabId, count: items.length, items };
    }
    case 'screenshot': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const tab = await chrome.tabs.get(tabId);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      return { tabId, dataUrl };
    }
    case 'getCookies': {
      const all = await chrome.cookies.getAll(params.urls && params.urls.length ? { url: params.urls[0], name: params.name } : (params.name ? { name: params.name } : {}));
      return { cookies: all };
    }
    case 'setCookie': {
      const c = await chrome.cookies.set(params);
      return { cookie: c };
    }
    case 'storageGet': {
      if (params.area === 'local') {
        const r = await chrome.storage.local.get(params.key ? [params.key] : null);
        return r;
      }
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (k) => {
          if (k) return { [k]: window.localStorage.getItem(k) };
          const out={}; for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i); out[key]=localStorage.getItem(key);} return out;
        },
        args: [params.key],
      });
      return res.result;
    }
    case 'getPerformance': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { const n = performance.getEntriesByType('navigation')[0]; return n ? JSON.parse(JSON.stringify(n)) : null; },
      });
      return { timing: res.result };
    }
    case 'listFrames': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      return { frames };
    }
    default: throw new Error('Unknown command: ' + cmd);
  }
}

chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
connect();

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'getConfig') { getConfig().then(sendResponse); return true; }
  if (msg && msg.type === 'setConfig') { chrome.storage.local.set(msg.data || {}).then(() => sendResponse({ ok: true })); return true; }
  if (msg && msg.type === 'connect') { connect(); sendResponse({ ok: true }); return false; }
  if (msg && msg.type === 'disconnect') { disconnect(); sendResponse({ ok: true }); return false; }
  if (msg && msg.type === 'status') { sendResponse({ connected, attached: [...attached] }); return false; }
});

