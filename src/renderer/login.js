'use strict';
// Sign-in page of the web mode: first-time setup (access token + new owner account), then username + password (+ authenticator code).
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var form = $('loginForm'); var msg = $('loginMsg'); var btn = $('loginBtn');
  var mode = 'login'; var challenge = '';

  function show(m) {
    mode = m;
    $('fToken').hidden = m !== 'setup'; $('fUser').hidden = m === 'code'; $('fCode').hidden = m !== 'code';
    $('loginHint').textContent = m === 'setup' ? 'First start: create the owner account. The access token proves you control this computer; it is only needed once.' : m === 'code' ? 'Two-factor authentication: enter the 6-digit code.' : 'Sign in with your account.';
    $('lblPass').textContent = m === 'setup' ? 'Choose a password (10+ characters)' : 'Password';
    $('loginPass').autocomplete = m === 'setup' ? 'new-password' : 'current-password';
    btn.textContent = m === 'setup' ? 'Create account' : m === 'code' ? 'Verify' : 'Sign in';
    var f = m === 'setup' ? $('loginToken') : m === 'code' ? $('loginCode') : $('loginUser'); f.focus();
  }

  async function post(url, body) {
    var r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var j = {}; try { j = await r.json(); } catch (x) { /* not json */ }
    return { r: r, j: j };
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    msg.textContent = ''; btn.disabled = true;
    try {
      var res;
      if (mode === 'setup') res = await post('/setup', { token: $('loginToken').value, username: $('loginUser').value, password: $('loginPass').value });
      else if (mode === 'code') res = await post('/login', { challenge: challenge, code: $('loginCode').value });
      else res = await post('/login', { username: $('loginUser').value, password: $('loginPass').value });
      if (res.j.need2fa) { challenge = res.j.challenge; $('loginCode').value = ''; show('code'); btn.disabled = false; return; }
      if (res.r.ok && res.j.ok) { location.href = res.j.limited ? '/account.html' : '/'; return; }
      msg.textContent = res.j.error || ('Sign-in failed (HTTP ' + res.r.status + ')');
      if (mode === 'code' && /expired/i.test(msg.textContent)) show('login');
    } catch (x) { msg.textContent = 'Cannot reach the server'; }
    btn.disabled = false;
    if (mode === 'code') { $('loginCode').select(); } else { $('loginPass').value = ''; }
  });

  fetch('/auth/status', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) { show(j && j.setup ? 'setup' : 'login'); }).catch(function () { show('login'); });
})();
