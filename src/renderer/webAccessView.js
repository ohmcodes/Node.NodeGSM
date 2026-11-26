'use strict';
// Settings > Web access: browser access to this NodeGSM (desktop: on/off, address, port, HTTPS, 2FA policy) and the accounts
// that may sign in (owner only: users, roles, passwords, sessions). Uses the globals of app.js (run, esc, $, toast, state, isWeb).

const wa = { me: null, server: null, users: [], sessions: [] };
const waRoles = ['owner', 'admin', 'viewer'];
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
  }

  if (owner) {
    html += '<h4 style="margin-top:14px">Accounts</h4>';
    if (!wa.users.length) html += `<p class="small muted">No account yet. ${wa.me.local ? 'Create the first owner below. Until then the page can only be opened with the shared access token, and listening on the network is blocked.' : ''}</p>`;
    else html += `<table><tr><th>User</th><th>Role</th><th>2FA</th><th>Last sign-in</th><th></th></tr>${wa.users.map((u) => `<tr data-u="${esc(u.username)}">
      <td>${esc(u.username)}</td><td><select class="wa-role">${waRoles.map((r) => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
      <td>${u.totp ? '<span class="badge Started">on</span>' : '<span class="badge">off</span>'}</td><td class="nw">${esc(waWhen(u.lastLogin))}</td>
      <td class="bk-act"><input type="password" class="wa-pw" placeholder="new password" autocomplete="new-password" style="width:130px"><button class="wa-setpw">Set password</button>${u.totp ? '<button class="wa-no2fa">Remove 2FA</button>' : ''}<button class="wa-del danger">Delete</button></td></tr>`).join('')}</table>`;
    html += `<div class="row" style="margin-top:8px"><input id="waNewUser" placeholder="username" autocomplete="off" style="width:140px"><input id="waNewPw" type="password" placeholder="password (10+ characters)" autocomplete="new-password" style="width:190px">
      <select id="waNewRole"><option>${wa.users.length ? 'viewer' : 'owner'}</option>${waRoles.filter((r) => r !== (wa.users.length ? 'viewer' : 'owner')).map((r) => `<option>${r}</option>`).join('')}</select><button type="button" id="waAdd" class="primary">Add account</button></div>
      <p class="muted small">Owner: everything, including accounts. Admin: everything except accounts, the data folder and plugin installs. Viewer: read-only (no files, configs, console commands or backups).${wa.me.local ? ' Once an account exists the shared token no longer signs in.' : ''}</p>`;
  }

  html += '<h4 style="margin-top:14px">Signed-in sessions</h4>';
  html += wa.sessions.length ? `<table><tr><th>User</th><th>From</th><th>Signed in</th><th>Last used</th><th></th></tr>${wa.sessions.map((s) => `<tr data-h="${esc(s.handle)}"><td>${esc(s.user || 'access token')}${s.current ? ' <span class="badge">this browser</span>' : ''}</td><td class="nw">${esc(s.ip)}</td><td class="nw">${esc(waWhen(s.created))}</td><td class="nw">${esc(waWhen(s.last))}</td><td><button class="wa-kill">Sign out</button></td></tr>`).join('')}</table>` : '<p class="small muted">Nobody is signed in on the web page.</p>';
  if (!wa.me.local) html += '<div class="row" style="margin-top:8px"><a href="/account.html"><button type="button">My account: password and two-factor...</button></a></div>';
  box.innerHTML = html;
  waWire(box);
}

function waWire(box) {
  const settingsPatch = () => ({ web: { enabled: $('#waOn').checked, host: $('#waHost').value, port: Number($('#waPort').value), https: $('#waHttps').checked, trustProxy: $('#waProxy').checked, require2fa: $('#w2fa').checked, sessionHours: 12 } });
  const save = async () => { const r = await run('saveSettings', settingsPatch()); if (r) waPaint(r); };
  if ($('#waOn')) { $('#waOn').onchange = save; $('#waSave').onclick = save; }
  if ($('#waOpen')) $('#waOpen').onclick = () => openLink(wa.server.url);
  if ($('#waCopy')) $('#waCopy').onclick = async () => { try { await navigator.clipboard.writeText(wa.server.url); toast('Address copied'); } catch { toast(wa.server.url); } };
  const again = async () => waPaint(await run('settings'));
  if ($('#waAdd')) $('#waAdd').onclick = async () => { const r = await run('webUserCreate', $('#waNewUser').value, $('#waNewPw').value, $('#waNewRole').value); if (r) { toast('Account created'); again(); } };
  box.querySelectorAll('tr[data-u]').forEach((tr) => {
    const u = tr.dataset.u;
    tr.querySelector('.wa-role').onchange = async (e) => { const r = await run('webUserRole', u, e.target.value); if (r) toast('Role changed; their sessions were signed out'); again(); };
    tr.querySelector('.wa-setpw').onclick = async () => { const r = await run('webUserPassword', u, tr.querySelector('.wa-pw').value); if (r) toast('Password changed; their sessions were signed out'); };
    const n = tr.querySelector('.wa-no2fa'); if (n) n.onclick = async () => { if (confirm(`Remove two-factor authentication from ${u}? They can set it up again after signing in.`) && await run('webUserTotpOff', u)) again(); };
    tr.querySelector('.wa-del').onclick = async () => { if (confirm(`Delete the account "${u}"? Its sessions are signed out.`) && await run('webUserDelete', u)) again(); };
  });
  box.querySelectorAll('tr[data-h]').forEach((tr) => { tr.querySelector('.wa-kill').onclick = async () => { await run('webSessionRevoke', tr.dataset.h); again(); }; });
}
