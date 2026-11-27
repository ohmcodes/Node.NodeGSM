'use strict';
// Settings > Steam account: one-time SteamCMD sign-in for games that need an account that owns them (plugin install step "account": true).
// NodeGSM only remembers the account NAME. The password and the Steam Guard code go to SteamCMD once; SteamCMD keeps its own login token.
// Uses the globals of app.js (run, esc, $, toast).

async function steamPaint() {
  const box = $('#steamBox'); if (!box) return;
  const st = await run('steamStatus'); if (!st) { box.innerHTML = ''; return; }
  let guard = false;
  const draw = (msg, isErr) => {
    box.innerHTML = (st.username
      ? '<div class="srow"><span>Signed in as <b>' + esc(st.username) + '</b><small>Games that need a Steam account (it must own the game) use this login when they install or update. Games that work anonymously ignore it.</small></span><button type="button" id="steamOut">Sign out</button></div>'
      : '<p class="small muted" style="margin:0 0 8px">Most dedicated servers install anonymously. A few games only download for a Steam account that owns them; for those, sign in here once.</p>')
      + '<div class="row" style="margin-top:6px;flex-wrap:wrap"><input id="steamUser" placeholder="Steam account name" autocomplete="off" value="' + esc(st.username || '') + '" style="width:190px">'
      + '<input id="steamPass" type="password" placeholder="password" autocomplete="off" style="width:170px">'
      + '<input id="steamCode" placeholder="Steam Guard code" autocomplete="one-time-code" maxlength="10" style="width:150px" ' + (guard ? '' : 'hidden') + '>'
      + '<button type="button" id="steamIn" class="primary">' + (st.username ? 'Sign in again' : 'Sign in') + '</button></div>'
      + '<p class="small ' + (isErr ? 'err' : 'muted') + '" id="steamMsg" style="margin:6px 0 0">' + esc(msg || '') + '</p>'
      + '<p class="small muted" style="margin:4px 0 0">NodeGSM does not store the password: it is passed to SteamCMD once, which keeps its own login token. Use a separate Steam account for servers if you can (Steam Guard still applies).</p>';
    $('#steamIn').onclick = async () => {
      $('#steamMsg').textContent = 'Signing in ... (SteamCMD may need a minute)'; $('#steamIn').disabled = true;
      const r = await run('steamLogin', $('#steamUser').value.trim(), $('#steamPass').value, $('#steamCode').value.trim());
      if (!r) { $('#steamIn').disabled = false; return; }
      $('#steamPass') && ($('#steamPass').value = '');
      if (r.ok) { st.username = r.username; guard = false; draw('Signed in.', false); toast('Signed in to Steam'); return; }
      guard = !!r.needGuard; draw(r.error || 'Sign-in failed.', true); if (guard && $('#steamCode')) $('#steamCode').focus();
    };
    if ($('#steamOut')) $('#steamOut').onclick = async () => { if (!confirm('Sign out of Steam? Games that need an account cannot install or update until you sign in again.')) return; const r = await run('steamLogout'); if (r) { st.username = ''; draw('Signed out.', false); } };
  };
  draw('', false);
}
