'use strict';
// TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30 s) with Node's crypto only. Works with Google Authenticator, Authy, 1Password, Aegis ...
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(s) {
  const clean = String(s || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch); if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

/** The 6-digit code of `secret` (base32) for the 30 s step number `step`. */
function code(secret, step) {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
const stepOf = (ms = Date.now()) => Math.floor(ms / 30000);

/**
 * Check a user supplied code, allowing one step of clock drift each way.
 * lastStep: the last accepted step of this user (a code is never accepted twice). Returns the matched step or 0.
 */
function verify(secret, input, { now = Date.now(), lastStep = 0 } = {}) {
  const c = String(input || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return 0;
  const cur = stepOf(now); let hit = 0;
  for (const s of [cur - 1, cur, cur + 1]) {
    const ok = crypto.timingSafeEqual(Buffer.from(code(secret, s)), Buffer.from(c));
    if (ok && s > lastStep) hit = s;   // no early return: constant work
  }
  return hit;
}

/** otpauth:// URI for the authenticator app (shown as text and as a manual-entry key; no QR code library needed). */
const uri = (secret, account, issuer = 'NodeGSM') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

module.exports = { base32Encode, base32Decode, newSecret, code, stepOf, verify, uri };
