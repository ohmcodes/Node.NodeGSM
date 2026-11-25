'use strict';
// Backups: the server's Backups tab (Full / Neat pick chooser + list) and the Backups screen (Home > Backups, all servers).
// Uses the globals of app.js / dashboard.js (run, esc, $, toast, state, viewHooks, bkSize, setView, select).

const bkWhen = (t) => new Date(t).toLocaleString();
const bkSize = (b) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(2)} GB` : b >= 2 ** 20 ? `${(b / 2 ** 20).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const bkMode = (r) => (r.mode === 'neatpick' ? 'Neat pick' : 'Full');

/** One-line summary of what a backup holds (manifest based; old backups have none). */
function bkContents(r) {
  const m = r.manifest;
  if (!m) return { text: 'Everything (old backup, no manifest)', title: 'Created before manifests existed - treated as a full backup' };
  const parts = [];
  if (r.mode === 'full') parts.push('Everything');
  else {
    if (m.presets && m.presets.length) parts.push(`presets: ${m.presets.join(', ')}`);
    parts.push(`${(m.paths || []).length} path${(m.paths || []).length === 1 ? '' : 's'}`);
  }
  parts.push(`${m.fileCount} file${m.fileCount === 1 ? '' : 's'}`);
  if (m.includesServerSettings) parts.push('server settings');
  const title = [`Paths: ${(m.paths || []).join(', ') || 'all'}`, (m.exclude || []).length ? `Excluded: ${m.exclude.join(', ')}` : '', m.gameVersion ? `Game version: ${m.gameVersion}` : '', m.skipped ? `${m.skipped} file(s) were skipped (locked / links)` : ''].filter(Boolean).join('\n');
  return { text: parts.join(' · '), title };
}

function bkRowHtml(r, withServer) {
  const c = bkContents(r);
  const srvOk = !r.deleted && state.servers.has(r.serverId);
  return `<tr data-folder="${esc(r.folder)}" data-file="${esc(r.file)}">
    ${withServer ? `<td>${r.deleted ? `<span class="muted">#${esc(r.serverId)}</span> ${esc(r.serverName || '?')} <span class="badge bk-del" title="This server no longer exists. Its backups are kept; use Restore as new server.">deleted server</span>` : `#${esc(r.serverId)} ${esc(r.serverName || '')}`}</td>` : ''}
    <td class="nw" title="${esc(r.file)}">${esc(bkWhen(r.time))}</td><td class="nw">${esc(bkSize(r.size))}</td>
    <td><span class="mbadge ${esc(r.mode)}">${bkMode(r)}</span></td><td class="bk-cont" title="${esc(c.title)}">${esc(c.text)}${r.pluginMissing ? ' <span class="badge bk-del">plugin missing</span>' : ''}</td>
    <td class="bk-act"><button data-a="restore" ${srvOk ? '' : 'disabled'} title="${srvOk ? 'Restore into this server' : 'The server no longer exists'}">Restore</button>
      <button data-a="new" ${r.pluginMissing ? 'disabled' : ''} title="Create a new server from this backup">Restore as new server</button>
      <button data-a="open" title="${bkWeb() ? 'Download the zip' : 'Show the file in its folder'}">${bkWeb() ? 'Download' : 'Open folder'}</button><button data-a="del" class="danger">Delete</button></td></tr>`;
}

const bkWeb = () => typeof isWeb === 'function' && isWeb();

/** Actions shared by both screens. row = the listing object; done = refresh callback. */
async function bkAct(act, r, done) {
  if (act === 'open') {
    // web mode: real download through the authenticated HTTP endpoint; desktop: reveal the zip in Explorer
    if (typeof isWeb === 'function' && isWeb()) { window.location.href = `/download/backup?folder=${encodeURIComponent(r.folder)}&file=${encodeURIComponent(r.file)}`; return; }
    return run('backupDownload', r.folder, r.file);
  }
  if (act === 'del') {
    if (!confirm(`Delete ${r.file}?This cannot be undone.`)) return;
    if ((await run('deleteBackup', r.folder, r.file)) !== undefined) { toast('Backup deleted'); done(); }
    return;
  }
  if (act === 'restore') {
    const neat = r.mode === 'neatpick';
    if (!confirm(`Restore ${r.file} into server #${r.serverId}?\n\nFiles in the backup overwrite the current ones${neat ? ' (neat pick: only the backed-up files are touched)' : ''}. The server is stopped first.`)) return;
    const opts = {};
    if (r.manifest && r.manifest.includesServerSettings) opts.restoreSettings = confirm('This backup also contains the server settings (name, ports, parameters ...).\n\nRestore them too? OK = yes, Cancel = keep the current settings.');
    toast('Restoring ...');
    if ((await run('restore', r.folder, r.file, opts)) !== undefined) { toast('Restored'); done(); }
    return;
  }
  if (act === 'new') bkNewDialog(r, done);
}

// ---------- "Restore as new server" dialog ----------
let bkNewRow = null; let bkNewDone = null;
function bkNewDialog(r, done) {
  bkNewRow = r; bkNewDone = done;
  $('#bnName').value = `${r.serverName || r.gameName || 'Server'} (restored)`;
  $('#bnGameRow').hidden = !r.legacy;
  if (r.legacy) $('#bnGame').innerHTML = '<option value="">Choose the game ...</option>' + state.games.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  $('#bnSettingsRow').hidden = !(r.manifest && r.manifest.includesServerSettings);
  $('#bnSettings').checked = true;
  $('#bnNote').textContent = r.mode === 'neatpick' ? 'Neat-pick backup: the game is downloaded and installed first (internet needed), then the backed-up files are applied.' : 'The backup is extracted into a brand new server. Nothing of the existing server is touched.';
  $('#dlgBkNew').showModal();
}
$('#bnCancel').onclick = () => $('#dlgBkNew').close();
$('#bnForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = bkNewRow; const name = $('#bnName').value.trim();
  const opts = { name, restoreSettings: $('#bnSettings').checked };
  if (r.legacy) { opts.game = $('#bnGame').value; if (!opts.game) return toast('Choose the game of this old backup', true); }
  $('#dlgBkNew').close();
  toast(r.mode === 'neatpick' ? 'Creating the server and installing the game ...' : 'Creating the server ...');
  const res = await run('restoreNew', r.folder, r.file, opts);
  if (!res) return;
  if (res.server) state.servers.set(res.server.id, res.server);
  renderList();
  toast(`Server "${res.name}" created from the backup${res.portAdjusted ? ' (a port was taken and moved to the next free one)' : ''}`);
  if (bkNewDone) bkNewDone();
};

function bkBind(root, rows, done) {
  root.querySelectorAll('tr[data-file] button[data-a]').forEach((b) => (b.onclick = () => {
    const tr = b.closest('tr');
    const r = rows.find((x) => x.folder === tr.dataset.folder && x.file === tr.dataset.file);
    if (r) bkAct(b.dataset.a, r, done);
  }));
}

// ---------- Backups screen (all servers) ----------
const bv = { rows: [] };
function bvFilters() { return { server: $('#bvServer').value, mode: $('#bvMode').value, text: $('#bvText').value.trim().toLowerCase() }; }
function bvFillServers() {
  const sel = $('#bvServer'); const cur = sel.value;
  sel.innerHTML = '<option value="">All servers</option><option value="deleted">Deleted servers</option>' + [...state.servers.values()].map((s) => `<option value="${esc(s.id)}">#${esc(s.id)} ${esc(s.name)}</option>`).join('');
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
}
function bvPaint() {
  const f = bvFilters();
  const rows = bv.rows.filter((r) => (!f.server || (f.server === 'deleted' ? r.deleted : !r.deleted && r.serverId === f.server))
    && (!f.mode || r.mode === f.mode)
    && (!f.text || `${r.serverName} ${r.gameName} ${r.file} ${bkContents(r).text}`.toLowerCase().includes(f.text)));
  const total = rows.reduce((n, r) => n + r.size, 0);
  $('#bvCount').textContent = `${rows.length} backup${rows.length === 1 ? '' : 's'} · ${bkSize(total)}`;
  $('#bvTable').innerHTML = '<thead><tr><th>Server</th><th>Date</th><th>Size</th><th>Mode</th><th>Contents</th><th></th></tr></thead><tbody>' + rows.map((r) => bkRowHtml(r, true)).join('') + '</tbody>';
  $('#bvEmpty').hidden = rows.length > 0;
  bkBind($('#bvTable'), rows, bvRefresh);
}
async function bvRefresh() {
  bvFillServers();
  const rows = await run('backups');
  if (!rows) return;
  bv.rows = rows;
  bvPaint();
}
['#bvServer', '#bvMode'].forEach((s) => ($(s).onchange = bvPaint));
$('#bvText').oninput = bvPaint;
$('#bvRefresh').onclick = bvRefresh;
viewHooks.backups = bvRefresh;

// ---------- server tab: Backups ----------
/** Tick-box tree of the server files (listDir, loaded folder by folder). */
function bkTree(box, sid, sel, onChange) {
  const open = new Set(); const cache = new Map();
  const covered = (p) => { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) if (sel.has(parts.slice(0, i).join('/'))) return true; return false; };
  const load = async (rel) => {
    if (cache.has(rel)) return;
    const items = (await run('listDir', sid, rel)) || [];
    items.sort((a, c) => (c.dir - a.dir) || a.name.localeCompare(c.name));
    cache.set(rel, items);
  };
  const html = (rel, depth) => (cache.get(rel) || []).map((i) => {
    const p = rel ? `${rel}/${i.name}` : i.name; const cov = covered(p);
    return `<div class="tn" style="padding-left:${depth * 16 + 4}px"><span class="tc ${i.dir ? '' : 'blank'}" data-tog="${esc(p)}">${i.dir ? (open.has(p) ? '&#9662;' : '&#9656;') : ''}</span>
      <label class="check"><input type="checkbox" data-p="${esc(p)}" ${sel.has(p) || cov ? 'checked' : ''} ${cov ? 'disabled' : ''}> ${i.dir ? '&#128193;' : '&#128196;'} ${esc(i.name)}</label></div>${i.dir && open.has(p) ? html(p, depth + 1) : ''}`;
  }).join('');
  const paint = () => { const top = box.scrollTop; box.innerHTML = html('', 0) || '<span class="muted small pad">The server folder is empty.</span>'; box.scrollTop = top; };
  box.onclick = async (e) => {
    const t = e.target.closest('[data-tog]');
    if (!t || t.classList.contains('blank')) return;
    const p = t.dataset.tog;
    if (open.has(p)) open.delete(p); else { await load(p); open.add(p); }
    paint();
  };
  box.onchange = (e) => {
    const c = e.target.closest('input[data-p]'); if (!c) return;
    if (c.checked) sel.add(c.dataset.p); else sel.delete(c.dataset.p);
    for (const k of [...sel]) if (k !== c.dataset.p && k.startsWith(c.dataset.p + '/')) sel.delete(k);   // a folder covers what is inside it
    paint(); onChange();
  };
  load('').then(paint);
}

