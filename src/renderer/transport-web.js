'use strict';
// Web transport: defines window.wgsm = { call, on, mode } over fetch + WebSocket, with the same semantics as preload.js
// (call throws on { ok:false }; on(channel, cb) returns an unsubscribe function).
// In the Electron app preload.js has already defined window.wgsm, so this file does nothing there.
(function () {
  if (window.wgsm) return;
  var listeners = Object.create(null);
  var ws = null; var delay = 500; var closedByPage = false;

  function toLogin() { if (location.pathname !== '/login.html') location.href = '/login.html'; }

  async function call(name, ...args) {
    var r;
    try {
      r = await fetch('/api/' + encodeURIComponent(name), {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: args }),
      });
    } catch (e) { throw new Error('Cannot reach the NodeGSM server'); }
    if (r.status === 401) { toLogin(); throw new Error('Signed out - please log in again'); }
    var j; try { j = await r.json(); } catch (e) { throw new Error('Unexpected response from the server (HTTP ' + r.status + ')'); }
    if (!j.ok) throw new Error(j.error || 'Request failed');
    return j.data;
  }

  function on(ch, cb) {
    (listeners[ch] = listeners[ch] || new Set()).add(cb);
    return function () { listeners[ch].delete(cb); };
  }

  function connect() {
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    try { ws = new WebSocket(url); } catch (e) { return retry(); }
    ws.onopen = function () { delay = 500; };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      var set = m && listeners[m.ch];
      if (set) set.forEach(function (cb) { try { cb(m.payload); } catch (e) { /* a broken listener must not stop the others */ } });
    };
    ws.onclose = function (ev) {
      if (closedByPage) return;
      if (ev && ev.code === 4401) return toLogin();
      retry();
    };
    ws.onerror = function () { /* onclose follows */ };
  }
  function retry() {
    var d = delay; delay = Math.min(delay * 2, 15000);
    setTimeout(async function () {
      // a refused upgrade (expired session) looks like a plain close: probe the API to tell, so we can redirect to login
      try { var r = await fetch('/api/platformInfo', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{"args":[]}' }); if (r.status === 401) return toLogin(); } catch (e) { /* server down: keep retrying */ }
      connect();
    }, d);
  }
  window.addEventListener('beforeunload', function () { closedByPage = true; if (ws) try { ws.close(); } catch (e) { /* ignore */ } });

  window.wgsm = { call: call, on: on, mode: 'web' };
  connect();
})();
