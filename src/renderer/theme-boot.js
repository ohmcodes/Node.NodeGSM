'use strict';
// Applies the saved appearance synchronously so the window never flashes the wrong theme.
(function () {
  try {
    var s = JSON.parse(localStorage.getItem('nodegsm.appearance') || '{}');
    var theme = s.theme === 'light' ? 'light' : s.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : 'dark';
    var r = document.documentElement;
    r.dataset.theme = theme;
    r.dataset.anim = s.animations === false ? 'off' : 'on';
    if (/^#[0-9a-f]{6}$/i.test(s.accent || '')) r.style.setProperty('--accent', s.accent);
  } catch (e) { /* defaults */ }
})();