async function tabBackups(b, s) {
  const info = (await run('backupInfo', s.id)) || { presets: [], exclude: [], keep: 0 };
  const sel = new Set(); let mode = 'full';
  b.innerHTML = `
    <div class="row"><div class="seg" id="bkModeSeg"><button type="button" data-m="full" class="on">Full</button><button type="button" data-m="neatpick">Neat pick</button></div>
      <span class="muted small" id="bkNote"></span></div>
    <div id="bkNeat" hidden>
      <h4>Presets from the game plugin</h4>
      ${info.presets.length ? `<div class="colgrid" id="bkPresets">${info.presets.map((p) => `<label class="check" title="${esc(p.paths.join('\n'))}"><input type="checkbox" data-pre="${esc(p.id)}"> ${esc(p.name)}</label>`).join('')}</div>` : '<p class="muted small" style="margin:0">This game plugin declares no presets. Pick folders and files below.</p>'}
      <h4>Folders and files</h4>
      <div class="bk-tree" id="bkTree"></div>
    </div>
    <h4>Exclude patterns</h4>
    <textarea id="bkExclude" rows="2" spellcheck="false" placeholder="One per line, e.g. *.log or Saved/Logs"></textarea>
    <p class="muted small" style="margin:4px 0 0">${info.exclude.length ? `The plugin always excludes: <code>${esc(info.exclude.join('  '))}</code>. ` : ''}A pattern without "/" matches any file or folder name; with "/" it is read from the server folder. <code>*</code> and <code>?</code> are wildcards.</p>
    <div class="row" style="margin-top:12px"><label class="check"><input type="checkbox" id="bkSettings" checked> Include server settings (<code>wgsm.json</code>: name, ports, parameters)</label></div>
    <div class="row wrap" style="margin-top:8px">
      <button type="button" id="bkPreview">Estimate size</button><span id="bkPreviewOut" class="muted small"></span><span class="spacer"></span>
      <label class="check" title="Older backups of this server are deleted after each new one. 0 = keep everything.">Keep the newest <input id="bkKeep" type="number" min="0" max="1000" value="${info.keep}" style="width:72px"> backups</label>
      <button type="button" id="bkNow" class="primary">Backup now</button></div>
    <h4>Backups of this server</h4><div id="bkList"></div>`;
  const options = () => ({
    mode,
    presets: [...b.querySelectorAll('input[data-pre]:checked')].map((x) => x.dataset.pre),
    paths: [...sel],
    exclude: $('#bkExclude').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
    includeServerSettings: $('#bkSettings').checked,
  });
  const note = () => { $('#bkNote').textContent = mode === 'full' ? 'The whole server folder (plugin excludes apply).' : 'Only what you tick below. Restoring needs the game to be installed.'; };
  const clearPreview = () => { $('#bkPreviewOut').textContent = ''; };
  b.querySelectorAll('#bkModeSeg button').forEach((x) => (x.onclick = () => {
    mode = x.dataset.m;
    b.querySelectorAll('#bkModeSeg button').forEach((y) => y.classList.toggle('on', y === x));
    $('#bkNeat').hidden = mode !== 'neatpick';
    $('#bkSettings').checked = mode === 'full';
    note(); clearPreview();
  }));
  note();
  bkTree($('#bkTree'), s.id, sel, clearPreview);
  b.querySelectorAll('input[data-pre], #bkSettings, #bkExclude').forEach((x) => x.addEventListener('change', clearPreview));
  $('#bkPreview').onclick = async () => {
    $('#bkPreviewOut').textContent = 'Counting ...';
    const p = await run('backupPreview', s.id, options());
    if (!p) { $('#bkPreviewOut').textContent = ''; return; }
    $('#bkPreviewOut').textContent = `${p.fileCount} file${p.fileCount === 1 ? '' : 's'}, ${bkSize(p.totalBytes)} before compression${p.skipped ? ` · ${p.skipped} skipped (links / unreadable)` : ''}${p.missing.length ? ` · missing: ${p.missing.join(', ')}` : ''}`;
  };
  $('#bkKeep').onchange = async () => {
    const n = Math.max(0, Math.min(1000, parseInt($('#bkKeep').value, 10) || 0));
    $('#bkKeep').value = n;
    if ((await run('save', s.id, { backupKeep: n })) !== undefined) toast(n ? `Keeping the newest ${n} backups` : 'Keeping all backups');
  };
  const paintList = async () => {
    const rows = (await run('backups', s.id)) || [];
    if (!$('#bkList')) return;
    $('#bkList').innerHTML = rows.length
      ? `<table><thead><tr><th>Date</th><th>Size</th><th>Mode</th><th>Contents</th><th></th></tr></thead><tbody>${rows.map((r) => bkRowHtml(r, false)).join('')}</tbody></table>`
      : '<p class="muted">No backups yet.</p>';
    bkBind($('#bkList'), rows, paintList);
  };
  $('#bkNow').onclick = async () => {
    const btn = $('#bkNow'); btn.disabled = true; toast('Backing up ...');
    try { if ((await run('backup', s.id, options())) !== undefined) toast('Backup complete'); } finally { btn.disabled = false; }
    paintList();
  };
  paintList();
}
