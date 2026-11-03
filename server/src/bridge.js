const WebSocket = require('ws');
const { EventEmitter } = require('events');

const DEFAULT_PORT = Number(process.env.MCP_CHROME_PORT || 8765);
const TOKEN_FILE = require('path').join(require('os').homedir(), '.mcp-chrome', 'token');

function ensureToken() {
  const fs = require('fs');
  const dir = require('path').dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(TOKEN_FILE)) {
    const crypto = require('crypto');
    const t = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
    return t;
  }
  return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
}

class Bridge extends EventEmitter {
  constructor() {
    super();
    this.port = Number(process.env.MCP_CHROME_PORT || DEFAULT_PORT);
    this.token = process.env.MCP_CHROME_TOKEN || ensureToken();
    this.wss = null;
    this.socket = null;
    this.pending = new Map(); // id -> {resolve,reject, timer}
    this.reqSeq = 0;
    this.disableAuth = !!process.env.MCP_CHROME_DISABLE_AUTH;
  }

  start() {
    this.wss = new WebSocket.Server({ port: this.port, host: '127.0.0.1' });
    this.wss.on('connection', (ws, req) => {
      // auth via first message or query token
      const url = new URL(req.url, 'http://localhost');
      const qToken = url.searchParams.get('token');
      if (!this.disableAuth && qToken && qToken !== this.token) {
        ws.close(1008, 'bad token');
        return;
      }
      ws.on('message', (data) => {
        let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.type === 'hello') {
          if (!this.disableAuth && msg.token !== this.token) {
            ws.send(JSON.stringify({ type: 'hello_ack', ok: false, error: 'bad token' }));
            ws.close(); return;
          }
          this.socket = ws;
          ws.send(JSON.stringify({ type: 'hello_ack', ok: true }));
          this.emit('connected');
          return;
        }
        if (msg.type === 'response' && msg.id != null) {
          const p = this.pending.get(msg.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error));
            else p.resolve(msg.result);
          }
          return;
        }
        if (msg.type === 'event') {
          this.emit('event', msg);
          return;
        }
      });
      ws.on('close', () => {
        if (this.socket === ws) {
          this.socket = null;
          this.emit('disconnected');
        }
      });
    });
    return this;
  }

  isConnected() { return !!this.socket && this.socket.readyState === WebSocket.OPEN; }

  // send a command to the extension and await response
  send(cmd, params = {}, timeout = 30000) {
    if (!this.isConnected()) {
      return Promise.reject(new Error('Chrome extension is not connected. Open the extension popup and connect it to the MCP server.'));
    }
    const id = ++this.reqSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for extension response to ${cmd} (${timeout}ms)`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, type: 'command', cmd, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  stop() {
    if (this.wss) this.wss.close();
  }
}

module.exports = { Bridge, ensureToken, TOKEN_FILE };
