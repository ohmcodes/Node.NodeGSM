'use strict';
// Applies the saved appearance and panel layout synchronously so the window never flashes the wrong theme/layout.
(function () {
  var r = document.documentElement;
  try {
    var s = JSON.parse(localStorage.getItem('nodegsm.appearance') || '{}');
    var theme = s.theme === 'light' ? 'light' : s.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : 'dark';
    r.dataset.theme = theme;
    r.dataset.anim = s.animations === false ? 'off' : 'on';
    if (/^#[0-9a-f]{6}$/i.test(s.accent || '')) r.style.setProperty('--accent', s.accent);
  } catch (e) { /* defaults */ }
  try {
    var u = JSON.parse(localStorage.getItem('nodegsm.ui') || '{}');
    r.dataset.leftCollapsed = u.leftCollapsed ? '1' : '0';
    r.dataset.rightCollapsed = u.rightCollapsed ? '1' : '0';
    r.dataset.bottomCollapsed = u.bottomCollapsed ? '1' : '0';
    r.dataset.navCollapsed = u.navCollapsed ? '1' : '0';
  } catch (e) { /* defaults: nothing collapsed */ }
})();
