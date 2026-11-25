'use strict';
// Logs screen (Home > Logs): the NGSM event log with filters, auto refresh, export and clear.
// Uses the globals of app.js (run, esc, $, toast, state, viewHooks).

const lg = { timer: null, busy: false };
const LG_EVENTS = [['', 'All events'], ['server:started', 'Started'], ['server:stopped', 'Stopped'], ['server:crashed', 'Crashed'], ['server:restarted', 'Restarted'], ['server:updated', 'Updated'],
  ['server:backup', 'Backup'], ['server:restore', 'Restore'], ['server:command', 'Console command'], ['server:config', 'Config edit'], ['pattern:', 'Plugin patterns'], ['game:', 'Game events'], ['log:', 'Log actions']];

function lgFilters() {
  const f = { limit: 500 };
  const v = (id) => $(id).value;
  if (v('#lgServer')) f.serverId = v('#lgServer');
  if (v('#lgLevel')) f.level = v('#lgLevel');
  if (v('#lgEvent')) f.event = v('#lgEvent');
  if (v('#lgText').trim()) f.text = v('#lgText').trim();
  return f;
}
function lgFillSelects() {
  const sv = $('#lgServer'); const cur = sv.value;
  sv.innerHTML = '<option value="">All servers</option>' + [...state.servers.values()].map((s) => `<option value="${esc(s.id)}">#${esc(s.id)} ${esc(s.name)}</option>`).join('');
  sv.value = cur;
  const ev = $('#lgEvent');
  if (!ev.options.length) ev.innerHTML = LG_EVENTS.map(([k, n]) => `<option value="${esc(k)}">${esc(n)}</option>`).join('');
}
async function lgRefresh() {
  if (lg.busy) return;
  lg.busy = true;
  try {
    const rows = await run('eventLogQuery', lgFilters());
    if (!rows) return;
    $('#lgCount').textContent = `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}${rows.length >= 500 ? ' (newest 500)' : ''}`;
    $('#lgTable').innerHTML = '<thead><tr><th style="width:160px">Time</th><th style="width:64px">Level</th><th style="width:170px">Server</th><th style="width:150px">Event</th><th>Message</th></tr></thead><tbody>'
      + rows.map((r) => `<tr class="lv-${esc(r.level)}" title="${esc(JSON.stringify(r.detail || {}))}"><td>${esc(new Date(r.ts).toLocaleString())}</td><td><span class="lvl ${esc(r.level)}">${esc(r.level)}</span></td>
        <td>${r.serverId ? `#${esc(r.serverId)} ${esc(r.serverName)}` : '-'}</td><td class="muted">${esc(r.event)}</td><td class="lg-msg">${esc(r.message)}</td></tr>`).join('')
      + '</tbody>';
    $('#lgEmpty').hidden = rows.length > 0;
  } finally { lg.busy = false; }
}
function lgSchedule() {
  clearInterval(lg.timer); lg.timer = null;
  if ($('#lgAuto').checked) lg.timer = setInterval(() => { if (document.body.dataset.view === 'logs') lgRefresh(); }, 3000);
}
['#lgServer', '#lgLevel', '#lgEvent'].forEach((s) => ($(s).onchange = lgRefresh));
let lgDebounce; $('#lgText').oninput = () => { clearTimeout(lgDebounce); lgDebounce = setTimeout(lgRefresh, 250); };
$('#lgAuto').onchange = lgSchedule;
$('#lgRefresh').onclick = lgRefresh;
$('#lgExport').onclick = async () => {
  const f = lgFilters(); delete f.limit;
  const text = await run('eventLogExport', f);
  if (text === undefined) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = `nodegsm-log-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
$('#lgClear').onclick = async () => {
  if (!confirm('Delete the whole NodeGSM event log? This cannot be undone.')) return;
  await run('eventLogClear'); toast('Event log cleared'); lgRefresh();
};
viewHooks.logs = () => { lgFillSelects(); lgRefresh(); lgSchedule(); };
