'use strict';
// App shell: left navigation, collapsible panels (server list / details / quick settings), footer links.
// Loaded last; uses the globals of app.js and dashboard.js (state, run, esc, $, appSettings, setView, dash, fmtUptime, fmtBytes, toast ...).

// ---------- collapsible panels (state in settings.ui, mirrored to localStorage for theme-boot.js) ----------
const UI_KEYS = ['leftCollapsed', 'rightCollapsed', 'bottomCollapsed', 'navCollapsed'];
const UI_TOGGLES = { tgLeft: 'leftCollapsed', tgRight: 'rightCollapsed', tgBottom: 'bottomCollapsed', tgNav: 'navCollapsed' };

/** Apply settings.ui to the page (data attributes drive the CSS) and keep the localStorage mirror current. */
function applyShell(s) {
  const ui = (s && s.ui) || {};
  const r = document.documentElement;
  for (const k of UI_KEYS) if (k in ui) r.dataset[k] = ui[k] ? '1' : '0';
  for (const [btn, k] of Object.entries(UI_TOGGLES)) { const b = document.getElementById(btn); if (b) b.classList.toggle('on', r.dataset[k] !== '1'); }
  try { localStorage.setItem('nodegsm.ui', JSON.stringify(Object.fromEntries(UI_KEYS.map((k) => [k, r.dataset[k] === '1'])))); } catch { /* private mode */ }
}
function togglePanel(key) {
  const ui = { ...(appSettings.ui || {}) };
  ui[key] = !ui[key];
  appSettings.ui = ui;
  applyShell({ ui });
  run('saveSettings', { ui });
  if (document.body.dataset.view === 'dashboard') drawChart();   // the chart width changes with the panels
}
for (const [btn, k] of Object.entries(UI_TOGGLES)) $('#' + btn).onclick = () => togglePanel(k);
window.addEventListener('DOMContentLoaded', () => applyShell({ ui: appSettings.ui || {} }));
applyShell({ ui: appSettings.ui || {} });

