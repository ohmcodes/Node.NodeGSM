'use strict';
const api = window.wgsm;
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { games: [], servers: new Map(), sel: null, tab: 'console', consoleBuf: [], pickGame: null };

function toast(msg, err) {
  const d = document.createElement('div');
  if (err) d.className = 'err';
  d.textContent = msg;
  $('#toast').appendChild(d);
  setTimeout(() => d.remove(), err ? 7000 : 3500);
}
async function run(name, ...args) {
  try { return await api.call(name, ...args); } catch (e) { toast(e.message, true); return undefined; }
}
const iconSrc = (i) => i || '';

// ---------- list ----------
function renderList() {
  const ul = $('#serverList');
  const items = [...state.servers.values()];
  $('#emptyHint').hidden = items.length > 0;
  ul.innerHTML = items.map((s) => `
    <li data-id="${esc(s.id)}" class="${s.id === state.sel ? 'sel' : ''}">
      <img src="${iconSrc(s.icon)}" alt="">
      <div><div class="nm">${esc(s.name)}</div>
      <div class="sub">#${esc(s.id)} · ${esc(s.port)}${s.players != null ? ` · ${s.players}/${s.maxPlayersLive || s.maxPlayers}` : ''}${s.progress ? ` · ${s.progress.percent.toFixed(0)}%` : ''}</div></div>
      <span class="dot ${esc(s.status)}" title="${esc(s.status)}"></span>
    </li>`).join('');
  ul.querySelectorAll('li').forEach((li) => (li.onclick = () => select(li.dataset.id)));
}

async function select(id) {
  stopLog();
  state.sel = id;
  state.consoleBuf = (await run('console', id)) || [];
  renderList();
  renderDetail();
  if (typeof renderSidePanels === 'function') renderSidePanels(id, true);
}

// ---------- detail ----------
const TABS = [['console', 'Console'], ['logs', 'Logs'], ['configs', 'Config Files'], ['settings', 'Settings'], ['automation', 'Automation'], ['backups', 'Backups'], ['files', 'Files']];

function renderDetail() {
  if (state.tab !== 'logs') stopLog();
  const s = state.servers.get(state.sel);
  const d = $('#detail');
  if (!s) { d.innerHTML = '<div class="muted pad center">Select a server</div>'; return; }
  const busy = !!s.pending;
  const running = ['Started', 'Starting', 'Stopping'].includes(s.status);
  d.innerHTML = `
    <div class="dhead">
      <img src="${iconSrc(s.icon)}" alt="">
      <div><h2>${esc(s.name)}</h2>
        <div class="muted">${esc(s.gameName)} · ${esc(s.ip_display)}:${esc(s.port)} · <span class="badge ${esc(s.status)}">${esc(s.status)}${s.progress ? ` ${s.progress.percent.toFixed(1)}% (${(s.progress.done / 2 ** 30).toFixed(1)} / ${(s.progress.total / 2 ** 30).toFixed(1)} GB)` : ''}</span>
        ${s.pid ? ` · PID ${s.pid}` : ''}${s.players != null ? ` · ${s.players}/${s.maxPlayersLive || s.maxPlayers} players` : ''}</div></div>
      <div class="actions">
        <button id="aStart" class="primary" ${running || busy ? 'disabled' : ''}>Start</button>
        <button id="aStop" ${!running || busy ? 'disabled' : ''}>Stop</button>
        <button id="aRestart" ${!running || busy ? 'disabled' : ''}>Restart</button>
        <button id="aInstall" ${running || busy ? 'disabled' : ''}>Install/Verify</button>
        <button id="aUpdate" ${running || busy ? 'disabled' : ''}>Update</button>
        <button id="aFolder">Folder</button>
        <button id="aDelete" class="danger" ${busy ? 'disabled' : ''}>Delete</button>
      </div>
    </div>
    <div class="tabs">${TABS.map(([k, n]) => `<button data-t="${k}" class="${state.tab === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    <div class="tabbody" id="tabbody"></div>`;
  const id = s.id;
  $('#aStart').onclick = async () => { await run('start', id); };
  $('#aStop').onclick = () => run('stop', id);
  $('#aRestart').onclick = () => run('restart', id);
  $('#aInstall').onclick = async () => { toast('Installing...'); if ((await run('install', id)) !== undefined) toast('Install finished'); };
  $('#aUpdate').onclick = async () => {
    const r = await run('checkUpdate', id);
    if (!r) return;
    if (!r.available && r.local) { if (!confirm(`Already latest (build ${r.local}). Update/verify anyway?`)) return; }
    if ((await run('update', id, false)) !== undefined) toast('Update finished');
  };
  $('#aFolder').onclick = () => run('openFolder', id);
  $('#aDelete').onclick = async () => {
    if (!confirm(`Delete server "${s.name}" and its files? This cannot be undone.`)) return;
    await run('remove', id, true);
  };
  d.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { state.tab = b.dataset.t; renderDetail(); }));
  renderTab(s);
}

