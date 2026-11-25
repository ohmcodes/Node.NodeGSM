'use strict';
// Structured (key / value) config editing, pure functions without file access.
//   parse(format, text)          -> { ok, reason?, entries[] }   entries: { id, path, key, section, value, type? }
//   edit(format, text, ops)      -> { text, entries }            ops: set / add / remove
//   get(format, text, name)      -> string | undefined           look a value up by key or path (used for RCON sources)
// Formats: ini, properties, cfg (Source "key value"), json (dotted paths), yaml (simple "key: value" subset).
// Line formats keep every comment, blank line and unknown line; only the edited line changes. JSON is re-serialised
// (2 spaces or the file's own indentation); comments cannot exist in JSON. Anything that cannot be parsed safely
// returns { ok: false } so the UI falls back to the raw editor.

const FORMATS = ['ini', 'properties', 'cfg', 'json', 'yaml'];
const MAX_ENTRIES = 5000;
const BOM = '﻿';

const splitText = (text) => {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const trailing = lines.length > 1 && lines[lines.length - 1] === '';
  if (trailing) lines.pop();
  if (text === '') return { eol, lines: [], trailing: false };
  return { eol, lines, trailing };
};
const joinText = (p) => p.lines.join(p.eol) + (p.trailing && p.lines.length ? p.eol : '');
const stripBom = (t) => String(t == null ? '' : t).replace(/^﻿/, '');

