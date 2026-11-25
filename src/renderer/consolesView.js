'use strict';
// Console tab: the game console plus the plugin's injected consoles (log tail, RCON) as sub-tabs.
// A game without consoles[] looks exactly like before (no sub-tab bar). Uses the globals of app.js (api, run, esc, $, state).

const conState = { lists: {}, sub: 'main', sid: null, bufs: {}, logOn: null };   // bufs: "<server>:<console>" -> lines
const CON_MAX = 2000;
const conKey = (sid, cid) => `${sid}:${cid}`;

function stopConsoleLog() {
  if (conState.logOn) { api.call('consoleStop', conState.logOn.sid, conState.logOn.cid).catch(() => {}); conState.logOn = null; }
}

function conPaint(lines) {
  const out = $('#conOut'); if (!out) return;
  out.textContent = lines.join('\n'); out.scrollTop = out.scrollHeight;
}

async function conSwitch(s, cid) {
  const same = conState.logOn && conState.logOn.sid === s.id && conState.logOn.cid === cid;   // a status refresh re-rendered the tab: keep following
  if (!same) stopConsoleLog();
  conState.sub = cid; conState.sid = s.id;
  const list = conState.lists[s.id] || []; const c = list.find((x) => x.id === cid) || { id: 'main', type: 'process' };
  document.querySelectorAll('#con .subtabs button').forEach((b) => b.classList.toggle('on', b.dataset.c === cid));
  const inp = $('#conIn'); const btn = $('#conSend');
  if (c.type === 'process') {
    inp.disabled = false; btn.disabled = false;
    inp.placeholder = 'Type a command and press Enter (not supported by Source/GoldSource engines)';
    conPaint(state.consoleBuf); return;
  }
  if (c.type === 'rcon') {
    inp.disabled = false; btn.disabled = false; inp.placeholder = 'RCON command (connects on the first command; the server must be running and RCON enabled in its config)';
    conPaint(conState.bufs[conKey(s.id, cid)] || []); return;
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
    <div class="row"><input id="conIn" placeholder="Type a command and press Enter (not supported by Source/GoldSource engines)"><button id="conSend">Send</button></div></div>`;
  const out = $('#conOut');
  out.textContent = state.consoleBuf.join('\n');
  out.scrollTop = out.scrollHeight;
  const send = async () => {
    const v = $('#conIn').value; if (!v) return; $('#conIn').value = '';
    // main console output arrives through the 'console' event; RCON output through 'consoleOut'
    await run('consoleCommand', s.id, conState.sub, v);
  };
  $('#conSend').onclick = send;
  $('#conIn').onkeydown = (e) => { if (e.key === 'Enter') send(); };
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
  out.textContent = buf.join('\n');
  if (atBottom) out.scrollTop = out.scrollHeight;
});