function renderTab(s) {
  const b = $('#tabbody');
  ({ console: tabConsole, logs: tabLogs, configs: tabConfigs, settings: tabSettings, automation: tabAutomation, backups: tabBackups, files: tabFiles }[state.tab])(b, s);
}

function tabConsole(b, s) {
  b.innerHTML = `<div id="con"><div id="conOut"></div>
    <div class="row"><input id="conIn" placeholder="Type a command and press Enter (not supported by Source/GoldSource engines)"><button id="conSend">Send</button></div></div>`;
  const out = $('#conOut');
  out.textContent = state.consoleBuf.join('\n');
  out.scrollTop = out.scrollHeight;
  const send = async () => { const v = $('#conIn').value; if (!v) return; $('#conIn').value = ''; await run('command', s.id, v); };
  $('#conSend').onclick = send;
  $('#conIn').onkeydown = (e) => { if (e.key === 'Enter') send(); };
}

const PRIOS = ['Idle', 'BelowNormal', 'Normal', 'AboveNormal', 'High', 'RealTime'];
const field = (k, label, s, type = 'text') => `<label>${label}<input data-k="${k}" type="${type}" value="${esc(s[k])}"></label>`;
const check = (k, label, s) => `<label class="check"><input type="checkbox" data-k="${k}" ${s[k] ? 'checked' : ''}> ${label}</label>`;

