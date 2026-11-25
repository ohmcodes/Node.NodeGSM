'use strict';
// Clusters screen (Home > Clusters): list, create dialog, detail with Update / Config sync / Clear folders / Edit.
// Uses the globals of app.js / dashboard.js / backupsView.js (run, esc, $, toast, state, api, viewHooks, bkSize).

const cl = { list: [], sel: null, tool: null, busy: false };
const clSel = () => cl.list.find((c) => c.id === cl.sel) || null;
const clLines = (v) => String(v || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const clDot = (s) => `<span class="dot ${esc(s)}" title="${esc(s)}"></span>`;

async function clRefresh(keepTool) {
  const list = await run('clusters');
  if (!list) return;
  cl.list = list;
  if (!cl.list.some((c) => c.id === cl.sel)) { cl.sel = cl.list.length ? cl.list[0].id : null; keepTool = false; }
  if (!keepTool) cl.tool = null;
  clPaintList(); clPaintDetail();
}

/** Refresh the list and the member table only (keeps a preview / result in the tool area). */
async function clSoft() {
  const list = await run('clusters');
  if (!list) return;
  cl.list = list; clPaintList();
  const c = clSel(); const tb = document.querySelector('#clDetail .cl-members tbody');
  if (c && tb) tb.innerHTML = clMemberRows(c);
}

function clPaintList() {
  $('#clEmpty').hidden = cl.list.length > 0;
  $('#clList').innerHTML = cl.list.map((c) => `<li data-id="${esc(c.id)}" class="${c.id === cl.sel ? 'sel' : ''}">
    <div><div class="nm">${esc(c.name)}</div><div class="sub">${esc(c.gameName)} · ${c.members.length} servers</div>
    <div class="cl-dots">${c.members.map((m) => `<span class="cl-m" title="${esc(m.name)}${m.isParent ? ' (parent)' : ''}: ${esc(m.status)}">${clDot(m.status)}${m.isParent ? '<b>P</b>' : ''}</span>`).join('')}</div></div>
    ${c.busy ? `<span class="badge">${esc(c.busy)}</span>` : ''}</li>`).join('');
  $('#clList').querySelectorAll('li').forEach((li) => (li.onclick = () => { cl.sel = li.dataset.id; cl.tool = null; clPaintList(); clPaintDetail(); }));
}

function clPaintDetail() {
  const c = clSel(); const box = $('#clDetail');
  if (!c) { box.innerHTML = '<p class="muted pad">Select a cluster, or create one with <b>Create cluster</b>.</p>'; return; }
  const tools = [['update', 'Update'], ['config', 'Config sync'], ['clear', 'Clear folders'], ['edit', 'Edit']];
  box.innerHTML = `<div class="cl-head"><div><h3 style="margin:0">${esc(c.name)}</h3><div class="muted small">${esc(c.gameName)} · cluster #${esc(c.id)}${c.pluginMissing ? ' · <span class="dc-bad">plugin missing</span>' : ''}</div></div>
      <span class="spacer"></span><button type="button" id="clDelete" class="danger">Delete cluster</button></div>
    <table class="cl-members"><thead><tr><th></th><th>Server</th><th>Port</th><th>Role</th><th>Status</th></tr></thead><tbody>${clMemberRows(c)}</tbody></table>
    <div class="seg cl-tools" id="clTools">${tools.map(([k, l]) => `<button type="button" data-t="${k}" class="${cl.tool === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="clTool" class="cl-tool"></div>`;
  $('#clDelete').onclick = async () => {
    if (!confirm(`Delete the cluster "${c.name}"?\n\nOnly the grouping is removed. The servers and their files are not touched.`)) return;
    if ((await run('clusterDelete', c.id)) !== undefined) { toast('Cluster deleted'); cl.sel = null; clRefresh(); }
  };
  $('#clTools').querySelectorAll('button').forEach((b) => (b.onclick = () => { cl.tool = b.dataset.t; clPaintDetail(); }));
  if (cl.tool === 'update') clToolUpdate(c); else if (cl.tool === 'config') clToolConfig(c); else if (cl.tool === 'clear') clToolClear(c); else if (cl.tool === 'edit') clToolEdit(c);
  else $('#clTool').innerHTML = `<p class="muted small">Pick an action. <b>Update</b> updates the parent and copies its game files to the members (configs and saves are kept). <b>Config sync</b> copies config files and keeps each member's unique settings. <b>Clear folders</b> removes old logs and temp files on every server.</p>`;
}

const clMemberRows = (c) => c.members.map((m) => `<tr><td>${clDot(m.status)}</td><td>#${esc(m.id)} ${esc(m.name)}</td><td>${esc(m.port)}</td><td>${m.isParent ? '<span class="mbadge neatpick">Parent</span>' : 'Member'}</td><td>${esc(m.status)}</td></tr>`).join('');
const clSkel = (rows, head) => `<table class="cl-res"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;

// ---------- Update ----------
function clToolUpdate(c) {
  const t = $('#clTool');
  t.innerHTML = `<div class="row wrap">
      <label class="check"><input type="checkbox" id="cuValidate" ${c.validateSupported ? '' : 'disabled'}> Validate files (slower, repairs the parent)</label>
      <label class="check"><input type="checkbox" id="cuChanged" ${c.options.onlyChanged ? 'checked' : ''}> Copy only changed files (size + date)</label>
      <label class="check"><input type="checkbox" id="cuParent" checked> Update the parent first</label></div>
    <div class="row" style="margin-top:8px"><button type="button" id="cuPlan">Preview (nothing is changed)</button><button type="button" id="cuRun" class="primary">Run update</button><span class="muted small">Running members are stopped and started again.</span></div>
    <div id="cuBar" class="cl-bar" hidden><div class="cl-fill" id="cuFill"></div></div><div id="cuMsg" class="muted small"></div><div id="cuOut"></div>`;
  const opts = () => ({ validate: $('#cuValidate').checked, onlyChanged: $('#cuChanged').checked, skipParentUpdate: !$('#cuParent').checked });
  $('#cuPlan').onclick = async () => {
    $('#cuOut').innerHTML = '<span class="muted small">Scanning ...</span>';
    const p = await run('clusterUpdatePlan', c.id, opts());
    if (!p) { $('#cuOut').innerHTML = ''; return; }
    $('#cuOut').innerHTML = clSkel(p.members.map((m) => `<tr><td>#${esc(m.id)} ${esc(m.name)}${m.running ? ' <span class="badge">running</span>' : ''}</td>${m.error ? `<td colspan="4" class="dc-bad">${esc(m.error)}</td>` : `<td>${m.files}</td><td>${esc(bkSize(m.bytes))}</td><td>${m.skippedPreserved}</td><td>${m.skippedIdentical}</td>`}</tr>`).join(''), ['Member', 'Files to copy', 'Size', 'Preserved', 'Identical'])
      + `<h4>Never overwritten</h4><p class="small cl-pre">${p.preserve.map((x) => `<code>${esc(x)}</code>`).join(' ')}</p><p class="muted small">Plugin config files, the plugin's preserve list, the cluster's own preserve rules and <code>configs/wgsm.json</code>. Links are never followed.</p>`;
  };
  $('#cuRun').onclick = async () => {
    if (!confirm(`Update the cluster "${c.name}"?\n\nThe parent is updated, then its files are copied to ${c.members.length - 1} member(s). Running members are stopped and restarted.`)) return;
    cl.busy = true; $('#cuRun').disabled = true; $('#cuPlan').disabled = true; $('#cuBar').hidden = false; $('#cuFill').style.width = '0%';
    let r;
    try { r = await run('clusterUpdate', c.id, opts()); } finally { cl.busy = false; }
    if (!$('#cuRun')) return;
    $('#cuRun').disabled = false; $('#cuPlan').disabled = false;
    if (!r) { $('#cuMsg').textContent = 'The update failed (see the message above and the Logs screen).'; return; }
    $('#cuFill').style.width = '100%';
    $('#cuOut').innerHTML = clSkel(r.members.map((m) => `<tr><td>#${esc(m.id)} ${esc(m.name)}</td><td>${m.ok ? '<span class="ok">OK</span>' : `<span class="dc-bad">${esc(m.error || 'failed')}</span>`}</td><td>${m.files}</td><td>${esc(bkSize(m.bytes))}</td><td>${m.skippedIdentical}</td><td>${m.wasRunning ? (m.restarted ? 'restarted' : 'not restarted') : '-'}</td></tr>`).join(''), ['Member', 'Result', 'Copied', 'Size', 'Identical', 'Server']);
    toast(r.ok ? 'Cluster updated' : 'Cluster updated with errors', !r.ok);
    clSoft();
  };
}
api.on('cluster:progress', (p) => {
  if (!cl.sel || p.clusterId !== cl.sel || !$('#cuFill')) return;
  $('#cuBar').hidden = false;
  $('#cuFill').style.width = `${Math.max(0, Math.min(100, p.percent || 0)).toFixed(1)}%`;
  $('#cuMsg').textContent = `${(p.percent || 0).toFixed(0)}% - ${p.message || ''}${p.memberIndex ? ` (${p.memberIndex}/${p.memberCount})` : ''}`;
});

