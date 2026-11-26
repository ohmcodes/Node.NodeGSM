'use strict';
const api = window.wgsm;
// 'desktop' (Electron preload) or 'web' (transport-web.js); desktop-only controls carry class "desktop-only" and are hidden in web mode (styles.css)
document.documentElement.dataset.mode = api.mode || 'desktop';
const isWeb = () => api.mode === 'web';
/** Open an http(s) link: through the main process on desktop, in a new tab in web mode. */
function openLink(u) { if (!/^https?:\/\//i.test(String(u))) return; if (isWeb()) window.open(String(u), '_blank', 'noopener,noreferrer'); else run('openExternal', u); }
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { platform: 'windows', features: {}, games: [], servers: new Map(), sel: null, tab: 'console', consoleBuf: [], pickGame: null };

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
  if (typeof stopConsoleLog === 'function') stopConsoleLog();
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
  if (state.tab !== 'console' && typeof stopConsoleLog === 'function') stopConsoleLog();
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
        <button id="aUpdate" ${running || busy ? 'disabled' : ''} title="Download the newest version of the game">Update</button>
        <button id="aValidate" ${running || busy ? 'disabled' : ''} title="Re-check every game file against the source and repair broken ones (slower than Update)">Validate</button>
        <button id="aFolder" class="desktop-only">Folder</button>
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
  $('#aValidate').onclick = async () => {
    if (!confirm('Validate re-checks every game file and re-downloads damaged or modified ones. It can take a long time for big games and may overwrite edited game files (configs are normally kept).\n\nRunning servers are stopped first. Continue?')) return;
    toast('Validating - watch the console');
    if ((await run('update', id, true)) !== undefined) toast('Validate finished');
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

// tabConsole() lives in consolesView.js

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
    <h4>Scheduled commands</h4>
    <div id="rcSched"><span class="muted small">Loading ...</span></div>
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
  rconSchedBlock($('#rcSched'), s);
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
  b.innerHTML = `<div class="filesPage"><div class="files"><div class="treewrap"><div class="row"><button id="acHere" title="Delete old files in the open folder on a schedule">Auto-clear this folder...</button></div><div class="tree" id="tree"></div></div><div><div class="row"><span id="fpath" class="muted" style="flex:1"></span><button id="fsave" class="primary" disabled>Save file</button></div><textarea id="fileEd" disabled></textarea></div></div><div id="acPanel"></div></div>`;
  let openFile = null;
  const load = async (rel) => {
    const items = await run('listDir', s.id, rel);
    if (!items) return;
    cwd = rel;
    items.sort((a, c) => (c.dir - a.dir) || a.name.localeCompare(c.name));
    $('#tree').innerHTML = (rel ? '<div data-up="1">⬆ ..</div>' : '') + items.map((i) => `<div data-n="${esc(i.name)}" data-dir="${i.dir ? 1 : 0}">${i.dir ? '📁' : '📄'} ${esc(i.name)}</div>`).join('');
    $('#tree').querySelectorAll('div').forEach((el) => { if (el.dataset.dir === '1') el.oncontextmenu = (e) => { e.preventDefault(); acDialog(rel ? `${rel}/${el.dataset.n}` : el.dataset.n); }; });
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
  $('#acHere').onclick = () => { if (!cwd) return toast('Open a folder first (auto-clear works on one folder at a time)', true); acDialog(cwd); };
  load('');
  acMount(s);
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

// tabConfigs() lives in configsView.js (shared with the Configs screen)

// ---------- add dialog ----------
const platformName = () => ({ windows: 'Windows', linux: 'Linux', macos: 'macOS' }[state.platform] || state.platform || 'this system');
function openAdd(pre) {
  state.pickGame = typeof pre === 'string' ? pre : null;
  $('#addName').value = state.pickGame ? (state.games.find((g) => g.id === state.pickGame) || {}).name || '' : ''; $('#addDir').value = ''; $('#addFilter').value = '';
  renderGamePick();
  $('#dlgAdd').showModal();
}
function renderGamePick() {
  const f = $('#addFilter').value.toLowerCase();
  $('#gamePick').innerHTML = state.games.filter((g) => g.name.toLowerCase().includes(f)).map((g) =>
    `<div data-g="${g.id}" class="${state.pickGame === g.id ? 'sel' : ''}${g.supported === false ? ' unsupported' : ''}"${g.supported === false ? ` title="Not available on ${esc(platformName())}"` : ''}><img src="${iconSrc(g.icon)}" alt=""><span>${esc(g.name)}${g.supported === false ? ' <span class="badge nap">not available on this platform</span>' : ''}</span></div>`).join('');
  $('#gamePick').querySelectorAll('div').forEach((d) => (d.onclick = () => {
    const g = state.games.find((x) => x.id === d.dataset.g);
    if (g && g.supported === false) return toast(`${g.name} is not available on this platform (${platformName()}). Supported: ${(g.platforms || []).join(', ')}.`, true);
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
  if (a) { e.preventDefault(); openLink(a.dataset.url); }
});

state.gbSel = null;
async function renderBrowser() {
  const info = (await run('pluginsInfo')) || { loaded: [], errors: [] };
  $('#gbErr').innerHTML = info.errors.map((e) => `<div class="err">Plugin "${esc(e.folder)}" failed to load: ${esc(e.error)}</div>`).join('');
  const q = $('#gbSearch').value.toLowerCase();
  const items = state.games.filter((g) => `${g.name} ${(g.tags || []).join(' ')} ${g.description || ''}`.toLowerCase().includes(q));
  $('#gbCount').textContent = `${items.length} of ${state.games.length} games`;
  $('#gbList').innerHTML = items.map((g) => `<div data-g="${esc(g.id)}" class="${state.gbSel === g.id ? 'sel' : ''}"><img src="${iconSrc(g.icon)}" alt=""><div><b>${esc(g.name)}</b>
    <div class="muted small">${g.source === 'user' ? (g.overrides ? 'Local override' : 'Installed plugin') : 'Built-in'} · v${esc(g.version || '?')}${g.supported === false ? ' <span class="badge nap">not available on this platform</span>' : ''}</div></div></div>`).join('');
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
      <div>${(d.tags || []).map((t) => `<span class="badge">${esc(t)}</span>`).join(' ')} ${(d.platforms || ['windows']).map((p) => `<span class="badge plat${p === state.platform ? ' here' : ''}">${esc(p)}</span>`).join(' ')}${d.supported === false ? ' <span class="badge nap">not available on this platform</span>' : ''}</div></div>
      <div class="actions"><button class="primary" id="gbAdd" ${d.supported === false ? 'disabled title="Not available on this platform"' : ''}>Add server</button>${/^https?:/.test(d.url) ? `<a href="#" data-url="${esc(d.url)}"><button>Open link</button></a>` : ''}</div></div>
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

// ---------- plugin catalogue (the plugin list lives in its own repository; see src/main/catalogue.js) ----------
// The list is downloaded once and cached; "Refresh" forces a new check, otherwise it is re-checked at most once a day.
state.cat = null;
const catIcon = (cat, p) => (cat.url && /^https?:/i.test(cat.url) && p.icon ? new URL(p.icon, cat.url).href : '');
async function showCatalogue(refresh) {
  const box = $('#gbDetail');
  box.innerHTML = '<p class="muted">Loading the catalogue...</p>';
  let err = '';
  try { state.cat = refresh === 'force' ? await run('catalogueRefresh', true) : await run('catalogueState'); if (state.cat && (state.cat.stale || !state.cat.count) && refresh !== 'force') state.cat = await run('catalogueRefresh', false); }
  catch (e) { err = e.message || String(e); try { state.cat = await run('catalogueState'); } catch { /* keep */ } }
  renderCatalogue(err);
}
function renderCatalogue(err) {
  const cat = state.cat || { plugins: [], count: 0, url: '' };
  const q = (state.catQ || '').toLowerCase();
  const items = cat.plugins.filter((p) => !q || `${p.name} ${p.maker} ${p.summary} ${(p.tags || []).join(' ')}`.toLowerCase().includes(q));
  const when = cat.fetchedAt ? new Date(cat.fetchedAt).toLocaleString() : 'never';
  $('#gbDetail').innerHTML = `<h3 style="margin-top:0">Plugin catalogue</h3>
    <p class="muted small">Games are plugins from the community catalogue. Installed plugins keep working offline. ${cat.count} plugins · last checked ${esc(when)} · <span title="${esc(cat.url || '')}">${esc(cat.url || '')}</span></p>
    ${err ? `<div class="err">${esc(err)}${cat.count ? ' (showing the saved list)' : ''}</div>` : ''}
    <div class="row wrap"><input id="catQ" placeholder="Search the catalogue..." value="${esc(state.catQ || '')}"><button type="button" id="catRefresh">Refresh</button></div>
    <div id="catList">${items.map((p) => `<div class="catrow" data-p="${esc(p.id)}" style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line,#2a2f3f)">
      ${catIcon(cat, p) ? `<img src="${esc(catIcon(cat, p))}" alt="" width="40" height="40" style="border-radius:8px">` : '<span style="width:40px"></span>'}
      <div style="flex:1;min-width:0"><b>${esc(p.name)}</b> <span class="muted small">v${esc(p.version)} · by ${esc(p.maker || 'unknown')}${(p.contributors || []).length ? ' +' + p.contributors.length : ''}${p.hasScript ? ' · script' : ''}</span>
      <div class="muted small">${esc(p.summary)}</div></div>
      <button type="button" data-inst="${esc(p.id)}" class="${p.installed && !p.update ? '' : 'primary'}" ${p.installed && !p.update ? 'disabled' : ''}>${p.update ? 'Update to v' + esc(p.version) : p.installed ? 'Installed' : 'Install'}</button></div>`).join('') || '<p class="muted">Nothing found.</p>'}</div>`;
  $('#catQ').oninput = (e) => { state.catQ = e.target.value; const pos = e.target.selectionStart; renderCatalogue(); const i = $('#catQ'); i.focus(); i.setSelectionRange(pos, pos); };
  $('#catRefresh').onclick = () => showCatalogue('force');
  $('#catList').onclick = async (e) => {
    const b = e.target.closest('[data-inst]'); if (!b) return;
    const p = cat.plugins.find((x) => x.id === b.dataset.inst);
    if (p && p.hasScript && !confirm(`"${p.name}" contains a plugin.js script that runs with full access to this computer. Only install it if you trust ${p.maker || 'its author'}. Install anyway?`)) return;
    b.disabled = true; b.textContent = 'Installing...';
    try { const r = await run('catalogueInstall', b.dataset.inst); state.cat = r.state; await afterPluginChange(`Plugin "${r.id}" installed`); renderCatalogue(); }
    catch (er) { toast(er.message || String(er)); renderCatalogue(er.message || String(er)); }
  };
}
$('#plCatalogue').onclick = () => { state.gbSel = null; showCatalogue(); };

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
// ---------- data location ----------
const gb = (n) => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(2)} GB` : `${(n / 2 ** 20).toFixed(0)} MB`);
async function paintDataLocation() {
  const d = await run('dataLocation'); if (!d) return;
  state.dl = d;
  $('#dlCurrent').textContent = d.current;
  const note = d.envOverride ? 'Set by the NODEGSM_DATA environment variable, so it cannot be changed here.'
    : d.oldFolder ? 'This is the folder used by earlier builds. "Use the standard folder" copies it to the NodeGSM folder; the old one is kept until you delete it.' : '';
  $('#dlNote').textContent = note; $('#dlNote').style.display = note ? 'block' : 'none';
  for (const id of ['#dlChange', '#dlUse', '#dlStd']) $(id).disabled = d.envOverride;
  $('#dlStd').hidden = d.current.toLowerCase() === d.standard.toLowerCase();
  $('#dlStd').title = d.standard;
}
async function moveData(to, mode) {
  const p = await run('dataLocationPlan', to, mode); if (!p) return;
  if (!p.ok) { toast(p.error, true); return; }
  const what = mode === 'use' ? `Switch to the existing data in\n${to}\n\nNothing is copied.` : `Copy all NodeGSM data (${gb(p.bytes)}, ${p.files} files) to\n${to}`;
  if (!confirm(`${what}\n\nNodeGSM restarts afterwards. The current folder is not deleted.\n\nContinue?`)) return;
  const prog = $('#dlProg'); prog.hidden = false; prog.textContent = mode === 'use' ? 'Switching...' : 'Copying...';
  for (const id of ['#dlChange', '#dlUse', '#dlStd']) $(id).disabled = true;
  const r = await run('dataLocationMove', to, mode);
  prog.hidden = true; await paintDataLocation();
  if (!r) return;
  toast('The data folder was changed.');
  if (confirm(`Done${r.skipped ? ` (${r.skipped} link(s) were not copied)` : ''}. Restart NodeGSM now to use ${r.to}?\nThe old folder ${r.from} was kept; delete it yourself once everything works.`)) run('relaunch');
}
api.on('dataLocation:progress', (p) => {
  const prog = $('#dlProg'); if (!prog || p.moved) return;
  prog.hidden = false; prog.textContent = `Copying... ${gb(p.bytes)} of ${gb(p.totalBytes)} (${p.files} / ${p.totalFiles} files)`;
});
$('#dlChange').onclick = async () => { const f = await run('pickFolder'); if (f) moveData(f, 'copy'); };
$('#dlUse').onclick = async () => { const f = await run('pickFolder'); if (f) moveData(f, 'use'); };
$('#dlStd').onclick = () => { if (state.dl) moveData(state.dl.standard, 'copy'); };
$('#dlOpen').onclick = () => run('dataLocationOpenOld');
/** Settings view: refresh every control from the saved settings (called when the view opens). */
async function openSettingsView() {
  const s = (await run('settings')) || appSettings;
  $('#hwNote').hidden = true;
  paintSettings(s);
  if (state.features.dataLocation) paintDataLocation();
  if (typeof waPaint === 'function') waPaint(s);
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
  set('#aInstall', running || busy); set('#aUpdate', running || busy); set('#aValidate', running || busy);
  const b = document.querySelector('.dhead .badge'); if (b) { b.textContent = v.status; b.className = `badge ${v.status}`; }
}
api.on('console', ({ id, line }) => {
  if (id !== state.sel) return;
  state.consoleBuf.push(line);
  if (state.consoleBuf.length > 2000) state.consoleBuf.shift();
  const out = $('#conOut');
  if (out && (typeof conState === 'undefined' || conState.sub === 'main')) {
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
  if (hs.tick) {   // worst tick metric of the running servers that report one; 'n/a' when none does (the server name is in the tooltip)
    const t = NGSMTick.aggregateTick((dash.snap && dash.snap.servers || []).filter((r) => state.servers.get(r.id) && state.servers.get(r.id).pid));
    items.push(['Tick', t.text, t.title, t.cls]);
  }
  $('#metrics').innerHTML = items.map(([k, v, title, cls]) => `<span class="stat"${title ? ` title="${esc(title)}"` : ''}><span class="k">${k}</span> <span class="${cls ? `tk tk-${esc(cls)}` : ''}">${esc(v)}</span></span>`).join('');
}
async function refreshMetrics() {
  const m = await api.call('metrics').catch(() => null);
  if (m) state.sys = m;
  renderHeaderStats();
}

async function init() {
  const pi = await run('platformInfo');
  if (pi) {
    state.platform = pi.platform; state.features = pi.features || {};
    document.documentElement.dataset.mode = pi.mode;
    if (pi.mode === 'web') { $('#addDir').readOnly = false; $('#addDir').placeholder = 'Path on the server, e.g. /srv/games/mc'; }
  }
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
