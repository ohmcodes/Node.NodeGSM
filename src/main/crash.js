'use strict';
// Crash-restart policy: relaunch at most `max` times inside `windowMs`, so a crash loop can't spin forever.
function shouldRestart(history, now, max = 3, windowMs = 10 * 60 * 1000) {
  const recent = (history || []).filter((t) => now - t < windowMs);
  return { allow: recent.length < max, history: [...recent, now] };
}
module.exports = { shouldRestart };
