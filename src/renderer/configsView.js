'use strict';
// Server configs: the plugin's configs[] of the selected server, edited raw or as key / value pairs.
// Used by the server's "Config Files" tab and by the Configs screen (Home > Configs).
// Uses the globals of app.js / dashboard.js (run, esc, $, toast, state, viewHooks, setView, select).
// The text in the raw editor is always the single source of truth: structured edits go through the main process
// (configEdit IPC, comments and unknown lines are kept) and the result is written back into the text.

const cfgPref = { mode: 'structured' };          // remembered for the session
const CFG_MAX_ROWS = 400;

/**
 * Mount the editor into `root` for server `s`. Returns { dirty() } so the caller can guard navigation.
 * Nothing is opened automatically when the game has several config files: the user picks one (a single file opens at once).
 */
async function mountConfigs(root, s) {
  const list = (await run('configList', s.id)) || [];
  if (!list.length) { root.innerHTML = '<p class="muted">This game plugin does not declare config files. Use the <b>Files</b> tab, or ask the plugin author to add a <code>configs</code> list.</p>'; return { dirty: () => false }; }
  root.innerHTML = `<div class="split cfg-split"><div class="tree cfg-list">${list.map((c) => `<div data-c="${esc(c.id)}"><b>${esc(c.name)}</b> <span class="badge">${esc(c.format)}</span><br><span class="muted small">${esc(c.path)}${c.exists ? '' : ' - missing'}</span></div>`).join('')}</div>
    <div class="view cfg-view"><div class="cfg-head muted">${list.length > 1 ? 'Pick a config file on the left.' : ''}</div>
    <div class="row cfg-bar" hidden>
      <div class="seg cfg-mode"><button type="button" data-m="structured">Structured</button><button type="button" data-m="raw">Raw</button></div>
      <button type="button" class="cfg-save primary" disabled>Save</button><button type="button" class="cfg-reload" disabled>Reload</button>
      <button type="button" class="cfg-fmt" hidden>Format JSON</button><button type="button" class="cfg-create" hidden>Create file</button><span class="cfg-status muted"></span>
    </div>
    <div class="cfg-struct" hidden>
      <div class="row"><input class="cfg-search" placeholder="Search keys and values..." autocomplete="off"><span class="cfg-count muted small"></span></div>
      <div class="cfg-rows"></div>
      <div class="cfg-addrow row"><input class="cfg-addsec" placeholder="[Section]" title="Section (ini files, blank = top of the file)" hidden><input class="cfg-addkey" placeholder="New key (a.b.c for nested json / yaml)"><input class="cfg-addval" placeholder="Value"><button type="button" class="cfg-add">Add</button></div>
      <p class="muted small cfg-note"></p>
    </div>
    <textarea class="cfg-ed" spellcheck="false" disabled hidden></textarea></div></div>`;
  const q = (sel) => root.querySelector(sel);
  const ed = q('.cfg-ed'); let cur = null; let dirty = false; let mode = 'raw'; let parsed = { ok: false, entries: [] };
  const status = (t, bad) => { const e = q('.cfg-status'); e.textContent = t; e.style.color = bad ? 'var(--bad)' : ''; };
  const markDirty = () => { dirty = true; q('.cfg-save').disabled = false; };

  const rawCheck = () => {
    if (!cur || cur.format !== 'json' || mode !== 'raw') return;
    try { JSON.parse(ed.value); status('Valid JSON'); } catch (e) { status(`Invalid JSON: ${e.message}`, true); }
  };
  const showMode = (m) => {
    mode = m;
    root.querySelectorAll('.cfg-mode button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    q('.cfg-struct').hidden = m !== 'structured'; ed.hidden = m !== 'raw';
    q('.cfg-fmt').hidden = !(m === 'raw' && cur && cur.format === 'json' && cur.exists);
    if (m === 'raw') rawCheck();
  };
  const paintRows = () => {
    const f = q('.cfg-search').value.trim().toLowerCase();
    const all = parsed.entries; const hits = f ? all.filter((e) => `${e.path} ${e.value}`.toLowerCase().includes(f)) : all;
    q('.cfg-count').textContent = f ? `${hits.length} of ${all.length} entries` : `${all.length} entries`;
    q('.cfg-rows').innerHTML = hits.length ? hits.slice(0, CFG_MAX_ROWS).map((e) => `<div class="cfg-row" data-id="${esc(e.id)}">
        <label class="cfg-k" title="${esc(e.path)}">${e.section ? `<span class="muted">${esc(e.section)}.</span>` : ''}${esc(e.key)}${e.type && e.type !== 'string' ? ` <span class="badge">${esc(e.type)}</span>` : ''}</label>
        <input class="cfg-v" value="${esc(e.value)}" spellcheck="false"><button type="button" class="cfg-del danger" title="Remove this line">&times;</button></div>`).join('')
      + (hits.length > CFG_MAX_ROWS ? `<div class="muted small pad">${hits.length - CFG_MAX_ROWS} more entries - use the search box.</div>` : '')
      : `<div class="muted pad">${all.length ? 'No entry matches.' : 'No entries found in this file yet. Add one below, or use Raw.'}</div>`;
  };
  const reparse = async () => {
    const r = await run('configParse', cur.format, ed.value);
    parsed = r || { ok: false, entries: [], reason: 'Could not parse' };
    return parsed.ok;
  };
  const apply = async (op) => {
    const r = await run('configEdit', cur.format, ed.value, [op]);
    if (!r) return false;
    ed.value = r.text; parsed = { ok: r.ok, entries: r.entries || [] }; markDirty(); paintRows();
    status('Changed - not saved yet');
    return true;
  };
  const setStructuredAvailable = (ok, reason) => {
    const b = root.querySelector('.cfg-mode button[data-m=structured]');
    b.disabled = !ok; b.title = ok ? '' : (reason || 'This file can only be edited as raw text');
  };
  const openMode = async (m) => {
    if (m === 'structured') {
      if (!(await reparse())) { setStructuredAvailable(false, parsed.reason); showMode('raw'); status(parsed.reason || 'Not editable as key / value pairs', true); return; }
      q('.cfg-addsec').hidden = cur.format !== 'ini';
      q('.cfg-note').textContent = cur.format === 'json' ? 'JSON is rewritten with the file\'s own indentation; nested keys use dots (a.b.c). Lists of values can be typed as JSON ([1,2]).' : 'Comments, blank lines and unknown lines are kept as they are. Use Raw for anything not listed here.';
      paintRows();
    }
    showMode(m); if (m === 'structured' && !dirty) status('');
    cfgPref.mode = m;
  };

  const load = async (id, force) => {
    if (dirty && !force && !confirm('Discard unsaved changes?')) return;
    const c = await run('configRead', s.id, id);
    if (!c) return;
    const def = list.find((x) => x.id === id);
    cur = c; dirty = false;
    root.querySelectorAll('.cfg-list div').forEach((d) => d.classList.toggle('sel', d.dataset.c === id));
    q('.cfg-head').innerHTML = `<b>${esc(c.name)}</b> · ${esc(c.path)}${def.description ? ' · ' + esc(def.description) : ''}`;
    q('.cfg-bar').hidden = false;
    ed.value = c.text; ed.disabled = !c.exists;
    q('.cfg-save').disabled = true; q('.cfg-reload').disabled = false; q('.cfg-create').hidden = c.exists;
    status(c.exists ? '' : 'File does not exist yet (the game may create it on first start).');
    if (!c.exists) { setStructuredAvailable(false, 'Create the file first'); showMode('raw'); return; }
    const ok = await reparse(); setStructuredAvailable(ok, parsed.reason);
    await openMode(ok && cfgPref.mode === 'structured' ? 'structured' : 'raw');
    if (!ok && parsed.reason && cur.format !== 'text') status(parsed.reason);
  };
  const save = async () => {
    if (!cur || ed.disabled) return;
    if ((await run('configWrite', s.id, cur.id, ed.value)) !== undefined) { dirty = false; q('.cfg-save').disabled = true; status('Saved (previous version kept as .bak)'); }
  };

  ed.oninput = () => { markDirty(); rawCheck(); };
  ed.onkeydown = (e) => { if (e.ctrlKey && e.key === 's') { e.preventDefault(); save(); } };
  root.onkeydown = (e) => { if (e.ctrlKey && e.key === 's' && mode === 'structured') { e.preventDefault(); save(); } };
  q('.cfg-save').onclick = save;
  q('.cfg-reload').onclick = () => load(cur.id, true);
  q('.cfg-fmt').onclick = () => { try { ed.value = JSON.stringify(JSON.parse(ed.value), null, 2) + '\n'; markDirty(); rawCheck(); } catch (e) { status(`Invalid JSON: ${e.message}`, true); } };
  q('.cfg-create').onclick = async () => { if ((await run('configCreate', s.id, cur.id)) !== undefined) await load(cur.id, true); };
  root.querySelectorAll('.cfg-mode button').forEach((b) => (b.onclick = () => openMode(b.dataset.m)));
  q('.cfg-search').oninput = paintRows;
  q('.cfg-rows').onchange = async (e) => {
    const row = e.target.closest('.cfg-row'); if (!row || !e.target.classList.contains('cfg-v')) return;
    if (!(await apply({ op: 'set', id: row.dataset.id, value: e.target.value }))) await reparse().then(paintRows);
  };
  q('.cfg-rows').onclick = async (e) => {
    const b = e.target.closest('.cfg-del'); if (!b) return;
    const row = b.closest('.cfg-row'); const ent = parsed.entries.find((x) => x.id === row.dataset.id);
    if (!confirm(`Remove "${ent ? ent.path : 'this line'}" from the file? (The change is only saved when you press Save.)`)) return;
    await apply({ op: 'remove', id: row.dataset.id });
  };
  q('.cfg-add').onclick = async () => {
    const key = q('.cfg-addkey').value.trim(); if (!key) return toast('Enter a key', true);
    if (await apply({ op: 'add', path: key, section: q('.cfg-addsec').value.replace(/^\[|\]$/g, ''), value: q('.cfg-addval').value })) { q('.cfg-addkey').value = ''; q('.cfg-addval').value = ''; q('.cfg-search').value = ''; paintRows(); }
  };
  root.querySelectorAll('.cfg-list div').forEach((d) => (d.onclick = () => load(d.dataset.c)));
  if (list.length === 1) await load(list[0].id);
  return { dirty: () => dirty };
}

// the server's "Config Files" tab
function tabConfigs(b, s) { b.innerHTML = '<div class="cfg-host" style="height:100%"></div>'; mountConfigs(b.querySelector('.cfg-host'), s); }

// ---------- Configs screen (Home > Configs) ----------
const cfv = { sid: null, handle: null };
function cfvFill() {
  const sel = $('#cfServer'); const all = [...state.servers.values()];
  sel.innerHTML = all.map((v) => `<option value="${esc(v.id)}">#${esc(v.id)} ${esc(v.name)} (${esc(v.gameName)})</option>`).join('');
  if (!all.some((v) => v.id === cfv.sid)) cfv.sid = (state.servers.has(state.sel) ? state.sel : (all[0] && all[0].id)) || null;
  sel.value = cfv.sid || '';
  $('#cfEmpty').hidden = all.length > 0;
}
async function cfvOpen(force) {
  const s = state.servers.get(cfv.sid);
  const body = $('#cfBody');
  if (!s) { body.innerHTML = ''; return; }
  if (!force && cfv.handle && cfv.handle.dirty() && !confirm('Discard unsaved changes?')) { $('#cfServer').value = cfv.shown; cfv.sid = cfv.shown; return; }
  cfv.shown = s.id;
  cfv.handle = await mountConfigs(body, s);
}
$('#cfServer').onchange = (e) => { cfv.sid = e.target.value; cfvOpen(false); };
viewHooks.configs = () => { cfvFill(); if (cfv.sid !== cfv.shown || !cfv.handle) cfvOpen(true); };
