'use strict';
// Settings > Web access: browser access to this NodeGSM (desktop: on/off, address, port, HTTPS, 2FA policy) and the accounts
// that may sign in (owner only: users, roles, passwords, sessions). Uses the globals of app.js (run, esc, $, toast, state, isWeb).

const wa = { me: null, server: null, users: [], sessions: [] };
const waRoles = ['owner', 'admin', 'operator', 'viewer'];
const waScoped = (role) => role === 'operator' || role === 'viewer';   // only these can be limited to some servers
const waServersText = (u) => (!waScoped(u.role) ? 'all' : Array.isArray(u.servers) ? u.servers.length + ' server' + (u.servers.length === 1 ? '' : 's') : 'all');
const waWhen = (t) => (t ? new Date(t).toLocaleString() : 'never');

async function waPaint(settings) {
  const box = $('#waBox'); if (!box) return;
  wa.me = await run('webStatus'); if (!wa.me) { box.innerHTML = ''; return; }
  wa.server = state.features.webAccess ? await run('webServerStatus') : null;
  const owner = wa.me.role === 'owner';
  wa.users = owner ? ((await run('webUsers')) || []) : [];
  wa.sessions = (await run('webSessions')) || [];
  const w = (settings && settings.web) || {};
  let html = '';

  if (state.features.webAccess) {
    const net = w.host && !/^(127\.|::1$|localhost$)/i.test(w.host);
    html += `<div class="srow"><span>Allow access from a web browser<small>Opens NodeGSM at an address like http://localhost:8730. Starts together with NodeGSM, so after a reboot it is back as soon as NodeGSM runs (turn on <b>Start NodeGSM on Windows login</b> above).</small></span><input type="checkbox" class="switch" id="waOn" ${w.enabled ? 'checked' : ''}></div>`;
    html += `<div class="srow col" id="waCfg"><div class="row">
      <label class="small">Listen on <select id="waHost"><option value="127.0.0.1" ${net ? '' : 'selected'}>This computer only (127.0.0.1)</option><option value="0.0.0.0" ${net ? 'selected' : ''}>Other devices too (all network interfaces)</option></select></label>
      <label class="small">Port <input id="waPort" type="number" min="1" max="65535" value="${esc(w.port || 8730)}" style="width:90px"></label></div>
      <label class="check"><input type="checkbox" id="waHttps" ${w.https ? 'checked' : ''}> A reverse proxy in front provides HTTPS (cookies become Secure)</label>
      <label class="check"><input type="checkbox" id="waProxy" ${w.trustProxy ? 'checked' : ''}> Trust X-Forwarded-For from that proxy (only behind your own proxy)</label>
      <label class="check"><input type="checkbox" id="w2fa" ${w.require2fa ? 'checked' : ''}> Require two-factor authentication for every account</label>
      <div class="row"><button type="button" id="waSave" class="primary">Save</button></div></div>`;
    const sv = wa.server || {};
    html += `<div class="small ${sv.error ? 'err' : 'muted'}" id="waState">${sv.error ? esc(sv.error) : sv.running ? `Running: <b>${esc(sv.url)}</b> <button type="button" id="waOpen">Open</button> <button type="button" id="waCopy">Copy address</button>` : 'Not running.'}</div>`;
    if (net && !w.https) html += '<div class="small err" style="margin-top:6px">Warning: other devices can reach this over plain HTTP, so passwords can be read on the network. For the internet, put an HTTPS reverse proxy in front (see docs/GUIDE-web-linux.md), tick the HTTPS box and require two-factor.</div>';
    if (net && !w.require2fa) html += '<div class="small err">Two-factor authentication is strongly recommended when the page is reachable from other networks.</div>';
    if (state.platform === 'windows') html += '<div class="srow col" id="waSvc" style="margin-top:10px"><span class="muted small">Background start (Windows) ...</span></div>';
  }

  if (owner) {
    html += '<h4 style="margin-top:14px">Accounts</h4>';
    if (!wa.users.length) html += `<p class="small muted">No account yet. ${wa.me.local ? 'Create the first owner below. Until then the page can only be opened with the shared access token, and listening on the network is blocked.' : ''}</p>`;
    else html += `<table><tr><th>User</th><th>Role</th><th>2FA</th><th>Servers</th><th>Last sign-in</th><th></th></tr>${wa.users.map((u) => `<tr data-u="${esc(u.username)}">
      <td>${esc(u.username)}</td><td><select class="wa-role">${waRoles.map((r) => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
      <td>${u.totp ? '<span class="badge Started">on</span>' : '<span class="badge">off</span>'}</td><td class="nw">${waScoped(u.role) ? '<button type="button" class="wa-srv" title="Limit this account to some servers">' + esc(waServersText(u)) + '</button>' : 'all'}</td><td class="nw">${esc(waWhen(u.lastLogin))}</td>
      <td class="bk-act"><input type="password" class="wa-pw" placeholder="new password" autocomplete="new-password" style="width:130px"><button class="wa-setpw">Set password</button>${u.totp ? '<button class="wa-no2fa">Remove 2FA</button>' : '<button class="wa-set2fa" title="Show the authenticator secret and confirm with a code">Set up 2FA</button>'}<button class="wa-del danger">Delete</button></td></tr>`).join('')}</table>`;
    html += `<div class="row" style="margin-top:8px"><input id="waNewUser" placeholder="username" autocomplete="off" style="width:140px"><input id="waNewPw" type="password" placeholder="password (10+ characters)" autocomplete="new-password" style="width:190px">
      <select id="waNewRole"><option>${wa.users.length ? 'viewer' : 'owner'}</option>${waRoles.filter((r) => r !== (wa.users.length ? 'viewer' : 'owner')).map((r) => `<option>${r}</option>`).join('')}</select><label class="check" style="display:inline-flex" title="After creating the account, show the authenticator secret to set up two-factor authentication"><input type="checkbox" id="waNew2fa"> set up 2FA now</label><button type="button" id="waAdd" class="primary">Add account</button></div>
      <p class="muted small">Owner: everything, including accounts. Admin: everything except accounts, the data folder and plugin installs. Operator: a viewer who can also start, stop, restart, use the console and make backups. Viewer: read-only (no files, configs, console commands or backups). Operators and viewers can be limited to chosen servers (the Servers button).${wa.me.local ? ' Once an account exists the shared token no longer signs in.' : ''}</p>`;
  }

  if (owner) html += '<div id="waEditor"></div>';
  html += '<h4 style="margin-top:14px">Signed-in sessions</h4>';
  html += wa.sessions.length ? `<table><tr><th>User</th><th>From</th><th>Signed in</th><th>Last used</th><th></th></tr>${wa.sessions.map((s) => `<tr data-h="${esc(s.handle)}"><td>${esc(s.user || 'access token')}${s.current ? ' <span class="badge">this browser</span>' : ''}</td><td class="nw">${esc(s.ip)}</td><td class="nw">${esc(waWhen(s.created))}</td><td class="nw">${esc(waWhen(s.last))}</td><td><button class="wa-kill">Sign out</button></td></tr>`).join('')}</table>` : '<p class="small muted">Nobody is signed in on the web page.</p>';
  if (!wa.me.local) html += '<div class="row" style="margin-top:8px"><a href="/account.html"><button type="button">My account: password and two-factor...</button></a></div>';
  box.innerHTML = html;
  waWire(box);
  if ($('#waSvc')) waService();
}

function waWire(box) {
  const settingsPatch = () => ({ web: { enabled: $('#waOn').checked, host: $('#waHost').value, port: Number($('#waPort').value), https: $('#waHttps').checked, trustProxy: $('#waProxy').checked, require2fa: $('#w2fa').checked, sessionHours: 12 } });
  const save = async () => { const r = await run('saveSettings', settingsPatch()); if (r) waPaint(r); };
  if ($('#waOn')) { $('#waOn').onchange = save; $('#waSave').onclick = save; }
  if ($('#waOpen')) $('#waOpen').onclick = () => openLink(wa.server.url);
  if ($('#waCopy')) $('#waCopy').onclick = async () => { try { await navigator.clipboard.writeText(wa.server.url); toast('Address copied'); } catch { toast(wa.server.url); } };
  const again = async () => waPaint(await run('settings'));
  if ($('#waAdd')) $('#waAdd').onclick = async () => {
    const name = $('#waNewUser').value; const want2fa = $('#waNew2fa') && $('#waNew2fa').checked;
    const r = await run('webUserCreate', name, $('#waNewPw').value, $('#waNewRole').value);
    if (!r) return;
    toast('Account created'); await again();
    if (want2fa) waEnrol(name);
  };
  box.querySelectorAll('tr[data-u]').forEach((tr) => {
    const u = tr.dataset.u;
    tr.querySelector('.wa-role').onchange = async (e) => { const r = await run('webUserRole', u, e.target.value); if (r) toast('Role changed; their sessions were signed out'); again(); };
    const sb = tr.querySelector('.wa-srv'); if (sb) sb.onclick = () => waServers(u);
    const s2 = tr.querySelector('.wa-set2fa'); if (s2) s2.onclick = () => waEnrol(u);
    tr.querySelector('.wa-setpw').onclick = async () => { const r = await run('webUserPassword', u, tr.querySelector('.wa-pw').value); if (r) toast('Password changed; their sessions were signed out'); };
    const n = tr.querySelector('.wa-no2fa'); if (n) n.onclick = async () => { if (confirm(`Remove two-factor authentication from ${u}? They can set it up again after signing in.`) && await run('webUserTotpOff', u)) again(); };
    tr.querySelector('.wa-del').onclick = async () => { if (confirm(`Delete the account "${u}"? Its sessions are signed out.`) && await run('webUserDelete', u)) again(); };
  });
  box.querySelectorAll('tr[data-h]').forEach((tr) => { tr.querySelector('.wa-kill').onclick = async () => { await run('webSessionRevoke', tr.dataset.h); again(); }; });
}

/** Editor under the account table: which servers an operator / viewer account may use. */
function waServers(username) {
  const u = wa.users.find((x) => x.username === username); const ed = $('#waEditor'); if (!u || !ed) return;
  const all = [...state.servers.values()]; const sel = new Set(Array.isArray(u.servers) ? u.servers.map(String) : all.map((v) => String(v.id)));
  const every = !Array.isArray(u.servers);
  ed.innerHTML = '<div style="margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:8px"><b>Servers for ' + esc(username) + '</b> <span class="muted small">(' + esc(u.role) + ')</span>'
    + '<label class="check"><input type="checkbox" id="waSrvAll" ' + (every ? 'checked' : '') + '> All servers (including servers created later)</label>'
    + '<div id="waSrvList" ' + (every ? 'style="opacity:.5"' : '') + '>' + (all.length ? all.map((v) => '<label class="check"><input type="checkbox" data-id="' + esc(v.id) + '" ' + (sel.has(String(v.id)) ? 'checked' : '') + (every ? ' disabled' : '') + '> #' + esc(v.id) + ' ' + esc(v.name) + '</label>').join('') : '<span class="muted small">No servers yet.</span>') + '</div>'
    + '<div class="row" style="margin-top:8px"><button type="button" id="waSrvSave" class="primary">Save</button><button type="button" id="waSrvCancel">Cancel</button></div>'
    + '<p class="muted small" style="margin:6px 0 0">The account only sees these servers (list, console, backups, log and live updates). Their sessions are signed out when you save.</p></div>';
  $('#waSrvAll').onchange = (e) => { ed.querySelectorAll('#waSrvList input').forEach((i) => { i.disabled = e.target.checked; }); $('#waSrvList').style.opacity = e.target.checked ? '.5' : '1'; };
  $('#waSrvCancel').onclick = () => { ed.innerHTML = ''; };
  $('#waSrvSave').onclick = async () => {
    const ids = $('#waSrvAll').checked ? null : [...ed.querySelectorAll('#waSrvList input:checked')].map((i) => i.dataset.id);
    const r = await run('webUserServers', username, ids); if (r) { toast('Saved; their sessions were signed out'); waPaint(await run('settings')); }
  };
}

/** Two-factor enrolment of an account from the desktop window: show the secret, confirm with the first code, show the recovery codes once. */
async function waEnrol(username) {
  const ed = $('#waEditor'); if (!ed) return;
  const b = await run('webUserTotpBegin', username); if (!b) return;
  ed.innerHTML = '<div style="margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:8px"><b>Set up two-factor authentication for ' + esc(username) + '</b>'
    + '<p class="small muted" style="margin:6px 0">In an authenticator app (Google Authenticator, Authy, Aegis, 1Password ...) choose "enter a setup key" and type this key, then enter the 6-digit code it shows. The account holder keeps the app; nobody else needs the key.</p>'
    + '<div class="row"><code style="user-select:all;font-size:15px;letter-spacing:1px">' + esc(b.secret) + '</code><button type="button" id="waCopySecret">Copy key</button></div>'
    + '<p class="small muted" style="margin:6px 0 0">Or open this link on the phone that has the app: <code style="user-select:all;word-break:break-all">' + esc(b.uri) + '</code></p>'
    + '<div class="row" style="margin-top:8px"><input id="waEnrolCode" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code" style="width:110px"><button type="button" id="waEnrolOk" class="primary">Confirm</button><button type="button" id="waEnrolCancel">Cancel</button></div><div id="waEnrolOut"></div></div>';
  $('#waCopySecret').onclick = async () => { try { await navigator.clipboard.writeText(b.secret); toast('Key copied'); } catch { toast(b.secret); } };
  $('#waEnrolCancel').onclick = () => { ed.innerHTML = ''; };
  $('#waEnrolOk').onclick = async () => {
    const r = await run('webUserTotpConfirm', username, $('#waEnrolCode').value.trim()); if (!r) return;
    $('#waEnrolOut').innerHTML = '<p class="small err"><b>Recovery codes</b> (each works once if the phone is lost). Give them to ' + esc(username) + ' now; they are not shown again.</p><pre style="user-select:all">' + esc((r.recoveryCodes || []).join('\n')) + '</pre><div class="row"><button type="button" id="waEnrolDone" class="primary">Done</button></div>';
    $('#waEnrolDone').onclick = async () => { ed.innerHTML = ''; waPaint(await run('settings')); };
  };
}

/** Background start of the web mode without the window (Windows Task Scheduler task, see src/main/service.js). */
async function waService() {
  const box = $('#waSvc'); if (!box) return;
  const st = (await run('serviceStatus')) || {};
  if (st.supported === false) { box.hidden = true; return; }
  box.innerHTML = '<div><b>Run without the app (background start)</b><small class="muted" style="display:block">Starts the web page from a Windows scheduled task, hidden, so it is up after a reboot without opening NodeGSM. It uses the settings above and this data folder, so <b>close the desktop app first</b>: only one of them may manage the servers at a time.</small></div>'
    + '<div class="small ' + (st.running ? '' : 'muted') + '">' + (st.installed ? 'Task installed' + (st.mode === 'boot' ? ' (at Windows start)' : st.mode === 'logon' ? ' (at sign-in)' : '') + ' - ' + (st.running ? '<b>running</b>' : 'not running right now') : 'Not installed') + '</div>'
    + (st.installed ? '<div class="row"><button type="button" id="waSvcOff">Remove the task</button></div>'
      : '<div class="row"><select id="waSvcMode"><option value="logon">At sign-in (no administrator needed)</option><option value="boot">At Windows start, before anyone signs in (needs administrator)</option></select><button type="button" id="waSvcOn" class="primary">Install</button></div>')
    + '<p class="small muted" style="margin:0">The first time, open the page and create the owner account (the access token is in <code>web-token</code> in the data folder). Output goes to <code>logs/service.log</code>.</p>';
  if ($('#waSvcOn')) $('#waSvcOn').onclick = async () => {
    if (!confirm('Install the background start? Close the NodeGSM desktop app after this (or remove the task again): the task starts its own copy of the web server on this data folder.')) return;
    const r = await run('serviceInstall', $('#waSvcMode').value); if (r) { toast('Background task installed'); waService(); }
  };
  if ($('#waSvcOff')) $('#waSvcOff').onclick = async () => { const r = await run('serviceUninstall'); if (r) { toast('Background task removed'); waService(); } };
}
