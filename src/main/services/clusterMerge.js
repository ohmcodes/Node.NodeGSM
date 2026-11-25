'use strict';
// Config merge for cluster config sync (pure functions, no file access).
// The parent's file is the base; keys listed in `protect` (globs, case-insensitive) and lines containing "NGSM:ignore"
// (any comment style) keep the MEMBER's value. Formats: ini, properties, cfg, yaml (line aware), json (deep key paths),
// text / xml (whole file copy; only NGSM:ignore lines are kept).

const MARK = /NGSM:ignore/i;
const BOM = '﻿';

/** Glob list ("port", "rcon.*", "Server?Name") -> predicate over candidate key names. */
function keyGlobs(list) {
  const res = (list || []).map((g) => String(g).trim()).filter(Boolean)
    .map((g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'));
  return (cands) => res.length > 0 && res.some((r) => cands.some((c) => r.test(c)));
}

const splitLines = (t) => { const l = t.split(/\r?\n/); if (l.length && l[l.length - 1] === '') l.pop(); return l; };

// ---------- line parsers: line -> { id, cands, section? } | null (stateful per file) ----------
function iniParser() {
  let sec = '';
  return (line) => {
    const h = /^\s*\[([^\]]+)\]/.exec(line);
    if (h) { sec = h[1].trim(); return { header: true, section: sec, id: null, cands: [] }; }
    if (/^\s*[;#]/.test(line) || !line.trim()) return null;
    const k = /^\s*([^=\s;#[][^=]*?)\s*=/.exec(line);
    if (!k) return null;
    const key = k[1];
    return { id: `${sec.toLowerCase()}\u0000${key.toLowerCase()}`, name: sec ? `${sec}.${key}` : key, section: sec, cands: sec ? [`${sec}.${key}`, key] : [key] };
  };
}
function propsParser() {
  return (line) => {
    if (/^\s*[#!]/.test(line) || !line.trim()) return null;
    const k = /^\s*([^=:\s#!][^=:\s]*)\s*[=:]/.exec(line);
    return k ? { id: k[1].toLowerCase(), name: k[1], cands: [k[1]] } : null;
  };
}
function cfgParser() {
  return (line) => {
    if (/^\s*(\/\/|#|;)/.test(line) || !line.trim()) return null;
    const k = /^\s*([^\s=]+)/.exec(line);
    return k ? { id: k[1].toLowerCase(), name: k[1], cands: [k[1]] } : null;
  };
}
function yamlParser() {
  const stack = [];
  return (line) => {
    if (!line.trim() || /^\s*#/.test(line) || /^---/.test(line)) return null;
    const m = /^(\s*)(-\s+)?("[^"]+"|'[^']+'|[^\s:#'"-][^:#]*?)\s*:(\s|$)/.exec(line);
    if (!m) return null;
    const indent = m[1].length + (m[2] ? m[2].length : 0);
    const key = m[3].replace(/^["']|["']$/g, '');
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const p = [...stack.map((s) => s.key), key];
    stack.push({ indent, key });
    const cands = [p.join('.'), key]; for (let i = p.length - 1; i > 0; i--) cands.push(p.slice(0, i).join('.'));
    return { id: p.join('.').toLowerCase(), name: p.join('.'), cands };
  };
}
/** text / xml: identity of a line = its first token (or tag). Only used to find the member's counterpart of NGSM:ignore lines. */
function sigParser() {
  return (line) => {
    const t = line.replace(MARK, '').trim();
    if (!t) return null;
    const m = /^(<[^\s>/]+|[^\s=:]+)/.exec(t);
    return m ? { id: m[1].toLowerCase(), name: m[1], cands: [] } : null;
  };
}
const PARSERS = { ini: iniParser, properties: propsParser, cfg: cfgParser, yaml: yamlParser, text: sigParser, xml: sigParser };

/** Line merge for ini / properties / cfg / yaml / text / xml. */
function mergeLines(format, parentText, memberText, isProtected, warn) {
  const mk = PARSERS[format] || sigParser;
  const P = splitLines(parentText); const M = splitLines(memberText || '');
  const pp = mk(); const mp = mk();
  const parsedM = M.map((l) => mp(l));
  const memberIdx = new Map();   // id -> [line index]
  const headers = new Map();     // ini: section(lower) -> member header line
  parsedM.forEach((x, j) => {
    if (!x) return;
    if (x.header) { headers.set(x.section.toLowerCase(), M[j]); return; }
    if (!memberIdx.has(x.id)) memberIdx.set(x.id, []);
    memberIdx.get(x.id).push(j);
  });
  const used = new Set();
  const seen = new Map();        // parent occurrence counter per id
  const out = []; const secEnd = new Map([['', 0]]); let curSec = '';
  const isIni = format === 'ini';
  for (const line of P) {
    const x = pp(line);
    if (x && x.header) { curSec = x.section.toLowerCase(); out.push(line); secEnd.set(curSec, out.length); continue; }
    let push = line;
    if (x) {
      const n = seen.get(x.id) || 0; seen.set(x.id, n + 1);
      const j = (memberIdx.get(x.id) || [])[n];
      const keepP = MARK.test(line) || isProtected(x.cands);
      if (j !== undefined) {
        used.add(j);
        if (keepP || MARK.test(M[j])) push = M[j];
      } else if (keepP) warn(`${MARK.test(line) ? 'NGSM:ignore line' : 'protected key'} not present in member: ${x.name}`);
    }
    out.push(push);
    if (push.trim()) secEnd.set(curSec, out.length);
  }
  // member-only keys that are protected / marked are kept (never lose an RCON password just because the parent lacks the key)
  const inserts = new Map(); const tail = [];
  parsedM.forEach((x, j) => {
    if (!x || x.header || used.has(j)) return;
    if (!(MARK.test(M[j]) || isProtected(x.cands))) return;
    warn(`kept member-only line: ${x.name}`);
    const sec = isIni ? (x.section || '').toLowerCase() : '';
    if (isIni && secEnd.has(sec)) { if (!inserts.has(sec)) inserts.set(sec, []); inserts.get(sec).push(M[j]); }
    else if (isIni) { if (!tail.some((t) => t.sec === sec)) tail.push({ sec, header: headers.get(sec), lines: [] }); tail.find((t) => t.sec === sec).lines.push(M[j]); }
    else tail.push({ sec: '', lines: [M[j]] });
  });
  for (const [sec, lines] of [...inserts].sort((a, b) => secEnd.get(b[0]) - secEnd.get(a[0]))) out.splice(secEnd.get(sec), 0, ...lines);
  for (const t of tail) { if (t.header) out.push(t.header); out.push(...t.lines); }
  return out;
}

// ---------- json ----------
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function jsonPaths(obj, prefix, out) {
  if (!isObj(obj)) return;
  for (const k of Object.keys(obj)) { const p = [...prefix, k]; out.set(p.join('\u0001'), p); jsonPaths(obj[k], p, out); }
}
const jget = (o, p) => { let c = o; for (const k of p) { if (!isObj(c) || !(k in c)) return { has: false }; c = c[k]; } return { has: true, v: c }; };
function jset(o, p, v) { let c = o; for (let i = 0; i < p.length - 1; i++) { if (!isObj(c[p[i]])) c[p[i]] = {}; c = c[p[i]]; } c[p[p.length - 1]] = v; }

function mergeJson(parentText, memberText, isProtected, warn) {
  let p; let m = {};
  try { p = JSON.parse(parentText); } catch (e) { throw new Error(`The parent file is not valid JSON: ${e.message}`); }
  if (memberText && memberText.trim()) { try { m = JSON.parse(memberText); } catch (e) { throw new Error(`The member file is not valid JSON (fix or delete it first): ${e.message}`); } }
  if (!isObj(p)) return { text: parentText, parsed: true };
  const result = JSON.parse(JSON.stringify(p));
  const all = new Map(); jsonPaths(p, [], all); if (isObj(m)) jsonPaths(m, [], all);
  const handled = [];
  for (const [, path] of [...all].sort((a, b) => a[1].length - b[1].length)) {
    if (handled.some((h) => h.length < path.length && h.every((k, i) => k === path[i]))) continue;
    if (!isProtected([path.join('.'), path[path.length - 1]])) continue;
    handled.push(path);
    const mv = jget(m, path);
    if (mv.has) jset(result, path, JSON.parse(JSON.stringify(mv.v)));
    else if (jget(p, path).has) warn(`protected key not present in member: ${path.join('.')}`);
  }
  return { obj: result, memberObj: m };
}

/**
 * Merge a parent config over a member config.
 * @param {{format:string, parentText:string, memberText:(string|null), protect:string[]}} a  memberText null = the member has no file
 * @returns {{text:string, warnings:string[]}}
 */
function mergeConfig({ format, parentText, memberText, protect }) {
  const warnings = []; const warn = (m) => { if (!warnings.includes(m)) warnings.push(m); };
  const strip = (t) => (t == null ? null : String(t).replace(/^﻿/, ''));
  const memberBom = typeof memberText === 'string' && memberText.startsWith(BOM);
  const pt = strip(parentText); const mt = strip(memberText);
  const isProtected = keyGlobs(protect);
  const eol = (mt != null && mt.includes('\r\n')) || (mt == null && pt.includes('\r\n')) ? '\r\n' : '\n';
  const trailing = /\n$/.test(mt == null || mt === '' ? pt : mt);
  let text;
  if (format === 'json') {
    const r = mergeJson(pt, mt, isProtected, warn);
    if (r.text !== undefined) text = r.text;
    else if (r.memberObj && JSON.stringify(r.memberObj) === JSON.stringify(r.obj)) text = mt;
    else text = JSON.stringify(r.obj, null, 2) + eol;
  } else {
    if ((format === 'text' || format === 'xml' || !PARSERS[format]) && !MARK.test(pt) && !(mt && MARK.test(mt)))
      warn('Plain text file: nothing in it can be protected (no NGSM:ignore lines), the whole file is replaced by the parent\'s copy');
    const lines = mergeLines(PARSERS[format] ? format : 'text', pt, mt, isProtected, warn);
    text = lines.join(eol) + (trailing && lines.length ? eol : '');
  }
  return { text: (memberBom ? BOM : '') + text, warnings };
}

// ---------- simple unified-style diff ----------
function diffOps(a, b) {
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length; let eb = b.length; while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea); const B = b.slice(s, eb); const ops = [];
  for (let i = 0; i < s; i++) ops.push([' ', a[i]]);
  if (A.length * B.length <= 2500000) {
    const w = B.length + 1; const L = new Uint32Array((A.length + 1) * w);
    for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0; let j = 0;
    while (i < A.length && j < B.length) {
      if (A[i] === B[j]) { ops.push([' ', A[i]]); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) ops.push(['-', A[i++]]);
      else ops.push(['+', B[j++]]);
    }
    while (i < A.length) ops.push(['-', A[i++]]);
    while (j < B.length) ops.push(['+', B[j++]]);
  } else { A.forEach((x) => ops.push(['-', x])); B.forEach((x) => ops.push(['+', x])); }
  for (let i = ea; i < a.length; i++) ops.push([' ', a[i]]);
  return ops;
}

/** @returns {{text:string, added:number, removed:number}} text is '' when nothing differs */
function unifiedDiff(oldText, newText, { context = 3, maxLines = 400 } = {}) {
  const a = splitLines((oldText || '').replace(/^﻿/, '')); const b = splitLines((newText || '').replace(/^﻿/, ''));
  const ops = diffOps(a, b);
  const added = ops.filter((o) => o[0] === '+').length; const removed = ops.filter((o) => o[0] === '-').length;
  if (!added && !removed) return { text: '', added: 0, removed: 0 };
  const lines = []; const n = ops.length; let i = 0;
  // old/new line numbers at each op
  const on = []; const nn = []; let o = 1; let q = 1;
  for (const op of ops) { on.push(o); nn.push(q); if (op[0] !== '+') o++; if (op[0] !== '-') q++; }
  while (i < n) {
    if (ops[i][0] === ' ') { i++; continue; }
    const start = Math.max(0, i - context); let end = i; let last = i;
    while (end < n && end - last <= 2 * context + 1) { if (ops[end][0] !== ' ') last = end; end++; }
    end = Math.min(n, last + context + 1);
    const hunk = ops.slice(start, end);
    const oc = hunk.filter((x) => x[0] !== '+').length; const nc = hunk.filter((x) => x[0] !== '-').length;
    lines.push(`@@ -${on[start]},${oc} +${nn[start]},${nc} @@`);
    for (const x of hunk) lines.push(x[0] + x[1]);
    i = end;
  }
  let text = lines.join('\n');
  if (lines.length > maxLines) text = lines.slice(0, maxLines).join('\n') + `\n... (diff truncated, ${lines.length - maxLines} more lines)`;
  return { text, added, removed };
}

module.exports = { mergeConfig, unifiedDiff, keyGlobs, MARK };
