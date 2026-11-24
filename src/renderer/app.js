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
const iconSrc = (i) => (!i ? '' : i.startsWith('data:') ? i : `../../assets/games/${i}.png`);

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
  state.sel = id;
  state.consoleBuf = (await run('console', id)) || [];
  renderList();
  renderDetail();
}

// ---------- detail ----------
const TABS = [['console', 'Console'], ['settings', 'Settings'], ['automation', 'Automation'], ['backups', 'Backups'], ['files', 'Files']];

function renderDetail() {
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
  ({ console: tabConsole, settings: tabSettings, automation: tabAutomation, backups: tabBackups, files: tabFiles }[state.tab])(b, s);
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
    <div class="row end"><button id="saveBtn" class="primary">Save</button></div>`;
  bindSave(b, s);
}

async function tabBackups(b, s) {
  const list = (await run('backups', s.id)) || [];
  b.innerHTML = `<div class="row"><button id="bkNow" class="primary">Backup now</button></div>
    <table style="margin-top:12px"><tr><th>File</th><th>Size</th><th>Date</th><th></th></tr>
    ${list.map((f) => `<tr><td>${esc(f.file)}</td><td>${(f.size / 1048576).toFixed(1)} MB</td><td>${new Date(f.time).toLocaleString()}</td>
      <td><button data-r="${esc(f.file)}">Restore</button> <button class="danger" data-d="${esc(f.file)}">Delete</button></td></tr>`).join('')}
    </table>${list.length ? '' : '<p class="muted">No backups yet.</p>'}`;
  $('#bkNow').onclick = async () => { toast('Backing up...'); await run('backup', s.id); toast('Backup complete'); renderDetail(); };
  b.querySelectorAll('[data-r]').forEach((x) => (x.onclick = async () => {
    if (!confirm('Restore this backup? Current files will be overwritten (server will be stopped).')) return;
    await run('restore', s.id, x.dataset.r); toast('Restored');
  }));
  b.querySelectorAll('[data-d]').forEach((x) => (x.onclick = async () => { await run('deleteBackup', s.id, x.dataset.d); renderDetail(); }));
}

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

// ---------- add dialog ----------
function openAdd() {
  state.pickGame = null;
  $('#addName').value = ''; $('#addDir').value = ''; $('#addFilter').value = '';
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

$('#btnAdd').onclick = openAdd;
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
// ---------- plugins ----------
async function renderPlugins() {
  const info = (await run('pluginsInfo')) || { loaded: [], errors: [] };
  $('#plList').innerHTML = info.loaded.length
    ? '<table><tr><th>Plugin</th><th>Author</th><th>Version</th></tr>' + info.loaded.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.author || '')}</td><td>${esc(p.version || '')}</td></tr>`).join('') + '</table>'
    : '<p class="muted">No plugins installed.</p>';
  $('#plErr').innerHTML = info.errors.map((e) => `<div class="err">${esc(e.folder)}: ${esc(e.error)}</div>`).join('');
}
async function afterPluginChange(msg) {
  state.games = (await run('games')) || state.games;
  await renderPlugins();
  if (msg) toast(msg);
}
$('#btnPlugins').onclick = async () => { await renderPlugins(); $('#dlgPlugins').showModal(); };
$('#plClose').onclick = () => $('#dlgPlugins').close();
$('#plZip').onclick = async () => { const id = await run('pluginsInstallZip'); if (id) await afterPluginChange(`Plugin "${id}" installed`); };
$('#plFolder').onclick = async () => { const id = await run('pluginsInstallFolder'); if (id) await afterPluginChange(`Plugin "${id}" installed`); };
$('#plReload').onclick = async () => { await run('pluginsReload'); await afterPluginChange('Plugins reloaded'); };
$('#plOpen').onclick = () => run('pluginsFolder');

$('#btnSettings').onclick = async () => {
  const s = (await run('settings')) || {};
  $('#setLogin').checked = !!s.startOnLogin; $('#setTray').checked = !!s.minimizeToTray;
  $('#dlgSettings').showModal();
};
$('#setCancel').onclick = () => $('#dlgSettings').close();
$('#dlgSettings form').onsubmit = async () => {
  await run('saveSettings', { startOnLogin: $('#setLogin').checked, minimizeToTray: $('#setTray').checked });
  toast('Settings saved');
};

// ---------- events ----------
api.on('status', (v) => {
  state.servers.set(v.id, v);
  renderList();
  if (v.id === state.sel) {
    // avoid wiping unsaved form edits: only re-render header-ish when not on a form tab
    if (['console', 'backups'].includes(state.tab)) { const keep = state.consoleBuf; renderDetail(); state.consoleBuf = keep; }
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
api.on('removed', (id) => {
  state.servers.delete(id);
  if (state.sel === id) state.sel = null;
  renderList(); renderDetail();
});

async function refreshMetrics() {
  const m = await api.call('metrics').catch(() => null);
  if (!m) return;
  const used = (1 - m.mem.free / m.mem.total) * 100;
  $('#metrics').textContent = `${m.cpuCount} CPUs · RAM ${used.toFixed(0)}% of ${(m.mem.total / 2 ** 30).toFixed(0)} GB · ${state.servers.size} servers`;
}

(async function init() {
  state.games = (await run('games')) || [];
  for (const s of (await run('list')) || []) state.servers.set(s.id, s);
  renderList();
  refreshMetrics(); setInterval(refreshMetrics, 5000);
  if (state.servers.size) select([...state.servers.keys()][0]);
})();
