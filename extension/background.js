// MCP Chrome Bridge - service worker
const DEFAULT_PORT = 8765;
let ws = null;
let connected = false;
let reconnectTimer = null;
let isConnecting = false;
const buffers = {};
const attached = new Set();
const MAX_EVENTS = 2000;
const extErrors = [];
function recordExtError(e) {
  try {
    extErrors.push({ ts: Date.now(), message: (e && (e.message || e.reason || e)) , stack: (e && e.stack) || null });
    if (extErrors.length > 100) extErrors.shift();
  } catch {}
}
self.addEventListener('error', (e) => { recordExtError(e.error || { message: e.message, stack: e.stack || e.filename + ':' + e.lineno }); });
self.addEventListener('unhandledrejection', (e) => { recordExtError(e.reason || { message: String(e.reason) }); });
const _origConsoleError = console.error.bind(console);
console.error = (...args) => { recordExtError({ message: args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') }); _origConsoleError(...args); };
const traceEvents = [];
const screencastFrames = [];
let coverageEnabled = false;

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
  if (isConnecting) return;
  isConnecting = true;
  getConfig().then(cfg => {
    try {
      ws = new WebSocket(wsUrl(cfg));
      ws.onopen = () => {
        const hello = () => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: 'hello', token: cfg.token })); }
            catch (e) { scheduleReconnect(); }
          } else if (ws && ws.readyState === WebSocket.CONNECTING) {
            setTimeout(hello, 50);
          }
        };
        hello();
      };
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
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: msg.id, type: 'response', result }));
          } catch (e) {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: msg.id, type: 'response', error: (e && e.message) || String(e) }));
          }
        }
      };
      ws.onclose = () => { connected = false; chrome.action.setBadgeText({ text: '' }); scheduleReconnect(); };
      ws.onerror = () => {};
    } catch (e) { scheduleReconnect(); }
    isConnecting = false;
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
  if (method === 'Tracing.dataCollected' && params && params.value) {
    for (const e of params.value) traceEvents.push(e);
    if (traceEvents.length > 200000) traceEvents.splice(0, traceEvents.length - 200000);
  }
  if (method === 'Page.screencastFrame' && params && params.data) {
    screencastFrames.push({ data: params.data, sessionId: params.sessionId, metadata: params.metadata });
    if (screencastFrames.length > 100) screencastFrames.splice(0, screencastFrames.length - 100);
    // acknowledge frame to continue stream
    if (source.tabId != null && attached.has(source.tabId)) {
      chrome.debugger.sendCommand({ tabId: source.tabId }, 'Page.screencastFrameAck', { sessionId: params.sessionId }, () => {});
    }
  }
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
    case 'getExtensionErrors': {
      return { count: extErrors.length, errors: extErrors.slice() };
    }
    case 'createTab': {
      const tab = await chrome.tabs.create({ url: params.url, active: params.active !== false });
      if (params.waitForLoad) {
        const timeout = params.timeout || 15000;
        const start = Date.now();
        while (Date.now() - start < timeout) {
          const t = await chrome.tabs.get(tab.id);
          if (t.status === 'complete') return { tabId: tab.id, windowId: tab.windowId, url: t.url, status: t.status };
          await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error('Timed out waiting for tab load');
      }
      return { tabId: tab.id, windowId: tab.windowId, url: tab.url || params.url || null };
    }
    case 'closeTab': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      await chrome.tabs.remove(tabId);
      return { tabId, closed: true };
    }
    case 'focusTab': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
      return { tabId, focused: true };
    }
    case 'waitForLoad': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const timeout = params.timeout || 15000;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') return { tabId, status: 'complete', url: tab.url };
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('Timed out waiting for tab load');
    }
    case 'waitForSelector': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const timeout = params.timeout || 15000;
      const interval = params.interval || 250;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (sel) => !!document.querySelector(sel),
          args: [params.selector],
        });
        if (res && res.result) return { tabId, found: true, selector: params.selector };
        await new Promise((r) => setTimeout(r, interval));
      }
      throw new Error('Timed out waiting for selector: ' + params.selector);
    }
    case 'hover': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => { const e = document.querySelector(sel); if (e) e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); },
        args: [params.selector],
      });
      await new Promise((r) => setTimeout(r, 100));
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => {
          const e = document.querySelector(sel);
          if (!e) return null;
          const r = e.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        },
        args: [params.selector],
      });
      if (!res || !res.result) throw new Error('Element not found: ' + params.selector);
      await sendCDP(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: res.result.x, y: res.result.y, button: 'none', buttons: 0 });
      return { tabId, hovered: true };
    }
    case 'scroll': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel, x, y, behavior) => {
          if (sel) {
            const e = document.querySelector(sel);
            if (!e) return { ok: false };
            e.scrollIntoView({ behavior: behavior || 'smooth', block: 'center', inline: 'center' });
            return { ok: true };
          }
          window.scrollTo({ left: x ?? window.scrollX, top: y ?? window.scrollY, behavior: behavior || 'smooth' });
          return { ok: true, x: window.scrollX, y: window.scrollY };
        },
        args: [params.selector || null, params.x ?? null, params.y ?? null, params.behavior || 'smooth'],
      });
      return { tabId, ...(res ? res.result : { ok: false }) };
    }
    case 'pressKey': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (params.selector) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (sel) => { const e = document.querySelector(sel); if (e) e.focus(); },
          args: [params.selector],
        });
      }
      if (!attached.has(tabId)) await attachDebugger(tabId);
      const key = params.key;
      const code = params.code || key;
      const text = (key && key.length === 1) ? key : '';
      await sendCDP(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code, text, unmodifiedText: text });
      if (text) await sendCDP(tabId, 'Input.dispatchKeyEvent', { type: 'char', key, code, text });
      await sendCDP(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, text });
      return { tabId, pressed: key };
    }
    case 'goBack': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      await chrome.tabs.goBack(tabId);
      return { tabId, ok: true };
    }
    case 'goForward': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      await chrome.tabs.goForward(tabId);
      return { tabId, ok: true };
    }
    case 'dragAndDrop': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      const [srcRes] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); const r2 = e.getBoundingClientRect(); return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2 }; },
        args: [params.sourceSelector],
      });
      const [dstRes] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); const r2 = e.getBoundingClientRect(); return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2 }; },
        args: [params.targetSelector],
      });
      if (!srcRes || !srcRes.result || !dstRes || !dstRes.result) throw new Error('Source or target not found');
      await sendCDP(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: srcRes.result.x, y: srcRes.result.y, button: 'left', buttons: 1, clickCount: 1 });
      await sendCDP(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: dstRes.result.x, y: dstRes.result.y, button: 'left', buttons: 1 });
      await sendCDP(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: dstRes.result.x, y: dstRes.result.y, button: 'left', buttons: 0, clickCount: 1 });
      return { tabId, ok: true };
    }
    case 'selectOption': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel, value, text) => {
          const e = document.querySelector(sel);
          if (!e) return { ok: false };
          if (value != null) e.value = value;
          else if (text != null) {
            const opt = Array.from(e.options).find((o) => o.textContent.trim() === text || o.value === text);
            if (opt) e.value = opt.value; else return { ok: false };
          }
          e.dispatchEvent(new Event('input', { bubbles: true }));
          e.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, value: e.value };
        },
        args: [params.selector, params.value ?? null, params.text ?? null],
      });
      return { tabId, ...(res ? res.result : { ok: false }) };
    }
    case 'uploadFile': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'DOM.enable', {});
      const { root } = await sendCDP(tabId, 'DOM.getDocument', {});
      const { nodeId } = await sendCDP(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector: params.selector });
      if (!nodeId) throw new Error('File input not found: ' + params.selector);
      await sendCDP(tabId, 'DOM.setFileInputFiles', { nodeId, files: params.files || [] });
      return { tabId, ok: true, nodeId };
    }
    case 'emulateDevice': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      if (params.reset) {
        await sendCDP(tabId, 'Emulation.clearDeviceMetricsOverride', {});
        await sendCDP(tabId, 'Emulation.clearGeolocationOverride', {});
        return { tabId, reset: true };
      }
      await sendCDP(tabId, 'Emulation.setDeviceMetricsOverride', {
        width: params.width || 390,
        height: params.height || 844,
        deviceScaleFactor: params.deviceScaleFactor || 2,
        mobile: params.mobile !== false,
        screenOrientation: (params.width || 390) >= (params.height || 844) ? { angle: 90, type: 'landscapePrimary' } : { angle: 0, type: 'portraitPrimary' },
      });
      if (params.userAgent) await sendCDP(tabId, 'Emulation.setUserAgentOverride', { userAgent: params.userAgent });
      return { tabId, ok: true };
    }
    case 'setGeolocation': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Emulation.setGeolocationOverride', {
        latitude: params.latitude,
        longitude: params.longitude,
        accuracy: params.accuracy || 100,
      });
      return { tabId, ok: true };
    }
    case 'setColorScheme': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Emulation.setEmulatedMedia', {
        media: params.media || '',
        features: [{ name: 'prefers-color-scheme', value: params.scheme || 'dark' }],
      });
      return { tabId, scheme: params.scheme || 'dark' };
    }
    case 'blockUrls': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Network.enable', {});
      await sendCDP(tabId, 'Network.setBlockedURLs', { urls: params.urls || [] });
      return { tabId, blocked: params.urls || [] };
    }
    case 'fullPageScreenshot': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Page.enable', {});
      const res = await sendCDP(tabId, 'Page.captureScreenshot', { format: params.format || 'png', captureBeyondViewport: true, fromSurface: true });
      return { tabId, dataUrl: 'data:image/' + (params.format || 'png') + ';base64,' + res.data };
    }
    case 'screenshotElement': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Page.enable', {});
      const [boxRes] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => {
          const e = document.querySelector(sel);
          if (!e) return null;
          const r = e.getBoundingClientRect();
          e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          const r2 = e.getBoundingClientRect();
          return { x: Math.max(0, r2.x), y: Math.max(0, r2.y), width: r2.width, height: r2.height, dpr: window.devicePixelRatio || 1 };
        },
        args: [params.selector],
      });
      if (!boxRes || !boxRes.result || !boxRes.result.width) throw new Error('Element not found: ' + params.selector);
      const b = boxRes.result;
      const res = await sendCDP(tabId, 'Page.captureScreenshot', {
        format: params.format || 'png',
        clip: { x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 },
        captureBeyondViewport: true,
      });
      return { tabId, dataUrl: 'data:image/' + (params.format || 'png') + ';base64,' + res.data };
    }
    case 'printToPdf': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Page.enable', {});
      const res = await sendCDP(tabId, 'Page.printToPDF', {
        landscape: !!params.landscape,
        printBackground: params.printBackground !== false,
        scale: params.scale || 1,
      });
      return { tabId, dataUrl: 'data:application/pdf;base64,' + res.data };
    }
    case 'getElementInfo': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => {
          const e = document.querySelector(sel);
          if (!e) return null;
          const r = e.getBoundingClientRect();
          const attrs = {};
          for (const a of e.attributes) attrs[a.name] = a.value;
          return { tag: e.tagName.toLowerCase(), text: (e.textContent || '').trim(), attributes: attrs, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, visible: r.width > 0 && r.height > 0 };
        },
        args: [params.selector],
      });
      return { tabId, info: res ? res.result : null };
    }
    case 'moveTab': {
      const index = params.index == null ? (params.position || 0) : params.index;
      await chrome.tabs.move(params.tabId, { index });
      return { tabId: params.tabId, index };
    }
    case 'pinTab': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      await chrome.tabs.update(tabId, { pinned: params.pinned !== false });
      return { tabId, pinned: params.pinned !== false };
    }
    case 'muteTab': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      await chrome.tabs.update(tabId, { muted: !!params.muted });
      return { tabId, muted: !!params.muted };
    }
    case 'duplicateTab': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const t = await chrome.tabs.duplicate(tabId);
      return { tabId: t.id, windowId: t.windowId };
    }
    case 'listWindows': {
      const wins = await chrome.windows.getAll({ populate: true });
      return { windows: wins.map((w) => ({ id: w.id, focused: w.focused, state: w.state, tabs: (w.tabs || []).map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, pinned: t.pinned })) })) };
    }
    case 'closeTabsMatching': {
      const tabs = await chrome.tabs.query({});
      const matches = tabs.filter((t) => {
        if (params.urlContains && !(t.url || '').includes(params.urlContains)) return false;
        if (params.titleContains && !(t.title || '').toLowerCase().includes(String(params.titleContains).toLowerCase())) return false;
        return true;
      });
      for (const t of matches) await chrome.tabs.remove(t.id);
      return { closed: matches.map((t) => t.id) };
    }
    case 'evaluateInFrame': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      const frame = frames.find((f) => f.frameId === params.frameId) || frames.find((f) => params.urlContains && (f.url || '').includes(params.urlContains));
      if (!frame) throw new Error('Frame not found');
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        func: (expr) => { try { return eval(expr); } catch (e) { throw e && e.message ? e.message : String(e); } },
        args: [params.expression],
      });
      return { tabId, frameId: frame.frameId, result: res ? res.result : null };
    }
    case 'queryDomInFrame': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      const frame = frames.find((f) => f.frameId === params.frameId) || frames.find((f) => params.urlContains && (f.url || '').includes(params.urlContains));
      if (!frame) throw new Error('Frame not found');
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        func: (sel) => Array.from(document.querySelectorAll(sel)).slice(0, 100).map((e) => e.outerHTML),
        args: [params.selector],
      });
      return { tabId, frameId: frame.frameId, matches: res ? res.result : [] };
    }
    case 'enableRequestInterception': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Fetch.enable', { patterns: params.patterns || [{ urlPattern: '*', requestStage: 'Request' }] });
      return { tabId, enabled: true };
    }
    case 'disableRequestInterception': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (attached.has(tabId)) await sendCDP(tabId, 'Fetch.disable', {});
      return { tabId, enabled: false };
    }
    case 'continueRequest': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      await sendCDP(tabId, 'Fetch.continueRequest', { requestId: params.requestId, url: params.url, method: params.method, postData: params.postData, headers: params.headers });
      return { tabId, ok: true };
    }
    case 'fulfillRequest': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      await sendCDP(tabId, 'Fetch.fulfillRequest', { requestId: params.requestId, responseCode: params.status || 200, responseHeaders: params.headers || [], body: params.body ? btoa(params.body) : undefined });
      return { tabId, ok: true };
    }
    case 'failRequest': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      await sendCDP(tabId, 'Fetch.failRequest', { requestId: params.requestId, errorReason: params.reason || 'Failed' });
      return { tabId, ok: true };
    }
    case 'setExtraHeaders': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Network.enable', {});
      await sendCDP(tabId, 'Network.setExtraHTTPHeaders', { headers: params.headers || {} });
      return { tabId, headers: params.headers || {} };
    }
    case 'setOfflineMode': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Network.enable', {});
      await sendCDP(tabId, 'Network.emulateNetworkConditions', { offline: !!params.offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      return { tabId, offline: !!params.offline };
    }
    case 'clearBrowserCache': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Network.enable', {});
      await sendCDP(tabId, 'Network.clearBrowserCache', {});
      return { tabId, cleared: true };
    }
    case 'clearBrowserCookiesCdp': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Network.enable', {});
      await sendCDP(tabId, 'Network.clearBrowserCookies', {});
      return { tabId, cleared: true };
    }
    case 'clearSiteData': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Storage.clearDataForOrigin', { origin: params.origin, storageTypes: params.storageTypes || 'all' });
      return { tabId, origin: params.origin, cleared: true };
    }
    case 'accessibilityTree': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Accessibility.enable', {});
      const res = await sendCDP(tabId, 'Accessibility.getFullAXTree', {});
      return { tabId, nodes: res.nodes || [] };
    }
    case 'performanceMetrics': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Performance.enable', {});
      const res = await sendCDP(tabId, 'Performance.getMetrics', {});
      return { tabId, metrics: res.metrics || [] };
    }
    case 'downloadFile': {
      const id = await chrome.downloads.download({ url: params.url, filename: params.filename, saveAs: !!params.saveAs });
      return { id };
    }
    case 'listDownloads': {
      const items = await chrome.downloads.search(params || {});
      return { downloads: items };
    }
    case 'cancelDownload': {
      await chrome.downloads.cancel(params.id);
      return { id: params.id, cancelled: true };
    }
    case 'getPageErrors': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const b = buf(tabId);
      const items = (b.console || []).filter((x) => /error/i.test(x.type || '') || /error/i.test(JSON.stringify(x)));
      return { tabId, count: items.length, items };
    }
    case 'typeTextHuman': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const delay = params.delay || 50;
      if (params.selector) await chrome.scripting.executeScript({ target: { tabId }, func: (sel) => { const e = document.querySelector(sel); if (e) e.focus(); }, args: [params.selector] });
      const text = params.text || '';
      for (const ch of text) {
        await sendCDP(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: '', text: ch });
        await sendCDP(tabId, 'Input.dispatchKeyEvent', { type: 'char', key: ch, code: '', text: ch });
        await sendCDP(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: '', text: ch });
        await new Promise((r) => setTimeout(r, delay));
      }
      return { tabId, typed: text.length };
    }
    case 'scrollBy': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (dx, dy, smooth) => { window.scrollBy({ left: dx || 0, top: dy || 0, behavior: smooth ? 'smooth' : 'instant' }); return { x: window.scrollX, y: window.scrollY }; },
        args: [params.x || 0, params.y || 0, params.smooth !== false],
      });
      return { tabId, ...(res ? res.result : {}) };
    }
    case 'submitForm': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => { const e = sel ? document.querySelector(sel) : document.querySelector('form'); if (!e) return { ok: false }; if (typeof e.requestSubmit === 'function') e.requestSubmit(); else e.submit(); return { ok: true }; },
        args: [params.selector || null],
      });
      return { tabId, ...(res ? res.result : { ok: false }) };
    }
    case 'queryShadow': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (rootSel, sel) => {
          const root = rootSel ? document.querySelector(rootSel) : document;
          const scope = (root && root.shadowRoot) ? root.shadowRoot : root;
          return Array.from((scope || document).querySelectorAll(sel)).slice(0, 100).map((e) => e.outerHTML);
        },
        args: [params.rootSelector || null, params.selector],
      });
      return { tabId, matches: res ? res.result : [] };
    }
    case 'setThrottle': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Network.enable', {});
      await sendCDP(tabId, 'Network.emulateNetworkConditions', {
        offline: !!params.offline,
        latency: params.latency || 0,
        downloadThroughput: params.downloadThroughput == null ? -1 : params.downloadThroughput,
        uploadThroughput: params.uploadThroughput == null ? -1 : params.uploadThroughput,
      });
      return { tabId, ok: true };
    }
    case 'setCacheDisabled': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Network.enable', {});
      await sendCDP(tabId, 'Network.setCacheDisabled', { cacheDisabled: !!params.disabled });
      return { tabId, disabled: !!params.disabled };
    }
    case 'getResponseBody': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      const res = await sendCDP(tabId, 'Network.getResponseBody', { requestId: params.requestId });
      return { tabId, ...res };
    }
    case 'getHAR': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const b = buf(tabId);
      return { tabId, entries: (b.network || []).slice() };
    }
    case 'sessionStorageGet': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (k) => {
          if (k) return { [k]: window.sessionStorage.getItem(k) };
          const out = {}; for (let i = 0; i < sessionStorage.length; i++) { const key = sessionStorage.key(i); out[key] = sessionStorage.getItem(key); } return out;
        },
        args: [params.key || null],
      });
      return { tabId, ...(res ? res.result : {}) };
    }
    case 'sessionStorageSet': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (k, v) => { window.sessionStorage.setItem(k, v); return { ok: true }; },
        args: [params.key, params.value],
      });
      return { tabId, ...(res ? res.result : { ok: false }) };
    }
    case 'chromeState': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const tabs = await chrome.tabs.query({});
      const [titleRes] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ title: document.title, url: location.href, readyState: document.readyState }) });
      const b = buf(tabId);
      return {
        tabId,
        tab: tabs.find((t) => t.id === tabId),
        page: titleRes ? titleRes.result : null,
        counts: { network: (b.network || []).length, console: (b.console || []).length, events: (b.events || []).length },
        attachedTabs: [...attached],
      };
    }
    case 'enableCoverage': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      if (params.type === 'css') await sendCDP(tabId, 'CSS.enable', {});
      else await sendCDP(tabId, 'Profiler.enable', {});
      await sendCDP(tabId, 'Profiler.startPreciseCoverage', { callCount: true, detailed: true });
      coverageEnabled = true;
      return { tabId, enabled: true };
    }
    case 'getCoverage': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      const res = await sendCDP(tabId, 'Profiler.takePreciseCoverage', {});
      return { tabId, result: res };
    }
    case 'tracingStart': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      traceEvents.length = 0;
      await sendCDP(tabId, 'Tracing.start', { categories: params.categories || 'devtools.timeline,disabled-by-default-devtools.timeline' });
      return { tabId, started: true };
    }
    case 'tracingStop': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (attached.has(tabId)) await sendCDP(tabId, 'Tracing.end', {});
      await new Promise((r) => setTimeout(r, 1000));
      return { tabId, eventCount: traceEvents.length, events: traceEvents.slice(-5000) };
    }
    case 'startScreencast': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      screencastFrames.length = 0;
      await sendCDP(tabId, 'Page.startScreencast', { format: params.format || 'jpeg', quality: params.quality || 60, maxWidth: params.maxWidth || 1280, maxHeight: params.maxHeight || 720 });
      return { tabId, started: true };
    }
    case 'stopScreencast': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (attached.has(tabId)) await sendCDP(tabId, 'Page.stopScreencast', {});
      return { tabId, frameCount: screencastFrames.length, frames: screencastFrames.slice(-20) };
    }
    case 'pauseDebugger': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Debugger.enable', {});
      await sendCDP(tabId, 'Debugger.pause', {});
      return { tabId, paused: true };
    }
    case 'resumeDebugger': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (attached.has(tabId)) await sendCDP(tabId, 'Debugger.resume', {});
      return { tabId, resumed: true };
    }
    case 'stepOver': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (attached.has(tabId)) await sendCDP(tabId, 'Debugger.stepOver', {});
      return { tabId, ok: true };
    }
    case 'setPermissions': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Browser.grantPermissions', { origin: params.origin, permissions: params.permissions || [] });
      return { tabId, granted: params.permissions || [] };
    }
    case 'virtualAuthenticator': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      if (params.enable) await sendCDP(tabId, 'WebAuthn.enable', {});
      else await sendCDP(tabId, 'WebAuthn.disable', {});
      if (params.enable && params.add) {
        const res = await sendCDP(tabId, 'WebAuthn.addVirtualAuthenticator', { options: params.options || { protocol: 'ctap2', transport: 'usb', hasResidentKey: false, hasUserVerification: true, isUserConsenting: true, isUserVerified: true } });
        return { tabId, authenticatorId: res.authenticatorId };
      }
      return { tabId, ok: true };
    }
    case 'queryPermissions': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (names) => {
          const out = {};
          for (const n of names || []) {
            try { const s = await navigator.permissions.query({ name: n }); out[n] = s.state; } catch (e) { out[n] = 'error: ' + (e && e.message ? e.message : e); }
          }
          return out;
        },
        args: [params.names || ['geolocation', 'notifications', 'camera', 'microphone']],
      });
      return { tabId, permissions: res ? res.result : {} };
    }
    case 'getMemoryUsage': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'Performance.enable', {});
      const res = await sendCDP(tabId, 'Performance.getMetrics', {});
      return { tabId, metrics: res.metrics || [] };
    }
    case 'waitNetworkIdle': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const timeout = params.timeout || 5000;
      await new Promise((r) => setTimeout(r, timeout));
      return { tabId, waited: timeout };
    }
    case 'listFramesDetailed': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      return { tabId, frames };
    }
    case 'getDocument': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'DOM.enable', {});
      const doc = await sendCDP(tabId, 'DOM.getDocument', { depth: params.depth || 2, pierce: !!params.pierce });
      return { tabId, document: doc };
    }
    case 'querySelectorNode': {
      const tabId = params.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      if (!attached.has(tabId)) await attachDebugger(tabId);
      await sendCDP(tabId, 'DOM.enable', {});
      const { root } = await sendCDP(tabId, 'DOM.getDocument', {});
      const { nodeId } = await sendCDP(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector: params.selector });
      const attrs = nodeId ? await sendCDP(tabId, 'DOM.getAttributes', { nodeId }) : null;
      const box = nodeId ? await sendCDP(tabId, 'DOM.getBoxModel', { nodeId }).catch(() => null) : null;
      return { tabId, nodeId, attributes: attrs ? attrs.attributes : null, box };
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

