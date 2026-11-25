'use strict';
// Builds the generated parts of the website from the repo (run after `npm run registry`):
//   website/data/site.json     version, counts, feature tables + changelog parsed from FEATURES.md
//   website/catalog/*          the plugin catalog (index.json, zips/, icons/) - see scripts/build-catalog.js
// All of it is generated (gitignored). In production the site can read the catalog from another host: CATALOG_URL in website/config.js.
//   node scripts/build-site.js
const fs = require('fs');
const path = require('path');
const { buildCatalog } = require('./build-catalog');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'website');

function parseFeatures(md) {
  const groups = []; const changelog = [];
  let section = null, group = null, entry = null;
  for (const line of md.split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^## (.+)/))) { section = m[1].trim(); group = null; entry = null; if (section !== 'Changelog') { group = { group: section, rows: [] }; groups.push(group); } continue; }
    if (section === 'Changelog') {
      if ((m = line.match(/^### (.+)/))) { entry = { title: m[1].trim(), items: [] }; changelog.push(entry); }
      else if (entry && (m = line.match(/^- (.+)/))) entry.items.push(m[1].trim());
      continue;
    }
    if (group && line.startsWith('|')) {
      const c = line.split('|').slice(1, -1).map((s) => s.trim());
      if (c.length >= 2 && c[0] && c[0] !== 'Feature' && !/^-+$/.test(c[0])) group.rows.push({ feature: c[0], status: c[1], notes: c[2] || '' });
    }
  }
  return { groups, changelog };
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const { groups, changelog } = parseFeatures(fs.readFileSync(path.join(ROOT, 'FEATURES.md'), 'utf8'));
  // clean up output of the first site version
  for (const old of ['assets/plugins', 'downloads', 'data/plugins.json']) fs.rmSync(path.join(SITE, old), { recursive: true, force: true });

  const plugins = buildCatalog(path.join(SITE, 'catalog'));
  const all = groups.flatMap((g) => g.rows);
  const count = (s) => all.filter((r) => r.status.includes(s)).length;
  fs.mkdirSync(path.join(SITE, 'data'), { recursive: true });
  fs.writeFileSync(path.join(SITE, 'data', 'site.json'), JSON.stringify({
    version: pkg.version, name: 'NodeGSM', pluginCount: plugins.length,
    featureCounts: { done: count('✅'), untested: count('🧪'), planned: count('⏳') },
    groups, changelog, repo: 'https://github.com/ohmcodes/Node.WGSM2026',
  }, null, 1));
  console.log(`site data built: ${plugins.length} plugins, ${groups.length} feature groups, ${changelog.length} changelog entries`);
}
main();
