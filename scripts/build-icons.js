'use strict';
// Draws the NodeGSM logo procedurally (rounded rects, capsules, circles; anti-aliased with signed distances)
// and writes PNGs (zlib) + a multi-size ICO. Zero dependencies. The geometry mirrors assets/logo.svg and
// assets/icon.svg (256 x 256 units) - change them together.
//   node scripts/build-icons.js        (npm run icons)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const ACCENT = [0x4f, 0x8c, 0xff];   // the app's default --accent
const NODE = [0xdb, 0xe7, 0xff];
const TILE = [0x1c, 0x1f, 0x27];
const EDGE = [0x2e, 0x33, 0x40];

// signed distances (negative inside), in logo units
const sdRRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - (hw - r), qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdCapsule = (x, y, ax, ay, bx, by, r) => {
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
};
const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;

// shapes in paint order
function shapes({ tile, simple }) {
  const s = [];
  if (tile) {
    s.push({ sd: (x, y) => sdRRect(x, y, 128, 128, 120, 120, 52), color: EDGE });
    s.push({ sd: (x, y) => sdRRect(x, y, 128, 128, 118, 118, 50), color: TILE });
  }
  const M = tile ? 1.2 : 1; // in the tile the mark is enlarged around the centre (icon.svg uses the same transform)
  const mk = (f) => (x, y) => f((x - 128) / M + 128, (y - 128) / M + 128) * M;
  for (const cx of [82, 174]) {
    if (simple) s.push({ sd: mk((x, y) => sdRRect(x, y, cx, 128, 15, 57, 11)), color: ACCENT }); // small sizes: solid stems (gaps would blur away)
    else for (const y0 of [71, 112, 153]) s.push({ sd: mk((x, y) => sdRRect(x, y, cx, y0 + 16, 15, 16, 9)), color: ACCENT });
  }
  s.push({ sd: mk((x, y) => sdCapsule(x, y, 82, 87, 174, 169, simple ? 11 : 8)), color: ACCENT });
  s.push({ sd: mk((x, y) => sdCircle(x, y, 82, 87, simple ? 8 : 10)), color: NODE });
  s.push({ sd: mk((x, y) => sdCircle(x, y, 174, 169, simple ? 8 : 10)), color: NODE });
  return s;
}

// RGBA (straight alpha). Mark-only images are scaled up so the mark fills more of the canvas.
function render(size, { tile = true, simple = size <= 32, fill = tile ? 1 : 1.3 } = {}) {
  const list = shapes({ tile, simple });
  const buf = Buffer.alloc(size * size * 4);
  const pxUnits = 256 / size / fill; // logo units per pixel
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = ((px + 0.5) * 256 / size - 128) / fill + 128;
      const y = ((py + 0.5) * 256 / size - 128) / fill + 128;
      let r = 0, g = 0, b = 0, a = 0;
      for (const sh of list) {
        const cov = Math.max(0, Math.min(1, 0.5 - sh.sd(x, y) / pxUnits)); // 1 px edge ramp
        if (cov <= 0) continue;
        const na = cov + a * (1 - cov);
        r = (sh.color[0] * cov + r * a * (1 - cov)) / na; g = (sh.color[1] * cov + g * a * (1 - cov)) / na; b = (sh.color[2] * cov + b * a * (1 - cov)) / na;
        a = na;
      }
      const o = (py * size + px) * 4;
      if (a > 0) { buf[o] = Math.round(r); buf[o + 1] = Math.round(g); buf[o + 2] = Math.round(b); buf[o + 3] = Math.round(a * 255); }
    }
  }
  return buf;
}

// PNG
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ICO with PNG-compressed entries: [{ size, data }]
function ico(entries) {
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size; dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6); dir.writeUInt32LE(e.data.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  return Buffer.concat([head, dir, ...entries.map((e) => e.data)]);
}

function write(rel, data) { const f = path.join(ROOT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return rel; }
const tilePng = (s) => png(s, render(s, { tile: true }));

function main() {
  const out = [];
  out.push(write('assets/icon.png', tilePng(256)));
  out.push(write('assets/icon-32.png', tilePng(32)));
  out.push(write('assets/icon-16.png', tilePng(16)));
  out.push(write('build/icon.ico', ico([16, 32, 48, 64, 128, 256].map((size) => ({ size, data: tilePng(size) })))));
  console.log('icons written:\n  ' + out.join('\n  '));
}

module.exports = { render, png, ico, crc32 };
if (require.main === module) main();
