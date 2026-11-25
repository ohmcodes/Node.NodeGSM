'use strict';
// Minimal streaming zip writer / reader (no dependencies): files are read, deflated and written chunk by chunk,
// so memory use does not depend on the size of the backup. Zip64 is used automatically for entries >= 2 GB,
// for archives past 4 GB and for more than 65535 entries (or always when forceZip64 is set, used by tests).
// Only the formats NodeGSM needs: stored / deflate, UTF-8 names, no encryption, no multi-disk.
const fs = require('fs');
const fsp = fs.promises;
const zlib = require('zlib');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const U32 = 0xFFFFFFFF; const U16 = 0xFFFF;

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
/** CRC-32 of buf continuing from prev (0 to start). */
function crc32(buf, prev = 0) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, prev);
  let c = (prev ^ U32) >>> 0;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ U32) >>> 0;
}

function dos(ms) {
  const d = new Date(ms || Date.now());
  const y = Math.max(1980, d.getFullYear());
  return [(d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()];
}
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

class ZipWriter {
  /** @param {string} file  @param {{zip64Threshold?:number, forceZip64?:boolean}} [opts] */
  constructor(file, opts = {}) {
    this.out = fs.createWriteStream(file);
    this.offset = 0; this.entries = [];
    this.z64At = opts.zip64Threshold != null ? opts.zip64Threshold : 2 ** 31;
    this.forceZip64 = !!opts.forceZip64;
    this.err = null;
    this.out.on('error', (e) => { this.err = e; });
  }

  write(buf) {
    if (this.err) return Promise.reject(this.err);
    this.offset += buf.length;
    return new Promise((res, rej) => {
      const bad = (e) => rej(e);
      this.out.once('error', bad);
      const ok = this.out.write(buf);
      if (ok) { this.out.removeListener('error', bad); res(); } else this.out.once('drain', () => { this.out.removeListener('error', bad); res(); });
    });
  }

  _local(name, mtime, z64, dir) {
    const nb = Buffer.from(name, 'utf8');
    const [t, d] = dos(mtime);
    const extra = z64 ? Buffer.concat([Buffer.from([1, 0, 16, 0]), Buffer.alloc(16)]) : Buffer.alloc(0);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(z64 ? 45 : 20, 4);
    h.writeUInt16LE(dir ? 0x0800 : 0x0808, 6); h.writeUInt16LE(dir ? 0 : 8, 8);
    h.writeUInt16LE(t, 10); h.writeUInt16LE(d, 12);
    h.writeUInt32LE(0, 14); h.writeUInt32LE(z64 ? U32 : 0, 18); h.writeUInt32LE(z64 ? U32 : 0, 22);
    h.writeUInt16LE(nb.length, 26); h.writeUInt16LE(extra.length, 28);
    return { buf: Buffer.concat([h, nb, extra]), nb, t, d };
  }

  async _descriptor(e) {
    if (e.z64) { const b = Buffer.alloc(24); b.writeUInt32LE(0x08074b50, 0); b.writeUInt32LE(e.crc, 4); u64(e.csize).copy(b, 8); u64(e.usize).copy(b, 16); await this.write(b); }
    else {
      if (e.csize >= U32 || e.usize >= U32) throw new Error(`File grew while it was being backed up: ${e.name}`);
      const b = Buffer.alloc(16); b.writeUInt32LE(0x08074b50, 0); b.writeUInt32LE(e.crc, 4); b.writeUInt32LE(e.csize, 8); b.writeUInt32LE(e.usize, 12); await this.write(b);
    }
  }

  /** Add a file from disk (streamed). Throws an error with .skippable = true when it cannot be opened (locked / vanished). */
  async addFile(name, abs, st) {
    let fh;
    try { fh = await fsp.open(abs, 'r'); } catch (e) { e.skippable = true; throw e; }
    try {
      const z64 = this.forceZip64 || st.size >= this.z64At;
      const l = this._local(name, st.mtimeMs, z64, false);
      const e = { name, nb: l.nb, t: l.t, d: l.d, method: 8, flags: 0x0808, z64, offset: this.offset, crc: 0, csize: 0, usize: 0, dir: false };
      await this.write(l.buf);
      let crc = 0; let usize = 0;
      const counter = new Transform({ transform(c, _e, cb) { crc = crc32(c, crc); usize += c.length; cb(null, c); } });
      const def = zlib.createDeflateRaw({ level: 6 });
      const rs = fh.createReadStream({ autoClose: false });
      pipeline(rs, counter, def).catch(() => { /* the error surfaces through the iterator below */ });
      for await (const chunk of def) { e.csize += chunk.length; await this.write(chunk); }
      e.crc = crc; e.usize = usize;
      await this._descriptor(e);
      this.entries.push(e);
      return e;
    } finally { await fh.close().catch(() => {}); }
  }

  /** Add an in-memory buffer. */
  async addBuffer(name, buf, mtime) {
    const data = zlib.deflateRawSync(buf);
    const l = this._local(name, mtime, false, false);
    const e = { name, nb: l.nb, t: l.t, d: l.d, method: 8, flags: 0x0808, z64: false, offset: this.offset, crc: crc32(buf), csize: data.length, usize: buf.length, dir: false };
    await this.write(l.buf); await this.write(data); await this._descriptor(e);
    this.entries.push(e);
  }

  /** Add an (empty) directory entry. */
  async addDir(name, mtime) {
    const n = name.endsWith('/') ? name : name + '/';
    const l = this._local(n, mtime, false, true);
    this.entries.push({ name: n, nb: l.nb, t: l.t, d: l.d, method: 0, flags: 0x0800, z64: false, offset: this.offset, crc: 0, csize: 0, usize: 0, dir: true });
    await this.write(l.buf);
  }

  _central(e) {
    const zs = e.z64 || e.csize >= U32 || e.usize >= U32;
    const zo = this.forceZip64 || e.offset >= U32;
    const parts = [];
    if (zs) parts.push(u64(e.usize), u64(e.csize));
    if (zo) parts.push(u64(e.offset));
    const extra = parts.length ? Buffer.concat([Buffer.from([1, 0, parts.length * 8, 0]), ...parts]) : Buffer.alloc(0);
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(zs || zo ? 45 : 20, 4); h.writeUInt16LE(zs || zo ? 45 : 20, 6);
    h.writeUInt16LE(e.flags, 8); h.writeUInt16LE(e.method, 10); h.writeUInt16LE(e.t, 12); h.writeUInt16LE(e.d, 14);
    h.writeUInt32LE(e.crc, 16); h.writeUInt32LE(zs ? U32 : e.csize, 20); h.writeUInt32LE(zs ? U32 : e.usize, 24);
    h.writeUInt16LE(e.nb.length, 28); h.writeUInt16LE(extra.length, 30);
    h.writeUInt32LE(e.dir ? 0x10 : 0, 38); h.writeUInt32LE(zo ? U32 : e.offset, 42);
    return Buffer.concat([h, e.nb, extra]);
  }

  /** Write the central directory and close the file. */
  async finish() {
    const cdStart = this.offset;
    let batch = [];
    let size = 0;
    for (const e of this.entries) { const b = this._central(e); batch.push(b); size += b.length; if (size > 1 << 20) { await this.write(Buffer.concat(batch)); batch = []; size = 0; } }
    if (batch.length) await this.write(Buffer.concat(batch));
    const cdSize = this.offset - cdStart; const n = this.entries.length;
    const big = this.forceZip64 || n >= U16 || cdStart >= U32 || cdSize >= U32;
    if (big) {
      const r = Buffer.alloc(56);
      r.writeUInt32LE(0x06064b50, 0); u64(44).copy(r, 4); r.writeUInt16LE(45, 12); r.writeUInt16LE(45, 14);
      u64(n).copy(r, 24); u64(n).copy(r, 32); u64(cdSize).copy(r, 40); u64(cdStart).copy(r, 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0); u64(this.offset).copy(loc, 8); loc.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([r, loc]));
    }
    const z = Buffer.alloc(22);
    z.writeUInt32LE(0x06054b50, 0);
    z.writeUInt16LE(big ? U16 : n, 8); z.writeUInt16LE(big ? U16 : n, 10);
    z.writeUInt32LE(big ? U32 : cdSize, 12); z.writeUInt32LE(big ? U32 : cdStart, 16);
    await this.write(z);
    await new Promise((res, rej) => { this.out.once('error', rej); this.out.end(res); });
  }

  /** Stop writing (the caller deletes the partial file). */
  abort() { try { this.out.destroy(); } catch { /* ignore */ } }
}