// ---------- line classifiers: line -> { key, section, prefix, value } | { header } | null ----------
function iniLines(lines) {
  const out = []; let sec = '';
  lines.forEach((line, i) => {
    const h = /^\s*\[([^\]]*)\]\s*$/.exec(line);
    if (h) { sec = h[1].trim(); out.push({ i, header: true, section: sec }); return; }
    if (!line.trim() || /^\s*[;#]/.test(line)) return;
    const m = /^(\s*([^=\s;#[][^=]*?)\s*=\s*)(.*)$/.exec(line);
    if (m) out.push({ i, key: m[2], section: sec, prefix: m[1], value: m[3].replace(/\s+$/, '') });
  });
  return out;
}
function propsLines(lines) {
  const out = [];
  lines.forEach((line, i) => {
    if (!line.trim() || /^\s*[#!]/.test(line)) return;
    const m = /^(\s*([^=:\s#!][^=:\s]*)\s*[=:]\s*)(.*)$/.exec(line);
    if (m) out.push({ i, key: m[2], section: '', prefix: m[1], value: m[3].replace(/\s+$/, '') });
  });
  return out;
}
function cfgLines(lines) {
  const out = [];
  lines.forEach((line, i) => {
    if (!line.trim() || /^\s*(\/\/|#|;)/.test(line)) return;
    const m = /^(\s*([^\s=]+)(?:\s+|\s*=\s*))(.*)$/.exec(line);
    if (m) out.push({ i, key: m[2], section: '', prefix: m[1], value: m[3].replace(/\s+$/, '') });
    else { const k = /^\s*([^\s=]+)\s*$/.exec(line); if (k) out.push({ i, key: k[1], section: '', prefix: line.replace(/\s+$/, '') + ' ', value: '' }); }
  });
  return out;
}

/** yaml subset: nested mappings with space indentation, scalar values; lists, block scalars and tabs make it "raw only". */
function yamlLines(lines) {
  const out = []; const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\t/.test(/^\s*/.exec(line)[0])) return { ok: false, reason: 'YAML with tab indentation' };
    if (!line.trim() || /^\s*#/.test(line) || /^(---|\.\.\.)\s*$/.test(line)) continue;
    const m = /^(\s*)(?:(-\s+))?("[^"]+"|'[^']+'|[^\s:#'"{[\]-][^:#]*?|-[^\s:][^:#]*?)\s*:(\s+|$)(.*)$/.exec(line);
    if (!m) {
      if (/^\s*-(\s|$)/.test(line)) continue;       // list item of scalars: kept, not editable
      if (/^\s+\S/.test(line) && out.length && out[out.length - 1].blockScalar) continue;
      return { ok: false, reason: 'YAML with constructs the structured editor does not support' };
    }
    if (m[2]) continue;                               // "- key: value" (list of maps): kept, not editable
    const indent = m[1].length; const key = m[3].replace(/^["']|["']$/g, '');
    let rest = m[5];
    if (/^[|>][+-]?\d*\s*(#.*)?$/.test(rest)) {       // block scalar: skip its body, not editable
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      let j = i + 1; while (j < lines.length && (!lines[j].trim() || /^\s/.test(lines[j]) && /^\s*/.exec(lines[j])[0].length > indent)) j++;
      i = j - 1; continue;
    }
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const path = [...stack.map((s) => s.key), key];
    if (rest.replace(/\s*#.*$/, '').trim() === '') { stack.push({ indent, key }); continue; }   // parent mapping
    if (/^[&*!]/.test(rest)) { continue; }            // anchors / aliases / tags: kept, not editable
    // value ends before an unquoted " #" comment
    let value = rest; let comment = '';
    if (/^"/.test(rest)) { const q = /^"(?:[^"\\]|\\.)*"/.exec(rest); if (q) { value = q[0]; comment = rest.slice(q[0].length); } }
    else if (/^'/.test(rest)) { const q = /^'(?:[^']|'')*'/.exec(rest); if (q) { value = q[0]; comment = rest.slice(q[0].length); } }
    else { const c = /\s+#.*$/.exec(rest); if (c) { value = rest.slice(0, c.index); comment = c[0]; } }
    const prefix = line.slice(0, line.length - rest.length);
    out.push({ i, key, path, section: path.slice(0, -1).join('.'), prefix, value: value.replace(/\s+$/, ''), comment, indent });
  }
  return { ok: true, items: out };
}

function lineItems(format, lines) {
  if (format === 'ini') return { ok: true, items: iniLines(lines) };
  if (format === 'properties') return { ok: true, items: propsLines(lines) };
  if (format === 'cfg') return { ok: true, items: cfgLines(lines) };
  if (format === 'yaml') return yamlLines(lines);
  return { ok: false, reason: `Unsupported format: ${format}` };
}

const displayPath = (format, it) => (format === 'ini' ? (it.section ? `${it.section}.${it.key}` : it.key) : format === 'yaml' ? it.path.join('.') : it.key);

// ---------- json ----------
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function jsonLeaves(v, path, out) {
  if (isObj(v)) { const k = Object.keys(v); if (!k.length) { out.push({ path, value: v }); return; } for (const x of k) jsonLeaves(v[x], [...path, x], out); }
  else if (Array.isArray(v)) { if (!v.length || v.every((x) => x === null || typeof x !== 'object')) { out.push({ path, value: v }); return; } v.forEach((x, i) => jsonLeaves(x, [...path, String(i)], out)); }
  else out.push({ path, value: v });
}
const jtype = (v) => (v === null ? 'null' : Array.isArray(v) ? 'json' : isObj(v) ? 'json' : typeof v);
const jshow = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
function jsonIndent(text) { const m = /^(\s+)"/m.exec(text.replace(/^\{/, '{')); return m ? (m[1].includes('\t') ? '\t' : m[1].length) : 2; }

function parseJson(text) {
  let v; try { v = JSON.parse(text); } catch (e) { return { ok: false, reason: `Not valid JSON: ${e.message}` }; }
  if (!isObj(v)) return { ok: false, reason: 'The JSON root is not an object (list files are edited as raw text)' };
  const leaves = []; jsonLeaves(v, [], leaves);
  const entries = leaves.slice(0, MAX_ENTRIES).map((l) => ({ id: JSON.stringify(l.path), path: l.path.join('.'), key: l.path[l.path.length - 1], section: l.path.slice(0, -1).join('.'), value: jshow(l.value), type: jtype(l.value) }));
  return { ok: true, entries, root: v, truncated: leaves.length > MAX_ENTRIES };
}

/** Text typed by the user -> JSON value; keeps the old type (number stays number when it parses). */
function coerce(text, oldType) {
  const t = String(text);
  if (oldType === 'number') { const n = Number(t); return t.trim() !== '' && Number.isFinite(n) ? n : t; }
  if (oldType === 'boolean') return /^true$/i.test(t.trim()) ? true : /^false$/i.test(t.trim()) ? false : t;
  if (oldType === 'null') return t.trim() === '' || t.trim() === 'null' ? null : guess(t);
  if (oldType === 'json') { try { return JSON.parse(t); } catch { return t; } }
  if (oldType === 'string') return t;
  return guess(t);
}
function guess(t) {
  const s = t.trim();
  if (s === 'true') return true; if (s === 'false') return false; if (s === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(s) && Number.isFinite(Number(s)) && String(Number(s)) === s) return Number(s);
  if (/^[{[]/.test(s)) { try { return JSON.parse(s); } catch { /* plain text */ } }
  return t;
}
const getAt = (o, p) => { let c = o; for (const k of p) { if (c === null || typeof c !== 'object' || !(k in c)) return undefined; c = c[k]; } return c; };
function setAt(o, p, v, create) {
  let c = o;
  for (let i = 0; i < p.length - 1; i++) {
    if (c[p[i]] === null || typeof c[p[i]] !== 'object') { if (!create) throw new Error(`Path not found: ${p.join('.')}`); c[p[i]] = {}; }
    c = c[p[i]];
  }
  c[p[p.length - 1]] = v;
}

function editJson(text, ops) {
  const bom = text.startsWith(BOM); const body = stripBom(text);
  const r = parseJson(body); if (!r.ok) throw new Error(r.reason);
  const eol = /\r\n/.test(body) ? '\r\n' : '\n'; const ind = jsonIndent(body); const trailing = /\n\s*$/.test(body);
  const root = JSON.parse(body);
  for (const op of ops) {
    if (op.op === 'set') {
      const p = JSON.parse(op.id); const old = getAt(root, p);
      setAt(root, p, coerce(op.value, jtype(old)), false);
    } else if (op.op === 'add') {
      const p = String(op.path || '').split('.').map((x) => x.trim());
      if (!p.length || p.some((x) => !x) || p.some((x) => x === '__proto__' || x === 'constructor' || x === 'prototype')) throw new Error('Invalid key path');
      if (getAt(root, p) !== undefined) throw new Error(`Key already exists: ${p.join('.')}`);
      setAt(root, p, guess(String(op.value == null ? '' : op.value)), true);
    } else if (op.op === 'remove') {
      const p = JSON.parse(op.id); const parent = p.length > 1 ? getAt(root, p.slice(0, -1)) : root;
      if (Array.isArray(parent)) parent.splice(Number(p[p.length - 1]), 1); else if (isObj(parent)) delete parent[p[p.length - 1]];
    } else throw new Error(`Unknown operation: ${op.op}`);
  }
  let out = JSON.stringify(root, null, ind);
  if (eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  return (bom ? BOM : '') + out + (trailing ? eol : '');
}

// ---------- public API ----------
function parse(format, text) {
  format = String(format || '').toLowerCase();
  if (!FORMATS.includes(format)) return { ok: false, reason: 'This file format is edited as raw text', entries: [] };
  const body = stripBom(text);
  if (format === 'json') { const r = parseJson(body); return r.ok ? { ok: true, entries: r.entries, truncated: r.truncated } : { ok: false, reason: r.reason, entries: [] }; }
  const p = splitText(body);
  const r = lineItems(format, p.lines);
  if (!r.ok) return { ok: false, reason: r.reason, entries: [] };
  const entries = r.items.filter((x) => !x.header).slice(0, MAX_ENTRIES).map((x) => ({
    id: String(x.i), path: displayPath(format, x), key: x.key, section: x.section || '', value: x.value,
  }));
  // a plain file with content but no recognisable keys is still fine (empty list), but pure garbage is not detectable; that is ok
  return { ok: true, entries, truncated: r.items.length > MAX_ENTRIES };
}

const cleanKey = (format, k) => {
  k = String(k == null ? '' : k).trim();
  if (!k || /[\r\n]/.test(k)) throw new Error('Invalid key');
  if (format === 'ini' && /[=;#[\]]/.test(k)) throw new Error('Invalid key');
  if (format === 'properties' && /[=:\s#!]/.test(k)) throw new Error('Invalid key');
  if (format === 'cfg' && /[\s=]/.test(k)) throw new Error('Invalid key');
  return k;
};
const cleanValue = (v) => { v = String(v == null ? '' : v); if (/[\r\n]/.test(v)) throw new Error('A value cannot contain line breaks (use the raw editor)'); return v; };

function editLines(format, text, ops) {
  const bom = text.startsWith(BOM); const p = splitText(stripBom(text));
  for (const op of ops) {
    const r = lineItems(format, p.lines); if (!r.ok) throw new Error(r.reason);
    const byLine = new Map(r.items.filter((x) => !x.header).map((x) => [String(x.i), x]));
    if (op.op === 'set') {
      const it = byLine.get(String(op.id)); if (!it) throw new Error('That line no longer exists, reload the file');
      p.lines[it.i] = it.prefix + cleanValue(op.value) + (it.comment || '');
    } else if (op.op === 'remove') {
      const it = byLine.get(String(op.id)); if (!it) throw new Error('That line no longer exists, reload the file');
      p.lines.splice(it.i, 1);
    } else if (op.op === 'add') {
      addLine(format, p, r.items, op);
    } else throw new Error(`Unknown operation: ${op.op}`);
  }
  if (p.lines.length && !p.trailing && /\n$/.test(text)) p.trailing = true;
  return (bom ? BOM : '') + joinText(p);
}

function addLine(format, p, items, op) {
  const value = cleanValue(op.value);
  if (format === 'yaml') {
    const path = String(op.path || '').split('.').map((x) => x.trim());
    if (!path.length || path.some((x) => !x || /[:#\n]/.test(x))) throw new Error('Invalid key path');
    if (items.some((x) => !x.header && x.path.join('.').toLowerCase() === path.join('.').toLowerCase())) throw new Error(`Key already exists: ${path.join('.')}`);
    // find the deepest existing parent line by scanning the raw lines for "parent:" with no value
    const lines = p.lines; let at = lines.length; let indent = 0; let depth = 0;
    const stack = [];
    for (let i = 0; i < lines.length && depth < path.length - 1; i++) {
      const m = /^(\s*)([^\s:#-][^:#]*?)\s*:\s*(#.*)?$/.exec(lines[i]); if (!m) continue;
      const ind = m[1].length;
      while (stack.length && stack[stack.length - 1].indent >= ind) stack.pop();
      stack.push({ indent: ind, key: m[2], i });
      if (stack.length === depth + 1 && stack.map((s) => s.key.toLowerCase()).join('.') === path.slice(0, depth + 1).join('.').toLowerCase()) {
        depth++; indent = ind + 2;
        let j = i + 1; while (j < lines.length && (!lines[j].trim() || /^\s*/.exec(lines[j])[0].length > ind)) j++;
        while (j > i + 1 && !lines[j - 1].trim()) j--;
        at = j;
        const child = lines.slice(i + 1, j).find((l) => l.trim() && !/^\s*#/.test(l)); if (child) indent = /^\s*/.exec(child)[0].length;
      }
    }
    const out = [];
    for (let d = depth; d < path.length - 1; d++) { out.push(`${' '.repeat(indent)}${path[d]}:`); indent += 2; }
    out.push(`${' '.repeat(indent)}${path[path.length - 1]}: ${value}`);
    if (depth === 0) at = lines.length;
    lines.splice(at, 0, ...out);
    return;
  }
  const key = cleanKey(format, op.path);
  const section = format === 'ini' ? String(op.section == null ? '' : op.section).trim() : '';
  if (/[\]\r\n]/.test(section)) throw new Error('Invalid section name');
  if (items.some((x) => !x.header && x.key.toLowerCase() === key.toLowerCase() && (x.section || '').toLowerCase() === section.toLowerCase())) throw new Error(`Key already exists: ${section ? section + '.' : ''}${key}`);
  const newLine = format === 'cfg' ? `${key} ${value}` : format === 'properties' ? `${key}=${value}` : `${key}=${value}`;
  const lines = p.lines;
  if (format !== 'ini') { lines.push(newLine); return; }
  const header = items.find((x) => x.header && x.section.toLowerCase() === section.toLowerCase());
  const inSec = items.filter((x) => !x.header && (x.section || '').toLowerCase() === section.toLowerCase());
  if (!section) {
    if (inSec.length) { lines.splice(inSec[inSec.length - 1].i + 1, 0, newLine); return; }
    const first = items.find((x) => x.header);
    let end = first ? first.i : lines.length;
    while (end > 0 && !lines[end - 1].trim()) end--;
    lines.splice(end, 0, newLine); return;
  }
  if (!header) { if (lines.length && lines[lines.length - 1].trim()) lines.push(''); lines.push(`[${section}]`, newLine); return; }
  if (inSec.length) { lines.splice(inSec[inSec.length - 1].i + 1, 0, newLine); return; }   // after the last key of the section
  lines.splice(header.i + 1, 0, newLine);                                                  // empty section
}

/** Apply ops: [{ op:'set', id, value } | { op:'add', path, value, section? } | { op:'remove', id }]. Returns the new text and entries. */
function edit(format, text, ops) {
  format = String(format || '').toLowerCase();
  if (!FORMATS.includes(format)) throw new Error('This file format is edited as raw text');
  if (!Array.isArray(ops) || ops.length > 200) throw new Error('Invalid edit list');
  text = String(text == null ? '' : text);
  const out = format === 'json' ? editJson(text, ops) : editLines(format, text, ops);
  const r = parse(format, out);
  return { text: out, entries: r.entries, ok: r.ok };
}

/** Look a value up by key or display path (case-insensitive). Used to read RCON ports / passwords from config files. */
function get(format, text, name) {
  const r = parse(format, text); if (!r.ok) return undefined;
  const n = String(name).toLowerCase();
  const hit = r.entries.find((e) => e.path.toLowerCase() === n) || r.entries.find((e) => e.key.toLowerCase() === n);
  if (!hit) return undefined;
  let v = hit.value;
  if (format === 'cfg' || format === 'yaml') v = v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  return v;
}

module.exports = { FORMATS, parse, edit, get };
