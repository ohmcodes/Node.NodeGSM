'use strict';
// Minimal WebRCON client (Rust, and other games that speak the same WebSocket RCON): ws://<host>:<port>/<password>.
// Request  { "Identifier": <int>, "Message": "<command>", "Name": "NodeGSM" }
// Response { "Identifier": <same int>, "Message": "<text>", "Type": "Generic", "Stacktrace": "" }
// The server also pushes console lines with Identifier 0 / -1; those are ignored here.
// Same rules as rcon.js: only the address it is given is contacted (NodeGSM passes 127.0.0.1), the password never appears
// in errors, logs or toString(), commands are limited to 4096 bytes, every wait has a timeout. Same interface as RconClient:
// connect(), send(command), close(), connected.
const WebSocket = require('ws');

const MAX_BODY = 4096;
const MAX_RESPONSE = 1024 * 1024;
const DEFAULTS = { connectTimeoutMs: 4000, commandTimeoutMs: 8000 };

class WebRconClient {
  /** @param {{host?:string, port:number, password:string, connectTimeoutMs?:number, commandTimeoutMs?:number}} o */
  constructor(o) {
    const port = Number(o && o.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid RCON port');
    Object.defineProperty(this, '_pw', { value: String(o.password == null ? '' : o.password), enumerable: false });
    this.host = o.host || '127.0.0.1'; this.port = port;
    this.opts = { ...DEFAULTS, ...Object.fromEntries(Object.entries(o).filter(([k]) => k in DEFAULTS)) };
    this.ws = null; this.nextId = 1; this.pending = new Map(); this.open = false;
  }
  toString() { return `WebRconClient(${this.host}:${this.port})`; }
  [Symbol.for('nodejs.util.inspect.custom')]() { return this.toString(); }
  get connected() { return !!this.ws && this.open; }

  _failAll(err) { for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); } this.pending.clear(); }

  connect() {
    if (this.connected) return Promise.resolve();
    this.close();
    return new Promise((resolve, reject) => {
      let settled = false;
      const url = `ws://${this.host.includes(':') ? `[${this.host}]` : this.host}:${this.port}/${encodeURIComponent(this._pw)}`;
      let ws;
      try { ws = new WebSocket(url, { handshakeTimeout: this.opts.connectTimeoutMs, maxPayload: MAX_RESPONSE + 4096 }); } catch { return reject(new Error('RCON connection failed')); }
      this.ws = ws;
      const done = (err) => { if (settled) return; settled = true; clearTimeout(timer); if (err) { this.close(); reject(err); } else resolve(); };
      const timer = setTimeout(() => done(new Error('RCON connection timed out')), this.opts.connectTimeoutMs + 500);
      ws.on('open', () => { if (this.ws !== ws) return; this.open = true; done(); });
      ws.on('message', (data) => {
        if (this.ws !== ws) return;
        let m; try { m = JSON.parse(String(data)); } catch { return; }
        if (!m || typeof m !== 'object') return;
        const p = this.pending.get(m.Identifier);
        if (!p) return;                                  // pushed console line, not an answer to one of our commands
        this.pending.delete(m.Identifier); clearTimeout(p.timer);
        p.resolve(String(m.Message == null ? '' : m.Message).slice(0, MAX_RESPONSE));
      });
      // a wrong password is refused during the handshake (HTTP 401 / 403) or by closing the socket right away
      ws.on('unexpected-response', (_req, res) => { done(new Error(res.statusCode === 401 || res.statusCode === 403 ? 'RCON authentication failed (wrong password?)' : `RCON connection failed: HTTP ${res.statusCode}`)); });
      ws.on('error', (e) => { if (this.ws !== ws) return; const m = new Error(`RCON connection failed: ${e.code || 'error'}`); this._failAll(m); done(m); });
      ws.on('close', () => { if (this.ws !== ws) return; this.open = false; this._failAll(new Error('RCON connection closed')); done(new Error('RCON connection closed')); });
    });
  }

  /** Send one command; resolves with the reply text. Several commands may be in flight; each is matched by its Identifier. */
  async send(command) {
    command = String(command);
    if (Buffer.byteLength(command, 'utf8') > MAX_BODY) throw new Error(`RCON command too long (limit ${MAX_BODY} bytes)`);
    await this.connect();
    const id = this.nextId++; if (this.nextId > 0x7ffffff0) this.nextId = 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('RCON command timed out')); }, this.opts.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ Identifier: id, Message: command, Name: 'NodeGSM' })); }
      catch { this.pending.delete(id); clearTimeout(timer); reject(new Error('RCON connection closed')); }
    });
  }

  close() {
    this.open = false;
    if (this.ws) { const ws = this.ws; this.ws = null; try { ws.terminate(); } catch { /* ignore */ } }
    this._failAll(new Error('RCON connection closed'));
  }
}

module.exports = { WebRconClient, MAX_BODY };