/** Open a zip for reading: parses the central directory only. */
async function openZip(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let i = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (i < 0 || i + 22 > tail.length) throw new Error('Not a zip file (no end-of-archive record)');
    let count = tail.readUInt16LE(i + 10); let cdSize = tail.readUInt32LE(i + 12); let cdOff = tail.readUInt32LE(i + 16);
    if (count === U16 || cdSize === U32 || cdOff === U32) {
      if (i < 20 || tail.readUInt32LE(i - 20) !== 0x07064b50) throw new Error('Corrupt zip64 locator');
      const rOff = Number(tail.readBigUInt64LE(i - 20 + 8));
      const r = Buffer.alloc(56); await fh.read(r, 0, 56, rOff);
      if (r.readUInt32LE(0) !== 0x06064b50) throw new Error('Corrupt zip64 end record');
      count = Number(r.readBigUInt64LE(32)); cdSize = Number(r.readBigUInt64LE(40)); cdOff = Number(r.readBigUInt64LE(48));
    }
    if (cdSize > 1 << 30) throw new Error('Zip directory is too large');
    const cd = Buffer.alloc(cdSize); await fh.read(cd, 0, cdSize, cdOff);
    const entries = [];
    let p = 0;
    for (let k = 0; k < count; k++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip directory');
      const flags = cd.readUInt16LE(p + 8); const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16); let csize = cd.readUInt32LE(p + 20); let usize = cd.readUInt32LE(p + 24);
      const nl = cd.readUInt16LE(p + 28); const el = cd.readUInt16LE(p + 30); const cl = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nl);
      let q = p + 46 + nl; const end = q + el;
      while (q + 4 <= end) {
        const id = cd.readUInt16LE(q); const len = cd.readUInt16LE(q + 2);
        if (id === 1) {
          let o = q + 4;
          if (usize === U32) { usize = Number(cd.readBigUInt64LE(o)); o += 8; }
          if (csize === U32) { csize = Number(cd.readBigUInt64LE(o)); o += 8; }
          if (offset === U32) { offset = Number(cd.readBigUInt64LE(o)); o += 8; }
        }
        q += 4 + len;
      }
      entries.push({ name, flags, method, crc, csize, usize, offset, dir: name.endsWith('/') });
      p = end + cl;
    }
    return { file, fh, entries, close: () => fh.close().catch(() => {}) };
  } catch (e) { await fh.close().catch(() => {}); throw e; }
}

