'use strict';
// nodegsm:// links, opened from the website catalogue ("Install in NodeGSM"). Only one action exists: nodegsm://install/<plugin id>.
// The id is checked against the same pattern the catalogue uses, and the app still asks the user before installing anything.
const SCHEME = 'nodegsm';
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/; // same as catalogue.js

/** @returns {{action:'install', id:string}|null} null for anything that is not a valid link. */
function parseLink(raw) {
  let u; try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== SCHEME + ':' || u.username || u.password) return null;
  const parts = [u.hostname, ...u.pathname.split('/')].filter(Boolean);
  if (parts.length !== 2 || parts[0] !== 'install' || !ID_RE.test(parts[1])) return null;
  return { action: 'install', id: parts[1] };
}

/** First nodegsm:// link in a command line (Windows/Linux pass the link as an argument). */
function linkFromArgv(argv) { return (argv || []).find((a) => typeof a === 'string' && a.toLowerCase().startsWith(SCHEME + '://')) || null; }

module.exports = { SCHEME, parseLink, linkFromArgv };
