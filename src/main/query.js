'use strict';
// Server query protocols: A2S (Source/GoldSource), UT3/GameSpy4 (Minecraft), FiveM (HTTP)
const dgram = require('dgram');
const http = require('http');

function readCString(buf, o) {
  let e = buf.indexOf(0, o);
  if (e < 0) e = buf.length;
  return [buf.toString('utf8', o, e), e + 1];
}

async function a2s(host, port, timeout = 3000) {
  const base = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.from('Source Engine Query\0')]);
  const send = (extra) => new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const t = setTimeout(() => { try { sock.close(); } catch {} resolve(null); }, timeout);
    sock.on('error', () => { clearTimeout(t); resolve(null); });
    sock.on('message', (m) => { clearTimeout(t); try { sock.close(); } catch {} resolve(m); });
    sock.send(extra ? Buffer.concat([base, extra]) : base, port, host);
  });
  let res = await send();
  if (res && res[4] === 0x41) res = await send(res.slice(5, 9));
  if (!res || res.length < 6) return null;
  let o = 5;
  const type = res[4];
  try {
    if (type === 0x49) {
      o += 1; // protocol
      let name, map, folder, game;
      [name, o] = readCString(res, o); [map, o] = readCString(res, o);
      [folder, o] = readCString(res, o); [game, o] = readCString(res, o);
      o += 2; // app id
      return { name, map, game, players: res[o], maxPlayers: res[o + 1], bots: res[o + 2] };
    }
    if (type === 0x6d) {
      let addr, name, map, folder, game;
      [addr, o] = readCString(res, o); [name, o] = readCString(res, o); [map, o] = readCString(res, o);
      [folder, o] = readCString(res, o); [game, o] = readCString(res, o);
      return { name, map, game, players: res[o], maxPlayers: res[o + 1] };
    }
  } catch { /* fallthrough */ }
  return null;
}

// Minecraft: UT3 (GameSpy4) query. Server needs enable-query=true.
async function ut3(host, port, timeout = 3000) {
  const session = 0x01020304;
  const hs = Buffer.alloc(7);
  hs.writeUInt16BE(0xfefd, 0); hs[2] = 9; hs.writeInt32BE(session, 3);
  const ex = (buf) => new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const t = setTimeout(() => { try { sock.close(); } catch {} resolve(null); }, timeout);
    sock.on('error', () => { clearTimeout(t); resolve(null); });
    sock.on('message', (m) => { clearTimeout(t); try { sock.close(); } catch {} resolve(m); });
    sock.send(buf, port, host);
  });
  const r = await ex(hs);
  if (!r) return null;
  const token = parseInt(r.toString('ascii', 5).replace(/\0/g, ''), 10);
  const st = Buffer.alloc(11);
  st.writeUInt16BE(0xfefd, 0); st[2] = 0; st.writeInt32BE(session, 3); st.writeInt32BE(token, 7);
  const info = await ex(st);
  if (!info) return null;
  const parts = info.slice(5).toString('utf8').split('\0');
  const kv = {};
  for (let i = 0; i + 1 < parts.length && parts[i] !== ''; i += 2) kv[parts[i]] = parts[i + 1];
  if (!kv.hostname && !kv.numplayers) return null;
  return { name: kv.hostname, map: kv.map, players: +kv.numplayers, maxPlayers: +kv.maxplayers };
}

function fivem(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/info.json', timeout }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          const info = JSON.parse(d);
          http.get({ host, port, path: '/players.json', timeout }, (r2) => {
            let d2 = '';
            r2.on('data', (c) => (d2 += c));
            r2.on('end', () => {
              let n = 0; try { n = JSON.parse(d2).length; } catch {}
              resolve({ name: info.vars && info.vars.sv_projectName || 'FiveM', players: n, maxPlayers: +(info.vars && info.vars.sv_maxClients) || 0 });
            });
          }).on('error', () => resolve(null));
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function query(kind, host, port, timeout) {
  host = !host || host === '0.0.0.0' ? '127.0.0.1' : host;
  port = parseInt(port, 10);
  if (!port) return null;
  try {
    if (kind === 'a2s') return await a2s(host, port, timeout);
    if (kind === 'ut3') return await ut3(host, port, timeout);
    if (kind === 'fivem') return await fivem(host, port, timeout);
  } catch { /* ignore */ }
  return null;
}

module.exports = { query, a2s, ut3, fivem };
