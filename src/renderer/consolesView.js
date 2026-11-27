'use strict';
// Console tab: the game console plus the plugin's injected consoles (log tail, RCON) as sub-tabs.
// A game without consoles[] looks exactly like before (no sub-tab bar). Uses the globals of app.js (api, run, esc, $, state).

const conState = { lists: {}, sub: 'main', sid: null, bufs: {}, logOn: null, hist: {}, histPos: -1 };   // hist: "<server>:<console>" -> sent commands (newest last)   // bufs: "<server>:<console>" -> lines
const CON_MAX = 2000;
const conKey = (sid, cid) => `${sid}:${cid}`;

function stopConsoleLog() {
  if (conState.logOn) { api.call('consoleStop', conState.logOn.sid, conState.logOn.cid).catch(() => {}); conState.logOn = null; }
}

// Minecraft colour codes (the section sign + 0-9 a-f, k l m n o r) as in mcrcon, shown as colours; "reset" ends them. ANSI escapes are removed.
const MC_COLORS = { 0: '#000000', 1: '#0000aa', 2: '#00aa00', 3: '#00aaaa', 4: '#aa0000', 5: '#aa00aa', 6: '#ffaa00', 7: '#aaaaaa', 8: '#555555', 9: '#5555ff', a: '#55ff55', b: '#55ffff', c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#ffffff' };
function mcHtml(line) {
  const parts = String(line).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\u00a7');
  let html = esc(parts[0]); let open = false;
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]; const code = (p[0] || '').toLowerCase(); const rest = p.slice(1);
    if (MC_COLORS[code]) { html += (open ? '</span>' : '') + '<span style="color:' + MC_COLORS[code] + '">'; open = true; }
    else if (code === 'r') { html += open ? '</span>' : ''; open = false; }
    else if (!'klmno'.includes(code)) { html += '\u00a7' + esc(p); continue; }   // not a code: keep the text
    html += esc(rest);
  }
  return html + (open ? '</span>' : '');
}
const conIsRcon = (sid, cid) => { const l = conState.lists[sid]; const c = l && l.find((x) => x.id === cid); return !!c && c.type === 'rcon'; };
function conPaint(lines, rcon) {
  const out = $('#conOut'); if (!out) return;
  if (rcon) out.innerHTML = lines.map(mcHtml).join('\n'); else out.textContent = lines.join('\n');
  out.scrollTop = out.scrollHeight;
}

/** Quick-command buttons of an rcon console (declared by the plugin: consoles[].commands) */
function conQuick(s, c) {
  const box = $('#conQuick'); if (!box) return;
  const cmds = (c && c.type === 'rcon' && c.commands) || [];
  box.hidden = !cmds.length;
  box.innerHTML = cmds.map((q, i) => '<button type="button" class="qc" data-i="' + i + '" title="' + esc(q.command) + '">' + esc(q.label) + '</button>').join('');
  box.querySelectorAll('.qc').forEach((b) => (b.onclick = async () => {
    const q = cmds[+b.dataset.i];
    if (q.confirm && !confirm('Send "' + q.command + '" to ' + s.name + '?')) return;
    conRemember(s.id, c.id, q.command);
    await run('consoleCommand', s.id, c.id, q.command);
  }));
}
function conRemember(sid, cid, text) {
  const k = conKey(sid, cid); const h = conState.hist[k] || (conState.hist[k] = []);
  if (h[h.length - 1] !== text) h.push(text);
  if (h.length > 100) h.shift();
  conState.histPos = -1;
}