// ---------- Config sync ----------
function clDiffHtml(text) {
  return esc(text).split('\n').map((l) => `<span class="${l.startsWith('@@') ? 'df-h' : l.startsWith('+') ? 'df-add' : l.startsWith('-') ? 'df-del' : ''}">${l || ' '}</span>`).join('');
}
function clToolConfig(c) {
  const t = $('#clTool');
  if (!c.configs.length) { t.innerHTML = '<p class="muted">The game plugin declares no config files.</p>'; return; }
  t.innerHTML = `<h4>Config files to copy from the parent</h4>
    <div class="colgrid cl-cfgs">${c.configs.map((d, i) => `<label class="check" title="${esc(d.path)}"><input type="checkbox" data-cfg="${esc(d.id)}" ${i === 0 ? 'checked' : ''}> ${esc(d.name)} <span class="muted small">(${esc(d.format)})</span></label>`).join('')}</div>
    <p class="muted small">Protected keys${c.protectedKeys.length ? ` (<code>${esc(c.protectedKeys.join(' '))}</code> plus per-file lists)` : ''} and lines containing <code>NGSM:ignore</code> keep the member's value. Plain text files are copied whole.</p>
    <div class="row"><button type="button" id="ccPlan">Preview changes</button><button type="button" id="ccApply" class="primary" disabled>Apply</button></div><div id="ccOut"></div>`;
  const ids = () => [...t.querySelectorAll('input[data-cfg]:checked')].map((x) => x.dataset.cfg);
  t.querySelectorAll('input[data-cfg]').forEach((x) => (x.onchange = () => { $('#ccApply').disabled = true; $('#ccOut').innerHTML = ''; }));
  $('#ccPlan').onclick = async () => {
    if (!ids().length) return toast('Choose at least one config file', true);
    $('#ccOut').innerHTML = '<span class="muted small">Comparing ...</span>';
    const p = await run('clusterConfigPlan', c.id, { configIds: ids() });
    if (!p) { $('#ccOut').innerHTML = ''; return; }
    const stat = { changed: 'will change', new: 'will be created', unchanged: 'identical', error: 'error' };
    $('#ccOut').innerHTML = p.members.map((m) => `<h4>#${esc(m.id)} ${esc(m.name)}</h4>` + m.files.map((f) => `<details class="cl-file" ${f.status === 'changed' || f.status === 'new' || f.status === 'error' ? 'open' : ''}>
      <summary><b>${esc(f.name)}</b> <span class="mbadge ${f.status === 'unchanged' ? '' : 'neatpick'}">${esc(stat[f.status])}</span>${f.added || f.removed ? ` <span class="muted small">+${f.added} -${f.removed}</span>` : ''}</summary>
      ${f.error ? `<p class="dc-bad small">${esc(f.error)}</p>` : ''}${f.warnings.map((w) => `<p class="cl-warn small">&#9888; ${esc(w)}</p>`).join('')}
      ${f.diff ? `<pre class="cl-diff">${clDiffHtml(f.diff)}</pre>` : ''}</details>`).join('')).join('');
    const changes = p.members.flatMap((m) => m.files).filter((f) => f.status === 'changed' || f.status === 'new').length;
    $('#ccApply').disabled = changes === 0;
    if (!changes) $('#ccOut').insertAdjacentHTML('afterbegin', '<p class="muted">Nothing to change.</p>');
  };
  $('#ccApply').onclick = async () => {
    if (!confirm('Write the previewed config files to the members? A .bak copy of every replaced file is kept.')) return;
    const r = await run('clusterConfigApply', c.id, { configIds: ids() });
    if (!r) return;
    toast(`${r.written} file${r.written === 1 ? '' : 's'} written${r.errors ? `, ${r.errors} error${r.errors === 1 ? '' : 's'}` : ''}. Restart the servers to apply.`, r.errors > 0);
    $('#ccApply').disabled = true; $('#ccPlan').click();
  };
}

// ---------- Clear folders ----------
function clToolClear(c) {
  const t = $('#clTool');
  t.innerHTML = `<h4>Rules</h4>${c.clearRules.length ? `<ul class="cl-rules">${c.clearRules.map((r) => `<li><code>${esc(r.path)}</code> <code>${esc(r.pattern || '*')}</code>${r.olderThanDays ? ` older than ${r.olderThanDays} days` : ''}${r.recursive ? ' (with sub-folders)' : ''} <span class="muted small">${esc(r.source)}</span></li>`).join('')}</ul>` : '<p class="muted small">No rules yet. The game plugin declares none: add your own in <b>Edit</b>.</p>'}
    <div class="row"><button type="button" id="ckPlan" ${c.clearRules.length ? '' : 'disabled'}>Preview</button><button type="button" id="ckRun" class="primary" disabled>Delete these files</button></div><div id="ckOut"></div>`;
  $('#ckPlan').onclick = async () => {
    const p = await run('clusterClearPlan', c.id);
    if (!p) return;
    $('#ckOut').innerHTML = clSkel(p.members.map((m) => `<tr><td>#${esc(m.id)} ${esc(m.name)}</td><td>${m.files}</td><td>${esc(bkSize(m.bytes))}</td><td class="small">${m.rules.map((r) => `${esc(r.path)}: ${r.error ? `<span class="dc-bad">${esc(r.error)}</span>` : r.exists ? r.files : 'no folder'}`).join('<br>')}</td></tr>`).join(''), ['Server', 'Files', 'Size', 'Per rule'])
      + `<p class="small">${p.files} file${p.files === 1 ? '' : 's'}, ${esc(bkSize(p.bytes))} in total.</p>` + (p.members.some((m) => m.sample.length) ? `<details><summary class="small">Examples</summary><pre class="cl-diff">${esc(p.members.flatMap((m) => m.sample.map((s) => `#${m.id} ${s}`)).slice(0, 40).join('\n'))}</pre></details>` : '');
    $('#ckRun').disabled = p.files === 0;
  };
  $('#ckRun').onclick = async () => {
    if (!confirm('Delete the previewed files on every server of the cluster? This cannot be undone. Folders are kept, locked files are skipped.')) return;
    const r = await run('clusterClear', c.id);
    if (!r) return;
    toast(`Deleted ${r.files} file${r.files === 1 ? '' : 's'} (${bkSize(r.bytes)})${r.locked ? `, ${r.locked} locked and skipped` : ''}`);
    $('#ckRun').disabled = true; $('#ckPlan').click();
  };
}

// ---------- Edit ----------
function clFreeServers(game, selfId) {
  const taken = new Set(cl.list.filter((x) => x.id !== selfId).flatMap((x) => x.memberIds));
  return [...state.servers.values()].filter((s) => s.game === game && !taken.has(s.id));
}
function clToolEdit(c) {
  const free = clFreeServers(c.game, c.id);
  const t = $('#clTool'); const o = c.options;
  t.innerHTML = `<div class="dc-form"><label>Name<input id="ceName" value="${esc(c.name)}" maxlength="60"></label>
      <label>Parent<select id="ceParent"></select></label></div>
    <h4>Servers</h4><div class="colgrid" id="ceMembers">${free.map((s) => `<label class="check"><input type="checkbox" data-m="${esc(s.id)}" ${c.memberIds.includes(s.id) ? 'checked' : ''}> #${esc(s.id)} ${esc(s.name)}</label>`).join('')}</div>
    <h4>Extra rules for this cluster (one per line)</h4>
    <div class="dc-form"><label><span>Protected config keys (<code>port</code>, <code>rcon.*</code>)</span><textarea id="ceProtect" rows="3" spellcheck="false">${esc(o.protect.join('\n'))}</textarea></label>
    <label><span>Never overwritten on update (paths)</span><textarea id="cePreserve" rows="3" spellcheck="false">${esc(o.preserve.join('\n'))}</textarea></label></div>
    <label style="margin-top:8px"><span>Clear folders: <code>path | pattern | older than days</code> (e.g. <code>logs | *.log | 7</code>)</span><textarea id="ceClear" rows="3" spellcheck="false">${esc(o.clearFolders.map((r) => `${r.path} | ${r.pattern || '*'} | ${r.olderThanDays || 0}`).join('\n'))}</textarea></label>
    <div class="row" style="margin-top:10px"><button type="button" id="ceSave" class="primary">Save</button></div>`;
  const syncParent = () => {
    const ids = [...t.querySelectorAll('input[data-m]:checked')].map((x) => x.dataset.m);
    const cur = $('#ceParent').value || c.parentId;
    $('#ceParent').innerHTML = ids.map((id) => `<option value="${esc(id)}">#${esc(id)} ${esc((state.servers.get(id) || {}).name || '')}</option>`).join('');
    $('#ceParent').value = ids.includes(cur) ? cur : (ids[0] || '');
  };
  $('#ceParent').innerHTML = ''; $('#ceParent').value = c.parentId; syncParent();
  t.querySelectorAll('input[data-m]').forEach((x) => (x.onchange = syncParent));
  $('#ceSave').onclick = async () => {
    const clear = clLines($('#ceClear').value).map((l) => { const [p, pat, d] = l.split('|').map((x) => x.trim()); return { path: p, pattern: pat || '*', olderThanDays: Number(d) || 0 }; });
    const r = await run('clusterSave', c.id, {
      name: $('#ceName').value, parentId: $('#ceParent').value, memberIds: [...t.querySelectorAll('input[data-m]:checked')].map((x) => x.dataset.m),
      options: { protect: clLines($('#ceProtect').value), preserve: clLines($('#cePreserve').value), clearFolders: clear },
    });
    if (r) { toast('Cluster saved'); clRefresh(true); }
  };
}

// ---------- Create ----------
function clNewDialog() {
  const taken = new Set(cl.list.flatMap((x) => x.memberIds));
  const byGame = new Map();
  for (const s of state.servers.values()) if (!taken.has(s.id)) { if (!byGame.has(s.game)) byGame.set(s.game, []); byGame.get(s.game).push(s); }
  const games = [...byGame].filter(([, l]) => l.length >= 2);
  $('#cnGame').innerHTML = games.map(([g, l]) => `<option value="${esc(g)}">${esc(l[0].gameName)} (${l.length} free servers)</option>`).join('');
  $('#cnOk').disabled = !games.length;
  $('#cnNone').hidden = games.length > 0;
  $('#cnBody').hidden = !games.length;
  const paint = () => {
    const l = byGame.get($('#cnGame').value) || [];
    $('#cnServers').innerHTML = l.map((s, i) => `<div class="cl-pick"><label class="check"><input type="checkbox" name="cnm" value="${esc(s.id)}" checked> #${esc(s.id)} ${esc(s.name)} <span class="muted small">:${esc(s.port)}</span></label>
      <label class="check small"><input type="radio" name="cnp" value="${esc(s.id)}" ${i === 0 ? 'checked' : ''}> parent</label></div>`).join('');
    const g = games.find(([id]) => id === $('#cnGame').value);
    $('#cnName').value = g ? `${g[1][0].gameName} cluster` : '';
  };
  $('#cnGame').onchange = paint; paint();
  $('#dlgClNew').showModal();
}
$('#cnCancel').onclick = () => $('#dlgClNew').close();
$('#cnForm').onsubmit = async (e) => {
  e.preventDefault();
  const memberIds = [...document.querySelectorAll('#cnServers input[name=cnm]:checked')].map((x) => x.value);
  const parent = document.querySelector('#cnServers input[name=cnp]:checked');
  if (memberIds.length < 2) return toast('Choose at least 2 servers', true);
  const r = await run('clusterCreate', { name: $('#cnName').value, memberIds, parentId: parent && memberIds.includes(parent.value) ? parent.value : memberIds[0] });
  if (!r) return;
  $('#dlgClNew').close(); toast(`Cluster "${r.name}" created`); cl.sel = r.id; cl.tool = null; clRefresh();
};
$('#clNew').onclick = clNewDialog;
$('#clRefresh').onclick = () => clRefresh(true);
api.on('removed', () => { if (document.body.dataset.view === 'clusters') setTimeout(() => clRefresh(true), 300); });
api.on('status', () => { if (document.body.dataset.view === 'clusters' && !cl.busy) { clearTimeout(cl.t); cl.t = setTimeout(() => { if (!cl.busy) clSoft(); }, 1500); } });
viewHooks.clusters = () => clRefresh(false);