/** Extract one entry to dest (through a temporary file; CRC and size are verified). */
async function extractEntry(zip, e, dest) {
  if (e.flags & 1) throw new Error(`Encrypted entries are not supported: ${e.name}`);
  if (e.method !== 0 && e.method !== 8) throw new Error(`Unsupported compression method ${e.method}: ${e.name}`);
  const lh = Buffer.alloc(30); await zip.fh.read(lh, 0, 30, e.offset);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`Corrupt zip entry: ${e.name}`);
  const start = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const tmp = dest + '.nodegsm-part';
  let crc = 0; let n = 0;
  const check = new Transform({ transform(c, _e, cb) { n += c.length; if (n > e.usize) return cb(new Error(`Entry is larger than declared: ${e.name}`)); crc = crc32(c, crc); cb(null, c); } });
  try {
    if (e.csize > 0) {
      const rs = fs.createReadStream(zip.file, { start, end: start + e.csize - 1 });
      await pipeline(...[rs, ...(e.method === 8 ? [zlib.createInflateRaw()] : []), check, fs.createWriteStream(tmp)]);
    } else await fsp.writeFile(tmp, '');
    if (n !== e.usize || (e.usize > 0 && crc !== e.crc)) throw new Error(`Corrupt zip entry (checksum mismatch): ${e.name}`);
    await fsp.rename(tmp, dest);
  } catch (err) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw err; }
}

module.exports = { ZipWriter, openZip, extractEntry, crc32 };