async function conSwitch(s, cid) {
  const same = conState.logOn && conState.logOn.sid === s.id && conState.logOn.cid === cid;   // a status refresh re-rendered the tab: keep following
  if (!same) stopConsoleLog();
  conState.sub = cid; conState.sid = s.id;
  const list = conState.lists[s.id] || []; const c = list.find((x) => x.id === cid) || { id: 'main', type: 'process' };
  document.querySelectorAll('#con .subtabs button').forEach((b) => b.classList.toggle('on', b.dataset.c === cid));
  const inp = $('#conIn'); const btn = $('#conSend');
  conState.histPos = -1; conQuick(s, c);
  if (c.type === 'process') {
    inp.disabled = false; btn.disabled = false;
    inp.placeholder = 'Type a command and press Enter (not supported by Source/GoldSource engines)';
    conPaint(state.consoleBuf); return;
  }
  if (c.type === 'rcon') {
    inp.disabled = false; btn.disabled = false; inp.placeholder = 'RCON command (connects on the first command; the server must be running and RCON enabled in its config)';
    conPaint(conState.bufs[conKey(s.id, cid)] || [], true); return;
  }
  inp.disabled = true; btn.disabled = true; inp.placeholder = 'Read-only: this console follows a log file';
  conPaint(conState.bufs[conKey(s.id, cid)] || []);
  if (same) return;
  const r = await run('consoleStart', s.id, cid);
  if (!r || conState.sub !== cid) return;
  conState.logOn = { sid: s.id, cid };
  conState.bufs[conKey(s.id, cid)] = r.lines.slice(-CON_MAX);
  conPaint(conState.bufs[conKey(s.id, cid)]);
}

function tabConsole(b, s) {
  if (conState.sid !== s.id) { conState.sid = s.id; conState.sub = 'main'; }
  const list = conState.lists[s.id];
  const multi = list && list.length > 1;
  b.innerHTML = `<div id="con">${multi ? `<div class="subtabs">${list.map((c) => `<button type="button" data-c="${esc(c.id)}" class="${c.id === conState.sub ? 'on' : ''}" title="${esc(c.type)}">${esc(c.name)}</button>`).join('')}</div>` : ''}<div id="conOut"></div>
    <div id="conQuick" class="qcmds" hidden></div>
    <div class="row"><input id="conIn" placeholder="Type a command and press Enter (not supported by Source/GoldSource engines)"><button id="conSend">Send</button></div></div>`;
  const out = $('#conOut');
  out.textContent = state.consoleBuf.join('\n');
  out.scrollTop = out.scrollHeight;
  const send = async () => {
    const v = $('#conIn').value; if (!v) return; $('#conIn').value = '';
    conRemember(s.id, conState.sub, v);
    // main console output arrives through the 'console' event; RCON output through 'consoleOut'
    await run('consoleCommand', s.id, conState.sub, v);
  };
  $('#conSend').onclick = send;
  $('#conIn').onkeydown = (e) => {
    if (e.key === 'Enter') return send();
    // arrow up / down: earlier commands of this console
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const h = conState.hist[conKey(s.id, conState.sub)] || []; if (!h.length) return;
    e.preventDefault();
    conState.histPos = e.key === 'ArrowUp' ? Math.min(conState.histPos + 1, h.length - 1) : Math.max(conState.histPos - 1, -1);
    $('#conIn').value = conState.histPos < 0 ? '' : h[h.length - 1 - conState.histPos];
  };
  { const l = conState.lists[s.id]; if (l && conState.sub !== 'main') conQuick(s, l.find((x) => x.id === conState.sub)); }
  if (!list) {
    run('consolesList', s.id).then((l) => {
      conState.lists[s.id] = l && l.length ? l : [{ id: 'main', name: 'Game console', type: 'process' }];
      if (conState.lists[s.id].length > 1 && state.sel === s.id && state.tab === 'console') tabConsole(b, s);
    });
    return;
  }
  if (multi) {
    b.querySelectorAll('.subtabs button').forEach((x) => (x.onclick = () => conSwitch(s, x.dataset.c)));
    if (conState.sub !== 'main') conSwitch(s, conState.sub);
  }
}

// RCON output and log-console lines
api.on('consoleOut', ({ id, consoleId, reset, lines }) => {
  const k = conKey(id, consoleId);
  const buf = reset ? [] : (conState.bufs[k] || []);
  buf.push(...lines); if (buf.length > CON_MAX) buf.splice(0, buf.length - CON_MAX);
  conState.bufs[k] = buf;
  if (id !== state.sel || state.tab !== 'console' || conState.sub !== consoleId) return;
  const out = $('#conOut'); if (!out) return;
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  if (conIsRcon(id, consoleId)) out.innerHTML = buf.map(mcHtml).join('\n'); else out.textContent = buf.join('\n');
  if (atBottom) out.scrollTop = out.scrollHeight;
});

