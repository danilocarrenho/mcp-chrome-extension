const $ = (id) => document.getElementById(id);
async function load() {
  const cfg = await chrome.runtime.sendMessage({ type: 'getConfig' });
  $('host').value = cfg.serverHost || '127.0.0.1';
  $('port').value = cfg.serverPort || 8765;
  $('token').value = cfg.token || '';  refresh();
}
async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'status' });
  const el = $('status');
  el.textContent = s.connected ? 'Connected (attached tabs: ' + s.attached.join(',') + (s.attached.length?'':' none') + ')' : 'Disconnected';
  el.className = 'status ' + (s.connected ? 'on' : 'err');
}
$('save').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'setConfig', data: {
    serverHost: $('host').value.trim(),
    serverPort: Number($('port').value),
    token: $('token').value.trim(),
  }});
  await chrome.runtime.sendMessage({ type: 'connect' });
  refresh();
});
$('disconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'disconnect' });
  refresh();
});
load();
setInterval(refresh, 2000);