function bindSave(b, s) {
  const collect = () => {
    const patch = {};
    b.querySelectorAll('[data-k]').forEach((el) => { patch[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; });
    const evo = b.querySelectorAll('[data-evo]');   // per-server Discord event overrides (only when they finished loading)
    if (evo.length) { patch.discordEvents = {}; evo.forEach((el) => { if (el.value) patch.discordEvents[el.dataset.evo] = el.value === 'on'; }); }
    return patch;
  };
  const btn = $('#saveBtn');
  if (btn) btn.onclick = async () => { await run('save', s.id, collect()); toast('Saved'); };
}

function tabSettings(b, s) {
  const game = state.games.find((g) => g.id === s.game) || {};
  b.innerHTML = `
    <h4>Server</h4>
    <div class="grid">
      ${field('name', 'Server name', s)}${field('ip', 'IP address (blank = all)', s)}
      ${field('port', 'Port', s)}${field('queryPort', 'Query port', s)}
      ${field('map', 'Map / World', s)}${field('maxPlayers', 'Max players', s)}
      ${game.gslt ? field('gslt', 'Game Server Login Token (GSLT)', s) : ''}
    </div>
    <label style="margin-top:12px">Start parameters<textarea data-k="param" rows="3">${esc(s.param)}</textarea></label>
    <h4>Process</h4>
    <div class="grid">
      <label>CPU priority<select data-k="cpuPriority">${PRIOS.map((p) => `<option ${p === s.cpuPriority ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
      <label>CPU affinity (bit mask e.g. 1100, blank = all)<input data-k="cpuAffinity" value="${esc(s.cpuAffinity)}"></label>
    </div>
    <h4>Network</h4>
    <div class="row"><button id="fwOn">Open firewall ports</button><button id="fwOff">Remove firewall rules</button>
    <span class="muted">Needs the app to run as Administrator.</span></div>
    <div class="row end"><button id="saveBtn" class="primary">Save</button></div>`;
  bindSave(b, s);
  $('#fwOn').onclick = async () => { const r = await run('firewall', s.id, true); if (r) toast(r.message || 'Done', !r.ok); };
  $('#fwOff').onclick = async () => { await run('firewall', s.id, false); toast('Firewall rules removed'); };
}

function tabAutomation(b, s) {
  b.innerHTML = `
    <h4>Automation</h4>
    <div class="grid">
      ${check('autoStart', 'Auto start with NodeGSM', s)}${check('autoRestart', 'Auto restart on crash', s)}
      ${check('autoUpdate', 'Auto update (checks every 30 min)', s)}${check('updateOnStart', 'Update on start', s)}
      ${check('backupOnStart', 'Backup on start', s)}${check('restartCrontab', 'Restart crontab', s)}
    </div>
    <div class="grid" style="margin-top:10px">${field('crontabFormat', 'Crontab (min hour dom mon dow)', s)}</div>
    <h4>Discord alerts (webhook)</h4>
    ${check('discordAlert', 'Enable Discord alerts', s)}
    <div class="grid" style="margin-top:8px">${field('discordWebhook', 'Webhook URL', s)}${field('discordMessage', 'Custom message', s)}</div>
    <div class="grid" style="margin-top:8px">
      ${check('autoStartAlert', 'Start', s)}${check('autoRestartAlert', 'Auto restart', s)}${check('autoUpdateAlert', 'Auto update', s)}
      ${check('restartCrontabAlert', 'Crontab restart', s)}${check('crashAlert', 'Crash', s)}
    </div>
    <h4>Discord event overrides</h4>
    <p class="muted small" style="margin:0 0 8px">Default follows the global toggles in the Discord view. On / Off overrides them for this server (global and per-server webhook).</p>
    <div class="grid" id="evOverrides"><span class="muted small">Loading ...</span></div>
    <div class="row end"><button id="saveBtn" class="primary">Save</button></div>`;
  bindSave(b, s);
  run('discordInfo').then((info) => {
    const box = $('#evOverrides');
    if (!info || !box) return;
    box.innerHTML = info.events.map((e) => {
      const cur = s.discordEvents && typeof s.discordEvents[e.key] === 'boolean' ? (s.discordEvents[e.key] ? 'on' : 'off') : '';
      return `<label>${esc(e.label)}<select data-evo="${esc(e.key)}"><option value="">Default</option><option value="on" ${cur === 'on' ? 'selected' : ''}>On</option><option value="off" ${cur === 'off' ? 'selected' : ''}>Off</option></select></label>`;
    }).join('');
  });
}

// tabBackups() lives in backupsView.js

async function tabFiles(b, s) {
  let cwd = '';
  b.innerHTML = `<div class="files"><div class="tree" id="tree"></div><div><div class="row"><span id="fpath" class="muted" style="flex:1"></span><button id="fsave" class="primary" disabled>Save file</button></div><textarea id="fileEd" disabled></textarea></div></div>`;
  let openFile = null;
  const load = async (rel) => {
    const items = await run('listDir', s.id, rel);
    if (!items) return;
    cwd = rel;
    items.sort((a, c) => (c.dir - a.dir) || a.name.localeCompare(c.name));
    $('#tree').innerHTML = (rel ? '<div data-up="1">⬆ ..</div>' : '') + items.map((i) => `<div data-n="${esc(i.name)}" data-dir="${i.dir ? 1 : 0}">${i.dir ? '📁' : '📄'} ${esc(i.name)}</div>`).join('');
    $('#tree').querySelectorAll('div').forEach((el) => (el.onclick = async () => {
      if (el.dataset.up) return load(rel.split(/[\\/]/).slice(0, -1).join('/'));
      const next = rel ? `${rel}/${el.dataset.n}` : el.dataset.n;
      if (el.dataset.dir === '1') return load(next);
      const t = await run('readFile', s.id, next);
      if (t === undefined) return;
      openFile = next; $('#fpath').textContent = next; $('#fileEd').value = t; $('#fileEd').disabled = false; $('#fsave').disabled = false;
    }));
  };
  $('#fsave').onclick = async () => { await run('writeFile', s.id, openFile, $('#fileEd').value); toast('File saved'); };
  load('');
}

// ---------- logs tab (live) ----------
const logState = { sid: null, id: null, lines: [], filter: '' };
function stopLog() {
  if (logState.id) api.call('logStop', logState.sid, logState.id).catch(() => {});
  logState.id = null; logState.sid = null; logState.lines = [];
}
const logCls = (l) => (/\b(error|exception|fatal|crash)/i.test(l) ? 'lerr' : /\bwarn/i.test(l) ? 'lwarn' : '');
function paintLog() {
  const out = $('#logOut'); if (!out) return;
  const f = logState.filter.toLowerCase();
  const lines = f ? logState.lines.filter((l) => l.toLowerCase().includes(f)) : logState.lines;
  out.innerHTML = lines.map((l) => `<div class="${logCls(l)}">${esc(l)}</div>`).join('');
  if (!$('#logPause').checked) out.scrollTop = out.scrollHeight;
  $('#logCount').textContent = `${lines.length} lines`;
}
async function tabLogs(b, s) {
  const list = (await run('logsList', s.id)) || [];
  if (!list.length) { b.innerHTML = '<p class="muted">This game plugin does not declare any log files. Plugin authors can add a <code>logs</code> list to plugin.json.</p>'; return; }
  b.innerHTML = `<div class="split"><div class="tree" id="logList">${list.map((l) => `<div data-l="${esc(l.id)}"><b>${esc(l.name)}</b><br><span class="muted small">${l.file ? esc(l.file) : 'not found yet'}</span></div>`).join('')}</div>
    <div class="view"><div class="row"><input id="logFilter" placeholder="Filter lines..."><label class="check"><input type="checkbox" id="logPause"> Pause</label><button id="logClear">Clear</button><span id="logCount" class="muted"></span></div>
    <div id="logFile" class="muted small"></div><div id="logOut" class="logout"></div></div></div>`;
  const open = async (id) => {
    stopLog();
    const r = await run('logStart', s.id, id);
    if (!r) return;
    Object.assign(logState, { sid: s.id, id, lines: r.lines });
    $('#logFile').textContent = r.file ? `Following ${r.file}` : 'Waiting for the file to appear ...';
    b.querySelectorAll('#logList div').forEach((d) => d.classList.toggle('sel', d.dataset.l === id));
    paintLog();
  };
  b.querySelectorAll('#logList div').forEach((d) => (d.onclick = () => open(d.dataset.l)));
  $('#logFilter').oninput = (e) => { logState.filter = e.target.value; paintLog(); };
  $('#logClear').onclick = () => { logState.lines = []; paintLog(); };
  open(list[0].id);
}

// ---------- config files tab (INI / JSON / ... declared by the plugin) ----------
async function tabConfigs(b, s) {
  const list = (await run('configList', s.id)) || [];
  if (!list.length) { b.innerHTML = '<p class="muted">This game plugin does not declare config files. Use the <b>Files</b> tab, or ask the plugin author to add a <code>configs</code> list.</p>'; return; }
  b.innerHTML = `<div class="split"><div class="tree" id="cfgList">${list.map((c) => `<div data-c="${esc(c.id)}"><b>${esc(c.name)}</b> <span class="badge">${esc(c.format)}</span><br><span class="muted small">${esc(c.path)}${c.exists ? '' : ' - missing'}</span></div>`).join('')}</div>
    <div class="view"><div id="cfgHead" class="muted">Select a config file</div>
    <div class="row"><button id="cfgSave" class="primary" disabled>Save</button><button id="cfgReload" disabled>Reload</button><button id="cfgFmt" hidden>Format JSON</button><button id="cfgCreate" hidden>Create file</button><span id="cfgStatus" class="muted"></span></div>
    <textarea id="cfgEd" spellcheck="false" disabled></textarea></div></div>`;
  let cur = null; let dirty = false;
  const ed = $('#cfgEd');
  const status = (t, bad) => { const e = $('#cfgStatus'); e.textContent = t; e.style.color = bad ? 'var(--bad)' : ''; };
  const check = () => {
    if (!cur || cur.format !== 'json') return;
    try { JSON.parse(ed.value); status('Valid JSON'); } catch (e) { status(`Invalid JSON: ${e.message}`, true); }
  };
  const load = async (id) => {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    const c = await run('configRead', s.id, id);
    if (!c) return;
    const def = list.find((x) => x.id === id);
    cur = c; dirty = false;
    b.querySelectorAll('#cfgList div').forEach((d) => d.classList.toggle('sel', d.dataset.c === id));
    $('#cfgHead').innerHTML = `<b>${esc(c.name)}</b> · ${esc(c.path)}${def.description ? ' · ' + esc(def.description) : ''}`;
    ed.value = c.text; ed.disabled = !c.exists;
    $('#cfgSave').disabled = true; $('#cfgReload').disabled = false;
    $('#cfgCreate').hidden = c.exists; $('#cfgFmt').hidden = !(c.format === 'json' && c.exists);
    status(c.exists ? '' : 'File does not exist yet (the game may create it on first start).');
    check();
  };
  const save = async () => {
    if (!cur || ed.disabled) return;
    if ((await run('configWrite', s.id, cur.id, ed.value)) !== undefined) { dirty = false; $('#cfgSave').disabled = true; status('Saved (previous version kept as .bak)'); }
  };
  ed.oninput = () => { dirty = true; $('#cfgSave').disabled = false; check(); };
  ed.onkeydown = (e) => { if (e.ctrlKey && e.key === 's') { e.preventDefault(); save(); } };
  $('#cfgSave').onclick = save;
  $('#cfgReload').onclick = () => { dirty = false; load(cur.id); };
  $('#cfgFmt').onclick = () => { try { ed.value = JSON.stringify(JSON.parse(ed.value), null, 2) + '\n'; dirty = true; $('#cfgSave').disabled = false; check(); } catch (e) { status(`Invalid JSON: ${e.message}`, true); } };
  $('#cfgCreate').onclick = async () => { if ((await run('configCreate', s.id, cur.id)) !== undefined) { dirty = false; await load(cur.id); } };
  b.querySelectorAll('#cfgList div').forEach((d) => (d.onclick = () => load(d.dataset.c)));
  load(list[0].id);
}

// ---------- add dialog ----------
function openAdd(pre) {
  state.pickGame = typeof pre === 'string' ? pre : null;
  $('#addName').value = state.pickGame ? (state.games.find((g) => g.id === state.pickGame) || {}).name || '' : ''; $('#addDir').value = ''; $('#addFilter').value = '';
  renderGamePick();
  $('#dlgAdd').showModal();
}
function renderGamePick() {
  const f = $('#addFilter').value.toLowerCase();
  $('#gamePick').innerHTML = state.games.filter((g) => g.name.toLowerCase().includes(f)).map((g) =>
    `<div data-g="${g.id}" class="${state.pickGame === g.id ? 'sel' : ''}"><img src="${iconSrc(g.icon)}" alt=""><span>${esc(g.name)}</span></div>`).join('');
  $('#gamePick').querySelectorAll('div').forEach((d) => (d.onclick = () => {
    state.pickGame = d.dataset.g;
    if (!$('#addName').value) $('#addName').value = state.games.find((g) => g.id === d.dataset.g).name;
    renderGamePick();
  }));
}

$('#btnAdd').onclick = () => openAdd();
$('#addCancel').onclick = () => $('#dlgAdd').close();
$('#addFilter').oninput = renderGamePick;
$('#addMode').onchange = () => { $('#addDirRow').hidden = $('#addMode').value !== 'import'; };
$('#addBrowse').onclick = async () => { const p = await run('pickFolder'); if (p) $('#addDir').value = p; };
$('#addForm').onsubmit = async (e) => {
  e.preventDefault();
  if (!state.pickGame) return toast('Pick a game first', true);
  const mode = $('#addMode').value; const name = $('#addName').value.trim();
  $('#dlgAdd').close();
  if (mode === 'import') {
    const dir = $('#addDir').value;
    if (!dir) return toast('Choose a folder to import', true);
    const v = await run('import', state.pickGame, name, dir);
    if (v) { state.servers.set(v.id, v); select(v.id); toast('Server imported'); }
  } else {
    const v = await run('create', state.pickGame, name);
    if (!v) return;
    state.servers.set(v.id, v); await select(v.id); state.tab = 'console'; renderDetail();
    toast('Installing - watch the console');
    if ((await run('install', v.id)) !== undefined) toast('Install finished');
  }
};

// ---------- app settings ----------
// ---------- game browser (all games are plugins) ----------
function md(src) {
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, a, u) => `<a href="#" data-url="${u}">${a}</a>`).replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  const lines = String(src).replace(/\r/g, '').split('\n');
  let html = ''; let list = false; let rows = [];
  const endList = () => { if (list) { html += '</ul>'; list = false; } };
  const endTable = () => {
    if (!rows.length) return;
    const sep = rows.length > 1 && /^[\s|:-]+$/.test(rows[1]);
    html += '<table>' + rows.filter((r, i) => !(sep && i === 1)).map((r, i) => '<tr>' + r.replace(/^\||\|$/g, '').split('|').map((c) => `<${sep && i === 0 ? 'th' : 'td'}>${inline(c.trim())}</${sep && i === 0 ? 'th' : 'td'}>`).join('') + '</tr>').join('') + '</table>';
    rows = [];
  };
  for (const l of lines) {
    if (/^\s*\|/.test(l)) { endList(); rows.push(l.trim()); continue; }
    endTable();
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(l))) { endList(); html += `<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`; }
    else if ((m = /^\s*[-*]\s+(.*)$/.exec(l))) { if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(m[1])}</li>`; }
    else if (!l.trim()) endList();
    else { endList(); html += `<p>${inline(l)}</p>`; }
  }
  endList(); endTable();
  return html;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-url]');
  if (a) { e.preventDefault(); run('openExternal', a.dataset.url); }
});