// ---------- Automation tab: scheduled commands (per server rconSchedule) ----------
const RC_PRESETS = [['Every 5 minutes', '*/5 * * * *'], ['Every 15 minutes', '*/15 * * * *'], ['Every 30 minutes', '*/30 * * * *'], ['Every hour', '0 * * * *'], ['Every 6 hours', '0 */6 * * *'], ['Every day at 04:00', '0 4 * * *']];

/** Block "Scheduled commands" inside the Automation tab: commands sent over RCON (or the game console) on a cron schedule while the server runs. */
async function rconSchedBlock(host, s) {
  const jobs = (Array.isArray(s.rconSchedule) ? s.rconSchedule : []).map((j) => ({ ...j }));
  let consoles = conState.lists[s.id];
  if (!consoles) { consoles = (await run('consolesList', s.id)) || []; conState.lists[s.id] = consoles; }
  const rcons = consoles.filter((c) => c.type === 'rcon');
  const paint = () => {
    host.innerHTML = '<datalist id="rcPresets">' + RC_PRESETS.map(([n, c]) => '<option value="' + esc(c) + '">' + esc(n) + '</option>').join('') + '</datalist>'
      + (jobs.length ? '' : '<p class="muted small" style="margin:0 0 8px">No scheduled commands.</p>')
      + jobs.map((j, i) => '<div class="rc-row" data-i="' + i + '">'
        + '<label class="check" title="Run this command"><input type="checkbox" data-f="enabled" ' + (j.enabled !== false ? 'checked' : '') + '></label>'
        + '<input data-f="cron" list="rcPresets" value="' + esc(j.cron || '') + '" spellcheck="false" placeholder="*/30 * * * *" style="width:140px" title="Five fields: minute hour day-of-month month day-of-week (this computer\'s local time)">'
        + (rcons.length ? '<select data-f="console" title="Which console sends it"><option value="">' + esc(rcons[0].name) + ' (default)</option>' + rcons.slice(1).map((c) => '<option value="' + esc(c.id) + '" ' + (j.console === c.id ? 'selected' : '') + '>' + esc(c.name) + '</option>').join('') + '</select>' : '<span class="muted small">game console</span>')
        + '<textarea data-f="command" rows="' + Math.min(Math.max(String(j.command || '').split('\n').length, 1), 4) + '" spellcheck="false" placeholder="one command per line, e.g. say Backup in 5 minutes" style="flex:1;min-width:200px;resize:vertical">' + esc(j.command || '') + '</textarea>'
        + '<input data-f="wait" type="number" min="0" max="600" value="' + esc(j.wait === undefined ? 1 : j.wait) + '" style="width:64px" title="Seconds to wait between the commands of this job (0 - 600)">'
        + '<button type="button" class="danger" data-del="' + i + '" title="Remove">&times;</button></div>').join('')
      + '<div class="row" style="margin-top:8px"><button type="button" id="rcAdd">+ Add command</button><button type="button" id="rcSave" class="primary">Save commands</button></div>'
      + '<p class="muted small" style="margin:6px 0 0">Sent only while the server is running, once per minute at most, in this computer\'s local time. One command per line; the number is the pause in seconds between the lines. ' + (rcons.length ? 'RCON must be enabled in the game\'s config.' : 'This game has no RCON console, so the commands go to its own console.') + '</p>';
    host.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { read(); jobs.splice(+b.dataset.del, 1); paint(); }));
    $('#rcAdd').onclick = () => { read(); if (jobs.length >= 20) return toast('At most 20 scheduled commands', true); jobs.push({ enabled: true, cron: '*/30 * * * *', command: '', console: '', wait: 1 }); paint(); };
    $('#rcSave').onclick = async () => {
      read();
      const r = await run('save', s.id, { rconSchedule: jobs.map((j) => ({ enabled: j.enabled !== false, cron: String(j.cron || '').trim(), command: String(j.command || '').trim(), console: j.console || '', wait: j.wait === '' || j.wait === undefined ? 1 : Number(j.wait) })) });
      if (r !== undefined) toast('Scheduled commands saved');
    };
  };
  const read = () => host.querySelectorAll('.rc-row').forEach((row) => {
    const j = jobs[+row.dataset.i]; if (!j) return;
    row.querySelectorAll('[data-f]').forEach((el) => { j[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value; });
  });
  paint();
}
