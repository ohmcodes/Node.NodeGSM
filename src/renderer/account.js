'use strict';
// Account page of the web mode: password, two-factor authentication, other sessions. Talks to the web* API channels.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var msg = $('acMsg');
  function say(t, bad) { msg.textContent = t; msg.style.color = bad ? 'var(--bad)' : 'var(--muted)'; }
  async function call(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    var r = await fetch('/api/' + encodeURIComponent(name), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: args }) });
    if (r.status === 401) { location.href = '/login.html'; throw new Error('Signed out'); }
    var j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Request failed');
    return j.data;
  }
  async function act(fn, ok) { try { var v = await fn(); if (ok) say(ok); return v; } catch (e) { say(e.message, true); } }

  async function paint() {
    var a = await call('webAccount');
    $('acUser').textContent = a.username; $('acRole').textContent = a.role;
    $('acBanner').hidden = !a.limited; $('acBack').hidden = !!a.limited;
    $('tfOff').hidden = a.totp; $('tfOn').hidden = !a.totp;
    $('tfLeft').textContent = a.recoveryLeft + ' recovery code(s) left';
  }

  $('acOut').onclick = async function () { await fetch('/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }); location.href = '/login.html'; };
  $('acOthers').onclick = function () { act(async function () { var n = await call('webSignOutOthers'); say(n + ' other session(s) signed out.'); }); };
  $('pwBtn').onclick = function () { act(async function () { await call('webPasswordChange', $('pwOld').value, $('pwNew').value); $('pwOld').value = ''; $('pwNew').value = ''; say('Password changed.'); }); };
  $('tfBegin').onclick = function () { act(async function () { var t = await call('webTotpBegin'); $('tfSecret').textContent = t.secret.replace(/(.{4})/g, '$1 ').trim(); $('tfUri').textContent = 'otpauth link'; $('tfUri').href = t.uri; $('tfSetup').hidden = false; }); };
  $('tfConfirm').onclick = function () { act(async function () { var codes = await call('webTotpConfirm', $('tfCode').value); $('tfList').textContent = codes.join('\n'); $('tfCodes').hidden = false; $('tfSetup').hidden = true; say('Two-factor authentication is on.'); await paint(); $('tfCodes').hidden = false; }); };
  $('tfDisable').onclick = function () { act(async function () { await call('webTotpDisable', $('tfPw').value); $('tfPw').value = ''; $('tfCodes').hidden = true; say('Two-factor authentication is off.'); await paint(); }); };
  paint().catch(function (e) { say(e.message, true); });
})();