// ---------- navigation ----------
const HOME_NAV = ['servers', 'table', 'configs', 'logs', 'backups', 'clusters'];   // views that live under Home in the navigation
const homeView = () => (['servers', 'table'].includes(appSettings.view) ? appSettings.view : 'servers');
function syncNav(v) {
  document.querySelectorAll('#nav [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  const home = HOME_NAV.includes(v);
  $('#navHome > .nav-item').classList.toggle('on', home);
  if (home) $('#navHome').classList.add('open');
}
document.querySelectorAll('#nav [data-view]').forEach((b) => (b.onclick = () => setView(b.dataset.view)));
$('#navHome > .nav-item').onclick = () => {
  const g = $('#navHome');
  const home = HOME_NAV.includes(document.body.dataset.view);
  if (home && document.documentElement.dataset.navCollapsed !== '1') g.classList.toggle('open');
  else { g.classList.add('open'); setView(homeView()); }
};
$('#navHome').classList.add('open');

// ---------- right panel (details) + bottom panel (quick settings) ----------
const bp = { for: null, dirty: false };
const kv = (k, v) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;

function statusRows(s) {
  const m = ((dash.snap && dash.snap.servers) || []).find((x) => x.id === s.id) || {};
  const live = s.pid ? m : {};
  return kv('Status', `<span class="badge ${esc(s.status)}">${esc(s.status)}</span>`)
    + kv('PID', esc(s.pid || '-'))
    + kv('Game', esc(s.gameName))
    + kv('Address', `${esc(s.ip_display)}:${esc(s.port)}`)
    + kv('Players', s.players != null ? `${s.players}/${esc(s.maxPlayersLive || s.maxPlayers)}` : `- / ${esc(s.maxPlayers)}`)
    + kv('Map', esc(s.liveMap || s.map || '-'))
    + kv('Uptime', s.startedAt ? esc(fmtUptime(Date.now() - s.startedAt)) : '-')
    + kv('CPU', live.cpu != null ? `${live.cpu.toFixed(1)}%` : '-')
    + kv('Memory', live.mem != null ? esc(fmtBytes(live.mem)) : '-')
    + kv('Tick', live.tick ? tickCell(live.tick, live.tick.cls) : '-')
    + kv('Latency', live.metrics && live.metrics.latency ? `${esc(fmtNum(live.metrics.latency.value))} ms` : '-')
    + kv('Restarts', esc(s.restarts || 0));
}

function renderBottomForm(s) {
  const f = (k, label) => `<label>${label}<input data-q="${k}" value="${esc(s[k])}"></label>`;
  $('#bpName').textContent = `${s.name} (#${s.id})`;
  $('#bpBody').className = '';
  $('#bpBody').innerHTML = `<div class="bp-grid">
    <div class="bp-form">
      <div class="grid">${f('name', 'Server name')}${f('port', 'Port')}${f('map', 'Map / World')}${f('maxPlayers', 'Max players')}</div>
      <label style="margin-top:8px">Start parameters<input data-q="param" value="${esc(s.param)}"></label>
      <div class="row end" style="margin-top:8px"><button id="qsSave" class="primary">Save</button><span class="muted small">Takes effect on the next start. More options: details tab <b>Settings</b>.</span></div>
    </div>
    <div class="bp-status" id="bpStatus">${statusRows(s)}</div>
  </div>`;
  bp.for = s.id; bp.dirty = false;
  $('#bpBody').querySelectorAll('[data-q]').forEach((i) => (i.oninput = () => { bp.dirty = true; }));
  $('#qsSave').onclick = async () => {
    const patch = {};
    $('#bpBody').querySelectorAll('[data-q]').forEach((i) => { patch[i.dataset.q] = i.value; });
    if ((await run('save', s.id, patch)) !== undefined) { toast('Saved'); bp.dirty = false; renderSidePanels(s.id, true); }
  };
}

/** Refresh the right panel and the bottom panel for the selected server. The quick-settings form is only rebuilt when it is safe (no unsaved edits). */
function renderSidePanels(id, force) {
  const s = state.servers.get(state.sel);
  const rp = $('#rpBody'); const bb = $('#bpBody');
  if (!s) {
    rp.className = 'pad muted'; rp.textContent = 'Select a server';
    bb.className = 'muted pad'; bb.textContent = 'Select a server'; $('#bpName').textContent = ''; bp.for = null;
    return;
  }
  rp.className = 'rp';
  rp.innerHTML = `<div class="rp-head"><img src="${esc(iconSrc(s.icon))}" alt=""><div><b>${esc(s.name)}</b><div class="muted small">#${esc(s.id)}</div></div></div>${statusRows(s)}`;
  const editing = bb.contains(document.activeElement) && document.activeElement.matches('input');
  if (force || bp.for !== s.id || !bb.querySelector('#bpStatus') || (!bp.dirty && !editing)) renderBottomForm(s);
  else $('#bpStatus').innerHTML = statusRows(s);
}

// ---------- footer ----------
document.querySelectorAll('footer [data-link]').forEach((a) => (a.onclick = (e) => {
  e.preventDefault();
  const url = (typeof NODEGSM_LINKS !== 'undefined') ? NODEGSM_LINKS[a.dataset.link] : null;
  $('#ftDonateMenu').hidden = true;
  if (url) run('openExternal', url);
}));
$('#ftDonate').onclick = (e) => { e.stopPropagation(); $('#ftDonateMenu').hidden = !$('#ftDonateMenu').hidden; };
document.addEventListener('click', (e) => { if (!e.target.closest('.donate')) $('#ftDonateMenu').hidden = true; });

setInterval(() => { if (state.sel && document.body.dataset.view !== 'plugins' && document.body.dataset.view !== 'settings') renderSidePanels(); }, 5000);
