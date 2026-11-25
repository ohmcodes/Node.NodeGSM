'use strict';
// Table view (horizontal list with multi-select + bulk actions) and Dashboard (metrics).
// Loaded after app.js and shares its globals (state, run, esc, $, appSettings, saveSetting, select, toast ...).

const dash = { snap: null, history: [], sort: { col: 'name', dir: 1 } };
const tsel = new Set();     // ids selected in the Table view
let lastClicked = null;

// ---------- formatting ----------
const fmtBytes = (b) => (b == null ? '-' : b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(2)} GB` : `${(b / 2 ** 20).toFixed(0)} MB`);
const fmtNum = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
function fmtUptime(ms) {
  if (ms == null) return '-';
  const s = Math.floor(ms / 1000); const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

// ---------- columns (one list, chosen in Settings, used by Table and Dashboard) ----------
const BUILTIN_COLS = [
  { id: 'id', label: 'ID', html: (r) => esc(r.id), key: (r) => Number(r.id) },
  { id: 'pid', label: 'PID', html: (r) => r.pid || '', key: (r) => r.pid || 0 },
  { id: 'icon', label: 'Mod', html: (r) => (r.icon ? `<img src="${esc(r.icon)}" alt="" title="${esc(r.gameName)}">` : ''), key: (r) => r.game },
  { id: 'status', label: 'Status', html: (r) => `<span class="badge ${esc(r.status)}">${esc(r.status)}</span>`, key: (r) => r.status },
  { id: 'name', label: 'Server name', html: (r) => esc(r.name), key: (r) => (r.name || '').toLowerCase() },
  { id: 'game', label: 'Game', html: (r) => esc(r.gameName), key: (r) => (r.gameName || '').toLowerCase() },
  { id: 'ip', label: 'IP address', html: (r) => esc(r.ip), key: (r) => r.ip || '' },
  { id: 'port', label: 'Port', html: (r) => esc(r.port), key: (r) => Number(r.port) || 0 },
  { id: 'queryPort', label: 'Query port', html: (r) => esc(r.queryPort), key: (r) => Number(r.queryPort) || 0 },
  { id: 'map', label: 'Map', html: (r) => esc(r.map || ''), key: (r) => (r.map || '').toLowerCase() },
  { id: 'players', label: 'Players', html: (r) => (r.players != null ? `${r.players}/${esc(r.maxPlayers)}` : esc(r.maxPlayers || '')), key: (r) => (r.players == null ? -1 : r.players) },
  { id: 'cpu', label: 'CPU', html: (r) => (r.cpu == null ? '' : `${r.cpu.toFixed(1)}%`), key: (r) => (r.cpu == null ? -1 : r.cpu) },
  { id: 'memory', label: 'Memory', html: (r) => (r.mem == null ? '' : fmtBytes(r.mem)), key: (r) => (r.mem == null ? -1 : r.mem) },
  { id: 'uptime', label: 'Uptime', html: (r) => (r.uptime == null ? '' : fmtUptime(r.uptime)), key: (r) => (r.uptime == null ? -1 : r.uptime) },
  { id: 'threads', label: 'Threads', html: (r) => (r.threads == null ? '' : r.threads), key: (r) => (r.threads == null ? -1 : r.threads) },
  { id: 'restarts', label: 'Restarts', html: (r) => r.restarts, key: (r) => r.restarts },
];
const allCols = () => [...BUILTIN_COLS, ...((dash.snap && dash.snap.defs) || []).map((d) => ({
  id: d.id, plugin: true, label: d.unit ? `${d.name} (${d.unit})` : d.name,
  html: (r) => (r.metrics && r.metrics[d.id] ? esc(fmtNum(r.metrics[d.id].value)) : ''), key: (r) => (r.metrics && r.metrics[d.id] ? r.metrics[d.id].value : -1),
}))];
const chosenCols = () => { const sel = appSettings.tableColumns || []; return allCols().filter((c) => sel.includes(c.id)); };

/** Rows = live server state (instant status changes) + the last metrics sample (CPU, memory, plugin metrics). */
function liveRows() {
  const base = new Map(((dash.snap && dash.snap.servers) || []).map((r) => [r.id, r]));
  return [...state.servers.values()].map((v) => {
    const m = base.get(v.id) || {};
    return {
      id: v.id, name: v.name, game: v.game, gameName: v.gameName, icon: v.icon, status: v.status, pid: v.pid, ip: v.ip_display,
      port: v.port, queryPort: v.queryPort, players: v.players, maxPlayers: v.maxPlayersLive || v.maxPlayers, map: v.liveMap || v.map || '',
      restarts: v.restarts || 0, uptime: v.startedAt ? Date.now() - v.startedAt : null,
      cpu: v.pid ? m.cpu ?? null : null, mem: v.pid ? m.mem ?? null : null, threads: v.pid ? m.threads ?? null : null, metrics: v.pid ? m.metrics || {} : {},
    };
  });
}

// ---------- column picker (Settings dialog, Table toolbar, Dashboard) ----------
function renderColChecks(el) {
  if (!el) return;
  const sel = appSettings.tableColumns || [];
  const cols = allCols();
  const box = (c) => `<label class="check"><input type="checkbox" data-col="${esc(c.id)}" ${sel.includes(c.id) ? 'checked' : ''}> ${esc(c.label)}</label>`;
  const plug = cols.filter((c) => c.plugin);
  el.innerHTML = '<h5>Server</h5>' + cols.filter((c) => !c.plugin).map(box).join('')
    + '<h5>From game plugins</h5>' + (plug.length ? plug.map(box).join('') : '<span class="muted small">None of your games declare extra metrics (FPS, tick rate ...) yet. Plugins can - see PLUGINS.md.</span>');
  el.querySelectorAll('input[data-col]').forEach((i) => (i.onchange = async () => {
    const next = cols.filter((c) => (c.id === i.dataset.col ? i.checked : (appSettings.tableColumns || []).includes(c.id))).map((c) => c.id);
    await saveSetting({ tableColumns: next });
    renderAllPickers(); renderTables();
  }));
}
function renderAllPickers() { for (const s of ['#dColPanel', '#tbColPanel', '#setCols']) renderColChecks($(s)); }

// ---------- tables ----------
function sortedRows(rows, cols) {
  const sc = cols.find((c) => c.id === dash.sort.col) || cols[0];
  if (sc) rows.sort((a, b) => (sc.key(a) > sc.key(b) ? 1 : sc.key(a) < sc.key(b) ? -1 : 0) * dash.sort.dir);
  return sc;
}
function headCells(cols, sc, withCheck, allChecked, someChecked) {
  return `<thead><tr>${withCheck ? `<th class="chk"><input type="checkbox" id="tAll" ${allChecked ? 'checked' : ''} data-some="${someChecked ? 1 : 0}"></th>` : ''}`
    + cols.map((c) => `<th data-c="${esc(c.id)}" class="${sc && sc.id === c.id ? 'sorted' : ''}">${esc(c.label)}${sc && sc.id === c.id ? (dash.sort.dir > 0 ? ' ▴' : ' ▾') : ''}</th>`).join('') + '</tr></thead>';
}
function bindSort(t, rerender) {
  t.querySelectorAll('th[data-c]').forEach((th) => (th.onclick = () => { dash.sort = { col: th.dataset.c, dir: dash.sort.col === th.dataset.c ? -dash.sort.dir : 1 }; rerender(); }));
}

function renderTable() {            // Table view: all servers, checkboxes, bulk actions
  const t = $('#tTable'); if (!t) return;
  const cols = chosenCols();
  const rows = liveRows();
  for (const id of [...tsel]) if (!state.servers.has(id)) tsel.delete(id);
  const sc = sortedRows(rows, cols);
  const all = rows.length > 0 && rows.every((r) => tsel.has(r.id)); const some = rows.some((r) => tsel.has(r.id));
  t.innerHTML = headCells(cols, sc, true, all, some)
    + `<tbody>${rows.map((r) => `<tr data-id="${esc(r.id)}" class="${tsel.has(r.id) ? 'sel' : ''}"><td class="chk"><input type="checkbox" data-id="${esc(r.id)}" ${tsel.has(r.id) ? 'checked' : ''}></td>${cols.map((c) => `<td>${c.html(r)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  $('#tbEmpty').hidden = rows.length > 0;
  const allBox = $('#tAll'); if (allBox) allBox.indeterminate = !all && some;
  bindSort(t, renderTable);
  if (allBox) allBox.onchange = () => { rows.forEach((r) => (allBox.checked ? tsel.add(r.id) : tsel.delete(r.id))); renderTable(); };
  const order = rows.map((r) => r.id);
  t.querySelectorAll('tbody tr').forEach((tr) => {
    const id = tr.dataset.id;
    tr.onclick = (e) => {
      if (e.target.matches('input[type=checkbox]')) { e.target.checked ? tsel.add(id) : tsel.delete(id); lastClicked = id; }
      else if (e.shiftKey && lastClicked && order.includes(lastClicked)) {
        const [x, y] = [order.indexOf(lastClicked), order.indexOf(id)].sort((p, q) => p - q);
        order.slice(x, y + 1).forEach((i) => tsel.add(i));
      } else if (e.ctrlKey || e.metaKey) { tsel.has(id) ? tsel.delete(id) : tsel.add(id); lastClicked = id; }
      else { tsel.clear(); tsel.add(id); lastClicked = id; }
      renderTable();
    };
    tr.ondblclick = async () => { await setView('servers'); select(id); };
  });
  updateToolbar();
}

function updateToolbar() {
  const rows = liveRows().filter((r) => tsel.has(r.id));
  const running = (r) => ['Started', 'Starting', 'Stopping'].includes(r.status);
  const busy = (r) => ['Installing', 'Updating'].includes(r.status);
  const set = (id, on) => { const e = $(id); if (e) e.disabled = !on; };
  set('#tbStart', rows.some((r) => r.status === 'Stopped'));
  set('#tbStop', rows.some((r) => running(r)));
  set('#tbRestart', rows.some((r) => running(r)));
  set('#tbKill', rows.some((r) => running(r)));
  set('#tbUpdate', rows.some((r) => !busy(r)));
  set('#tbBackup', rows.some((r) => !busy(r)));
  set('#tbOpen', rows.length === 1);
  $('#tbSel').textContent = rows.length ? `${rows.length} selected` : 'Select servers with the checkboxes (Ctrl / Shift click works too)';
}

const BULK_LABEL = { start: 'Starting', stop: 'Stopping', restart: 'Restarting', kill: 'Killing', update: 'Updating', backup: 'Backing up' };
async function bulkRun(action) {
  const ids = [...tsel]; if (!ids.length) return;
  const names = ids.map((i) => (state.servers.get(i) || {}).name || i);
  if (action === 'kill' && !confirm(`Force-kill ${ids.length} server(s)?\n\n${names.join('\n')}\n\nThey are terminated immediately - unsaved world data can be lost. Use Stop for a graceful shutdown.`)) return;
  if (action === 'update' && ids.length > 1 && !confirm(`Update ${ids.length} servers one after another? Running servers are stopped, updated, then started again.`)) return;
  toast(`${BULK_LABEL[action]} ${ids.length} server(s) ...`);
  const res = await run('bulk', action, ids);
  if (!res) return;
  const failed = res.filter((r) => !r.ok); const skipped = res.filter((r) => r.skipped).length;
  const nm = (id) => (state.servers.get(id) || {}).name || id;
  if (failed.length) toast(`${failed.length} failed: ${failed.slice(0, 3).map((f) => `${nm(f.id)} (${f.error})`).join('; ')}`, true);
  else toast(`${action}: done for ${res.length - skipped} server(s)${skipped ? `, ${skipped} skipped (not applicable)` : ''}`);
}
for (const [id, action] of [['#tbStart', 'start'], ['#tbStop', 'stop'], ['#tbRestart', 'restart'], ['#tbKill', 'kill'], ['#tbUpdate', 'update'], ['#tbBackup', 'backup']]) $(id).onclick = () => bulkRun(action);
$('#tbOpen').onclick = async () => { const id = [...tsel][0]; if (id) { await setView('servers'); select(id); } };
$('#tbCols').onclick = (e) => { e.stopPropagation(); $('#tbColPanel').hidden = !$('#tbColPanel').hidden; };

// ---------- dashboard ----------
function tile(title, sub, pct, color, nums) {
  return `<div class="tile" style="--c:${color}"><div class="t1"><span class="big">${esc(title)}</span><span class="sub" title="${esc(sub)}">${esc(sub)}</span></div>`
    + `<div class="bar"><i style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%"></i></div><div class="nums"><span>${pct.toFixed(2)}%</span><span>${esc(nums || '')}</span></div></div>`;
}
function renderTiles() {
  const s = dash.snap; if (!s) { $('#dSys').innerHTML = '<p class="muted">Collecting metrics ...</p>'; $('#dGame').innerHTML = ''; return; }
  const m = s.system; const g = s.game;
  $('#dSys').innerHTML = tile('CPU', m.cpuModel, m.cpuPercent, 'var(--accent)', `${m.cores} threads`)
    + tile('Memory', 'RAM', (m.memUsed / m.memTotal) * 100, '#9b59b6', `${(m.memUsed / 2 ** 30).toFixed(2)} / ${(m.memTotal / 2 ** 30).toFixed(2)} GB`)
    + (m.disk ? tile(`Disk (${m.disk.drive})`, 'server data drive', (m.disk.used / m.disk.total) * 100, '#2ecc71', `${(m.disk.used / 2 ** 40).toFixed(2)} / ${(m.disk.total / 2 ** 40).toFixed(2)} TB`) : '');
  $('#dGame').innerHTML = tile('Servers', 'Installed server count', (g.installed / g.max) * 100, '#e84393', `${g.installed}/${g.max}`)
    + tile('Online', 'Started server count', g.installed ? (g.online / g.installed) * 100 : 0, '#1fb6d9', `${g.online}/${g.installed}`)
    + `<div class="tile num" style="--c:#f5a623"><div class="t1"><span class="big">Active Players</span><span class="big">${g.players}</span></div></div>`;
}
function renderDashTable() {
  const t = $('#dTable'); if (!t) return;
  const cols = chosenCols();
  const rows = liveRows().filter((r) => appSettings.dashboardShowStopped || r.status !== 'Stopped');
  const sc = sortedRows(rows, cols);
  t.innerHTML = headCells(cols, sc, false)
    + `<tbody>${rows.length ? rows.map((r) => `<tr data-id="${esc(r.id)}">${cols.map((c) => `<td>${c.html(r)}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${Math.max(1, cols.length)}" class="muted">${appSettings.dashboardShowStopped ? 'No servers yet.' : 'No servers are running.'}</td></tr>`}</tbody>`;
  bindSort(t, renderDashTable);
  t.querySelectorAll('tbody tr[data-id]').forEach((tr) => (tr.onclick = async () => { await setView('servers'); select(tr.dataset.id); }));
}

const SERIES_COLORS = ['#4f8cff', '#2ecc71', '#f5a623', '#e84393', '#9b59b6', '#1fb6d9', '#ff7a45', '#8bc34a'];
function drawChart() {
  const cv = $('#dashChart'); if (!cv) return;
  const wrap = cv.parentElement; const dpr = window.devicePixelRatio || 1;
  const W = Math.max(300, wrap.clientWidth - 28); const H = 240;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.width = `${W}px`; cv.style.height = `${H}px`;
  const c = cv.getContext('2d'); c.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const text = css.getPropertyValue('--muted').trim(); const line = css.getPropertyValue('--line').trim();
  const metric = appSettings.dashboardChart || 'players';
  const unit = { players: '', cpu: '%', memory: ' GB' }[metric];
  const val = { players: (p) => p.p, cpu: (p) => p.c, memory: (p) => p.m / 2 ** 30 }[metric];
  const hist = dash.history;
  const ids = [...new Set(hist.flatMap((p) => Object.keys(p.s)))];
  const series = [];
  if (metric === 'cpu') series.push({ name: 'System', color: text || '#888', pts: hist.map((p) => [p.t, p.cpu]) });
  if (metric === 'players') series.push({ name: 'Total', color: SERIES_COLORS[0], pts: hist.map((p) => [p.t, p.players]) });
  ids.forEach((id, i) => {
    const sv = state.servers.get(id);
    series.push({ name: sv ? sv.name : `#${id}`, color: SERIES_COLORS[(i + (metric === 'players' ? 1 : 0)) % SERIES_COLORS.length], pts: hist.map((p) => [p.t, p.s[id] ? val(p.s[id]) : null]) });
  });
  const L = 44; const R = 10; const T = 10; const B = 22;
  c.font = '11px Segoe UI, sans-serif'; c.fillStyle = text; c.strokeStyle = line;
  if (hist.length < 2) { c.fillText('Collecting data ...', L + 10, H / 2); $('#dLegend').innerHTML = ''; return; }
  let max = Math.max(...series.flatMap((s) => s.pts.map((p) => p[1] || 0)), metric === 'players' ? 4 : metric === 'cpu' ? 10 : 1);
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find((s) => max / s <= 5) || 1000;
  max = Math.ceil(max / step) * step; if (metric === 'cpu') max = Math.min(100, max);
  const t0 = hist[0].t; const t1 = hist[hist.length - 1].t;
  const X = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R); const Y = (v) => T + (1 - v / max) * (H - T - B);
  for (let v = 0; v <= max; v += max / 5) { const y = Y(v); c.beginPath(); c.moveTo(L, y); c.lineTo(W - R, y); c.stroke(); c.fillText(`${fmtNum(v)}${unit.trim() === '%' ? '%' : ''}`, 4, y + 4); }
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  c.fillText(clock(t0), L, H - 6); const e = clock(t1); c.fillText(e, W - R - c.measureText(e).width, H - 6);
  for (const s of series) {
    c.strokeStyle = s.color; c.lineWidth = 2; c.beginPath(); let pen = false;
    for (const [t, v] of s.pts) { if (v == null) { pen = false; continue; } if (!pen) { c.moveTo(X(t), Y(v)); pen = true; } else c.lineTo(X(t), Y(v)); }
    c.stroke();
  }
  $('#dLegend').innerHTML = series.map((s) => { const last = [...s.pts].reverse().find((p) => p[1] != null); return `<span><i style="background:${s.color}"></i>${esc(s.name)}${last ? ` ${fmtNum(last[1])}${unit}` : ''}</span>`; }).join('');
  $('#dChartNote').textContent = `last ${Math.round((t1 - t0) / 60000)} min`;
}