state.gbSel = null;
async function renderBrowser() {
  const info = (await run('pluginsInfo')) || { loaded: [], errors: [] };
  $('#gbErr').innerHTML = info.errors.map((e) => `<div class="err">Plugin "${esc(e.folder)}" failed to load: ${esc(e.error)}</div>`).join('');
  const q = $('#gbSearch').value.toLowerCase();
  const items = state.games.filter((g) => `${g.name} ${(g.tags || []).join(' ')} ${g.description || ''}`.toLowerCase().includes(q));
  $('#gbCount').textContent = `${items.length} of ${state.games.length} games`;
  $('#gbList').innerHTML = items.map((g) => `<div data-g="${esc(g.id)}" class="${state.gbSel === g.id ? 'sel' : ''}"><img src="${iconSrc(g.icon)}" alt=""><div><b>${esc(g.name)}</b>
    <div class="muted small">${g.source === 'user' ? (g.overrides ? 'Local override' : 'Installed plugin') : 'Built-in'} · v${esc(g.version || '?')}</div></div></div>`).join('');
  $('#gbList').querySelectorAll('[data-g]').forEach((d) => (d.onclick = () => showDetail(d.dataset.g)));
}
function docsHtml(docs) {
  if (!docs || !docs.length) return '<h4>Documentation</h4><p class="muted">No documentation links yet - add some with a pull request.</p>';
  const group = (type, label) => {
    const items = docs.filter((x) => x.type === type);
    return items.length ? `<div class="docgroup"><span class="badge ${type}">${label}</span><ul>${items.map((x) => `<li><a href="#" data-url="${esc(x.url)}">${esc(x.title)}</a>${x.description ? ` <span class="muted">- ${esc(x.description)}</span>` : ''}</li>`).join('')}</ul></div>` : '';
  };
  return `<h4>Documentation</h4>${group('official', 'Official')}${group('unofficial', 'Unofficial')}`;
}
async function showDetail(id) {
  const d = await run('pluginDetail', id);
  if (!d) return;
  state.gbSel = id;
  $('#gbList').querySelectorAll('[data-g]').forEach((x) => x.classList.toggle('sel', x.dataset.g === id));
  const list = (arr, fn) => (arr.length ? `<ul>${arr.map(fn).join('')}</ul>` : '<p class="muted">None declared.</p>');
  $('#gbDetail').innerHTML = `${d.banner ? `<img class="banner" src="${d.banner}" alt="">` : ''}
    <div class="dhead nopad"><img src="${d.icon || ''}" alt=""><div><h2>${esc(d.name)}</h2>
      <div class="muted">by ${esc(d.author || 'unknown')} · v${esc(d.version || '?')} · ${d.source === 'user' ? (d.overrides ? 'local override of a built-in plugin' : 'installed plugin') : 'built-in'}</div>
      <div>${(d.tags || []).map((t) => `<span class="badge">${esc(t)}</span>`).join(' ')}</div></div>
      <div class="actions"><button class="primary" id="gbAdd">Add server</button>${/^https?:/.test(d.url) ? `<a href="#" data-url="${esc(d.url)}"><button>Open link</button></a>` : ''}</div></div>
    <p>${esc(d.description)}</p>
    ${docsHtml(d.docs)}
    <h4>Defaults</h4><table><tr><td>Steam app</td><td>${esc(d.appId || '-')}</td><td>Game port</td><td>${esc(d.port || '-')}</td></tr>
      <tr><td>Query</td><td>${esc(d.query || 'none')}</td><td>Query port</td><td>${esc(d.queryPort || '-')}</td></tr></table>
    <h4>Config files (${d.configs.length})</h4>${list(d.configs, (c) => `<li><b>${esc(c.name)}</b> <span class="badge">${esc(c.format || 'text')}</span> <code>${esc(c.path)}</code></li>`)}
    <h4>Live logs (${d.logs.length})</h4>${list(d.logs, (c) => `<li><b>${esc(c.name)}</b> <code>${esc(c.path)}</code></li>`)}
    ${d.screenshots.length ? `<h4>Screenshots</h4><div class="shots">${d.screenshots.map((x) => `<img src="${x}" alt="">`).join('')}</div>` : ''}
    <h4>README</h4><div class="md">${d.readme ? md(d.readme) : '<p class="muted">No README.</p>'}</div>`;
  $('#gbAdd').onclick = () => openAdd(id);
  $('#gbDetail').querySelectorAll('.shots img').forEach((im) => (im.onclick = () => im.classList.toggle('zoom')));
}
async function afterPluginChange(msg) {
  state.games = (await run('games')) || state.games;
  await renderBrowser();
  if (msg) toast(msg);
}
$('#gbSearch').oninput = renderBrowser;
$('#plZip').onclick = async () => { const id = await run('pluginsInstallZip'); if (id) await afterPluginChange(`Plugin "${id}" installed`); };
$('#plFolder').onclick = async () => { const id = await run('pluginsInstallFolder'); if (id) await afterPluginChange(`Plugin "${id}" installed`); };
$('#plReload').onclick = async () => { await run('pluginsReload'); await afterPluginChange('Plugins reloaded'); };
$('#plOpen').onclick = () => run('pluginsFolder');

