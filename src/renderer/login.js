'use strict';
// Login page of the web mode: posts the access token to /login (cookie session), then opens the app.
(function () {
  var form = document.getElementById('loginForm');
  var msg = document.getElementById('loginMsg');
  var input = document.getElementById('loginToken');
  var btn = document.getElementById('loginBtn');
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    msg.textContent = ''; btn.disabled = true;
    try {
      var r = await fetch('/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: input.value }) });
      var j = {}; try { j = await r.json(); } catch (x) { /* not json */ }
      if (r.ok && j.ok) { location.href = '/'; return; }
      msg.textContent = j.error || ('Login failed (HTTP ' + r.status + ')');
    } catch (x) { msg.textContent = 'Cannot reach the server'; }
    btn.disabled = false; input.select();
  });
  input.focus();
})();