function renderDash() { renderTiles(); renderDashTable(); drawChart(); }
function renderTables() {
  const v = document.body.dataset.view;
  if (v === 'table') renderTable();
  else if (v === 'dashboard') renderDash();
}

// ---------- view switching ----------
const HOME_VIEWS = ['servers', 'table', 'dashboard'];   // remembered in settings.view
const ALL_VIEWS = [...HOME_VIEWS, 'plugins', 'settings', 'discord'];
const viewHooks = {};                                    // view -> function run when it opens (filled by app.js / shell.js)
async function setView(v) {
  if (!ALL_VIEWS.includes(v)) v = 'servers';
  document.body.dataset.view = v;
  if (typeof syncNav === 'function') syncNav(v);
  if (HOME_VIEWS.includes(v)) { appSettings.view = v; run('saveSettings', { view: v }); }
  renderAllPickers();
  if (v === 'dashboard') { $('#dStopped').checked = !!appSettings.dashboardShowStopped; $('#dChart').value = appSettings.dashboardChart || 'players'; }
  renderTables();
  if (viewHooks[v]) viewHooks[v]();
}
$('#dCols').onclick = (e) => { e.stopPropagation(); $('#dColPanel').hidden = !$('#dColPanel').hidden; };
document.addEventListener('click', (e) => { if (!e.target.closest('.colpick')) { $('#dColPanel').hidden = true; $('#tbColPanel').hidden = true; } });
$('#dStopped').onchange = async (e) => { await saveSetting({ dashboardShowStopped: e.target.checked }); renderDashTable(); };
$('#dChart').onchange = async (e) => { await saveSetting({ dashboardChart: e.target.value }); drawChart(); };
$('#setColsReset').onclick = async () => { const d = await run('settingsDefaults'); if (d) { await saveSetting({ tableColumns: d.tableColumns }); renderAllPickers(); renderTables(); } };
window.addEventListener('resize', () => { if (document.body.dataset.view === 'dashboard') drawChart(); });

api.on('metrics', ({ snapshot, point }) => {
  dash.snap = snapshot; dash.history.push(point); if (dash.history.length > 360) dash.history.shift();
  renderHeaderStats();
  if (typeof renderSidePanels === 'function') renderSidePanels();
  const v = document.body.dataset.view;
  if (v === 'dashboard') { renderDash(); if ($('#dColPanel').hidden) renderColChecks($('#dColPanel')); }
  else if (v === 'table') { renderTable(); if ($('#tbColPanel').hidden) renderColChecks($('#tbColPanel')); }
});
