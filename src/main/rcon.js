'use strict';
// Minimal Source RCON client (also used by Minecraft Java): https://developer.valvesoftware.com/wiki/Source_RCON_Protocol
// Packet = int32le size | int32le id | int32le type | body (ASCII/UTF-8) | 0x00 | 0x00   (size counts everything after itself)
//   type 3 = auth request, 2 = auth response (client: exec command), 0 = response value (client: used as the end marker)
// Rules: the client only ever connects to the address it is given (NodeGSM always passes 127.0.0.1), passwords never
// appear in errors, logs or toString(), command bodies are limited to 4096 bytes, every wait has a timeout.
const net = require('net');

const TYPE_RESPONSE = 0; const TYPE_EXEC = 2; const TYPE_AUTH_RESPONSE = 2; const TYPE_AUTH = 3;
const MAX_BODY = 4096;            // protocol limit for a packet body
const MAX_PACKET = MAX_BODY + 64; // sanity limit for what a server may send in one packet (Source uses 4096)
const MAX_RESPONSE = 1024 * 1024; // total text of one command response we are willing to collect
const DEFAULTS = { connectTimeoutMs: 4000, commandTimeoutMs: 8000, idleMs: 400 };

function packet(id, type, body) {
  const b = Buffer.from(String(body), 'utf8');
  if (b.length > MAX_BODY) throw new Error(`RCON payload too large (${b.length} bytes, limit ${MAX_BODY})`);
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8);
  b.copy(buf, 12); // two trailing zero bytes are already there
  return buf;
}

class RconClient {
  /**
   * @param {{host?:string, port:number, password:string, connectTimeoutMs?:number, commandTimeoutMs?:number, idleMs?:number}} o
   */
  constructor(o) {
    const port = Number(o && o.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid RCON port');
    Object.defineProperty(this, '_pw', { value: String(o.password == null ? '' : o.password), enumerable: false });
    this.host = o.host || '127.0.0.1'; this.port = port;
    this.opts = { ...DEFAULTS, ...Object.fromEntries(Object.entries(o).filter(([k]) => k in DEFAULTS)) };
    this.sock = null; this.buf = Buffer.alloc(0); this.nextId = 1; this.waiter = null; this.authed = false; this.closed = true;
  }
  toString() { return `RconClient(${this.host}:${this.port})`; }
  [Symbol.for('nodejs.util.inspect.custom')]() { return this.toString(); }

  get connected() { return !!this.sock && !this.closed && this.authed; }

  _fail(err) { if (this.waiter) { const w = this.waiter; this.waiter = null; w.reject(err); } }
  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 4) return;
      const size = this.buf.readInt32LE(0);
      if (size < 10 || size > MAX_PACKET) { const e = new Error('Invalid RCON packet from the server'); this.close(); this._fail(e); return; }
      if (this.buf.length < 4 + size) return;
      const id = this.buf.readInt32LE(4); const type = this.buf.readInt32LE(8);
      const body = this.buf.slice(12, 4 + size - 2).toString('utf8');
      this.buf = this.buf.slice(4 + size);
      if (this.waiter) this.waiter.onPacket({ id, type, body });
    }
  }

  /** Wait for packets with a handler; resolves with whatever handler.done() returns. */
  _wait(onPacket, timeoutMs, onTimeout) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiter = null; if (onTimeout) { try { resolve(onTimeout()); } catch (e) { reject(e); } } else reject(new Error('RCON timed out')); }, timeoutMs);
      this.waiter = {
        reject: (e) => { clearTimeout(t); reject(e); },
        onPacket: (p) => { const r = onPacket(p); if (r !== undefined) { clearTimeout(t); this.waiter = null; resolve(r.value); } },
      };
    });
  }

  connect() {
    if (this.connected) return Promise.resolve();
    this.close();
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      this.sock = sock; this.closed = false; this.authed = false; this.buf = Buffer.alloc(0);
      let settled = false;
      const done = (err) => { if (settled) return; settled = true; clearTimeout(timer); if (err) { this.close(); reject(err); } else resolve(); };
      const timer = setTimeout(() => done(new Error('RCON connection timed out')), this.opts.connectTimeoutMs);
      sock.setNoDelay(true);
      // events of a socket that was replaced meanwhile (close() + connect()) must not touch the new connection
      sock.on('data', (d) => { if (this.sock === sock) this._onData(d); });
      sock.on('error', (e) => { const m = new Error(`RCON connection failed: ${e.code || e.message}`); if (this.sock === sock) this._fail(m); done(m); });
      sock.on('close', () => { if (this.sock === sock) { this.closed = true; this.authed = false; this._fail(new Error('RCON connection closed')); } done(new Error('RCON connection closed')); });
      sock.on('connect', async () => {
        try {
          const id = this.nextId++;
          sock.write(packet(id, TYPE_AUTH, this._pw));
          // servers send an empty response-value packet first (Source) or only the auth response (Minecraft)
          const ok = await this._wait((p) => (p.type === TYPE_AUTH_RESPONSE ? { value: p.id !== -1 && p.id === id } : undefined), this.opts.commandTimeoutMs);
          if (!ok) throw new Error('RCON authentication failed (wrong password?)');
          this.authed = true; done();
        } catch (e) { done(e); }
      });
    });
  }

  /** Send one command; resolves with the collected response text (multi-packet responses are joined). */
  async send(command) {
    command = String(command);
    if (Buffer.byteLength(command, 'utf8') > MAX_BODY) throw new Error(`RCON command too long (limit ${MAX_BODY} bytes)`);
    await this.connect();
    const id = this.nextId++; const marker = this.nextId++;
    if (this.nextId > 0x7ffffff0) this.nextId = 1;
    const parts = []; let total = 0; let got = false;
    const sock = this.sock;
    // The end marker is an empty RESPONSE_VALUE request: Source servers answer it with an empty packet carrying the marker id,
    // Minecraft answers "Unknown request 0". Either way, a packet with the marker id means "the command output is complete".
    sock.write(packet(id, TYPE_EXEC, command));
    sock.write(packet(marker, TYPE_RESPONSE, ''));
    let idleTimer = null;
    try {
      return await new Promise((resolve, reject) => {
        const finish = () => { clearTimeout(idleTimer); this.waiter = null; clearTimeout(hard); resolve(parts.join('')); };
        const hard = setTimeout(() => { this.waiter = null; clearTimeout(idleTimer); if (got) resolve(parts.join('')); else reject(new Error('RCON command timed out')); }, this.opts.commandTimeoutMs);
        this.waiter = {
          reject: (e) => { clearTimeout(hard); clearTimeout(idleTimer); reject(e); },
          onPacket: (p) => {
            if (p.id === marker) return finish();
            if (p.id === id && p.type === TYPE_RESPONSE) {
              got = true; total += p.body.length; if (total <= MAX_RESPONSE) parts.push(p.body);
              clearTimeout(idleTimer); idleTimer = setTimeout(finish, Math.max(this.opts.idleMs, 100) * 4); // fallback when no end marker comes back
            }
          },
        };
      });
    } catch (e) { if (!this.connected) this.close(); throw e; }
  }

  close() {
    this.authed = false; this.closed = true;
    if (this.sock) { try { this.sock.destroy(); } catch { /* ignore */ } this.sock = null; }
  }
}

module.exports = { RconClient, packet, MAX_BODY, TYPE_AUTH, TYPE_EXEC, TYPE_RESPONSE, TYPE_AUTH_RESPONSE };