// ---------- app settings: appearance + startup ----------
const ACCENTS = [['Blue', '#4f8cff'], ['Cyan', '#1fb6d9'], ['Teal', '#1abc9c'], ['Green', '#2ecc71'], ['Lime', '#8bc34a'], ['Amber', '#f5a623'],
  ['Orange', '#ff7a45'], ['Red', '#e74c3c'], ['Pink', '#e84393'], ['Purple', '#9b59b6'], ['Indigo', '#6c5ce7']];
const sysLight = window.matchMedia('(prefers-color-scheme: light)');
let appSettings = { theme: 'dark', accent: '#4f8cff', animations: true };

function applyAppearance(s) {
  appSettings = { ...appSettings, ...s };
  const r = document.documentElement;
  const theme = s.theme === 'system' ? (sysLight.matches ? 'light' : 'dark') : s.theme === 'light' ? 'light' : 'dark';
  r.dataset.theme = theme;
  r.dataset.anim = s.animations === false ? 'off' : 'on';
  if (/^#[0-9a-f]{6}$/i.test(s.accent || '')) r.style.setProperty('--accent', s.accent);
  if (typeof applyShell === 'function') applyShell(s);
  try { localStorage.setItem('nodegsm.appearance', JSON.stringify({ theme: s.theme, accent: s.accent, animations: s.animations })); } catch { /* private mode */ }
}
sysLight.addEventListener('change', () => { if (appSettings.theme === 'system') applyAppearance(appSettings); });

async function saveSetting(patch) {
  const s = await run('saveSettings', patch);
  if (s) applyAppearance(s);
  return s;
}
function paintSettings(s) {
  document.querySelectorAll('#setTheme button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.theme));
  const known = ACCENTS.some(([, h]) => h.toLowerCase() === s.accent);
  $('#setAccent').innerHTML = ACCENTS.map(([n, h]) => `<button type="button" class="swatch ${h.toLowerCase() === s.accent ? 'on' : ''}" title="${n}" data-h="${h}" style="background:${h}"></button>`).join('')
    + `<input type="color" id="setAccentCustom" title="Custom colour" value="${s.accent}" class="${known ? '' : 'on'}">`;
  $('#setAccent').querySelectorAll('.swatch').forEach((b) => (b.onclick = async () => paintSettings(await saveSetting({ accent: b.dataset.h }) || s)));
  $('#setAccentCustom').onchange = async (e) => paintSettings(await saveSetting({ accent: e.target.value }) || s);
  $('#setAnim').checked = s.animations !== false; $('#setHw').checked = s.hardwareAcceleration !== false;
  paintHeaderStatChecks(s);
  $('#setLogin').checked = !!s.startOnLogin; $('#setTray').checked = !!s.minimizeToTray; $('#setCrash').checked = !!s.autoRestartApp;
}
document.querySelectorAll('#setTheme button').forEach((b) => (b.onclick = async () => { const s = await saveSetting({ theme: b.dataset.v }); if (s) paintSettings(s); }));
$('#setAnim').onchange = (e) => saveSetting({ animations: e.target.checked });
$('#setHw').onchange = async (e) => { await saveSetting({ hardwareAcceleration: e.target.checked }); $('#hwNote').hidden = false; };
$('#setLogin').onchange = (e) => saveSetting({ startOnLogin: e.target.checked });
$('#setTray').onchange = (e) => saveSetting({ minimizeToTray: e.target.checked });
$('#setCrash').onchange = (e) => saveSetting({ autoRestartApp: e.target.checked });
$('#setRestart').onclick = () => { if (confirm('Restart NodeGSM now? Running servers will be stopped first.')) run('relaunch'); };
/** Settings view: refresh every control from the saved settings (called when the view opens). */
async function openSettingsView() {
  const s = (await run('settings')) || appSettings;
  $('#hwNote').hidden = true;
  paintSettings(s);
  renderColChecks($('#setCols'));
}

// ---------- events ----------
api.on('status', (v) => {
  state.servers.set(v.id, v);
  renderList();
  renderTables();
  renderHeaderStats();
  if (typeof renderSidePanels === 'function') renderSidePanels(v.id);
  if (v.id === state.sel) {
    // avoid wiping unsaved form edits: only re-render header-ish when not on a form tab
    if (state.tab === 'console') { const keep = state.consoleBuf; renderDetail(); state.consoleBuf = keep; }
    else patchHeader(v);
  }
});
function patchHeader(v) {
  const running = ['Started', 'Starting', 'Stopping'].includes(v.status); const busy = !!v.pending;
  const set = (id, dis) => { const e = $(id); if (e) e.disabled = dis; };
  set('#aStart', running || busy); set('#aStop', !running || busy); set('#aRestart', !running || busy);
  set('#aInstall', running || busy); set('#aUpdate', running || busy);
  const b = document.querySelector('.dhead .badge'); if (b) { b.textContent = v.status; b.className = `badge ${v.status}`; }
}
api.on('console', ({ id, line }) => {
  if (id !== state.sel) return;
  state.consoleBuf.push(line);
  if (state.consoleBuf.length > 2000) state.consoleBuf.shift();
  const out = $('#conOut');
  if (out) {
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    out.textContent += (out.textContent ? '\n' : '') + line;
    if (atBottom) out.scrollTop = out.scrollHeight;
  }
});
api.on('logLines', ({ id, logId, reset, file, lines }) => {
  if (id !== logState.sid || logId !== logState.id || state.tab !== 'logs') return;
  if (reset) logState.lines = [];
  logState.lines.push(...lines);
  if (logState.lines.length > 5000) logState.lines.splice(0, logState.lines.length - 5000);
  if (file && $('#logFile')) $('#logFile').textContent = `Following ${file}`;
  paintLog();
});
api.on('removed', (id) => {
  state.servers.delete(id);
  if (state.sel === id) state.sel = null;
  renderList(); renderDetail(); renderTables(); renderHeaderStats();
  if (typeof renderSidePanels === 'function') renderSidePanels();
});

const STAT_LABELS = [['cpu', 'CPU'], ['ram', 'RAM'], ['disk', 'Disk'], ['servers', 'Servers (running/total)'], ['players', 'Players'], ['tick', 'Tick']];
function paintHeaderStatChecks(s) {
  const hs = { ...(appSettings.headerStats || {}), ...(s.headerStats || {}) };
  $('#setStats').innerHTML = STAT_LABELS.map(([k, n]) => `<label class="check"><input type="checkbox" data-stat="${k}" ${hs[k] ? 'checked' : ''}> ${n}</label>`).join('');
  $('#setStats').querySelectorAll('input[data-stat]').forEach((i) => (i.onchange = async () => {
    await saveSetting({ headerStats: { ...(appSettings.headerStats || {}), [i.dataset.stat]: i.checked } });
    renderHeaderStats();
  }));
}

/** Header info bar: what shows is chosen by settings.headerStats. Values come from the main-process metrics + live server state. */
function renderHeaderStats() {
  const hs = appSettings.headerStats || {}; const m = state.sys; const sys = dash.snap && dash.snap.system;
  const items = [];
  if (hs.cpu) items.push(['CPU', sys ? `${sys.cpuPercent.toFixed(0)}%` : m ? `${m.cpuCount} cores` : '-']);
  if (hs.ram) {
    if (sys) items.push(['RAM', `${((sys.memUsed / sys.memTotal) * 100).toFixed(0)}% of ${(sys.memTotal / 2 ** 30).toFixed(0)} GB`]);
    else if (m) items.push(['RAM', `${((1 - m.mem.free / m.mem.total) * 100).toFixed(0)}% of ${(m.mem.total / 2 ** 30).toFixed(0)} GB`]);
    else items.push(['RAM', '-']);
  }
  if (hs.disk) items.push(['Disk', sys && sys.disk ? `${((sys.disk.used / sys.disk.total) * 100).toFixed(0)}% (${sys.disk.drive})` : '-']);
  const all = [...state.servers.values()];
  if (hs.servers) items.push(['Servers', `${all.filter((v) => v.status === 'Started').length}/${all.length}`]);
  if (hs.players) items.push(['Players', String(all.reduce((n, v) => n + (v.players || 0), 0))]);
  if (hs.tick) items.push(['Tick', '-']);   // filled in once servers report a tick rate (planned)
  $('#metrics').innerHTML = items.map(([k, v]) => `<span class="stat"><span class="k">${k}</span> ${esc(v)}</span>`).join('');
}
async function refreshMetrics() {
  const m = await api.call('metrics').catch(() => null);
  if (m) state.sys = m;
  renderHeaderStats();
}

async function init() {
  const st = await run('settings'); if (st) applyAppearance(st);
  const ms = await run('metricsState'); if (ms) { dash.snap = ms.snapshot; dash.history = ms.history; }
  state.games = (await run('games')) || [];
  for (const s of (await run('list')) || []) state.servers.set(s.id, s);
  renderList();
  viewHooks.plugins = renderBrowser; viewHooks.settings = openSettingsView;
  refreshMetrics(); setInterval(refreshMetrics, 5000);
  await setView((st && st.view) || 'servers');
  if (state.servers.size) select([...state.servers.keys()][0]);
}
window.addEventListener('DOMContentLoaded', init);
