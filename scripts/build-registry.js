'use strict';
// Builds plugins/registry.json - the machine-readable list of supported games.
// The in-app browser and the website read this (paths are relative to the repo root, e.g. plugins/palworld/icon.png).
//   node scripts/build-registry.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'plugins');

function buildRegistry() {
  const plugins = [];
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const mf = path.join(ROOT, e.name, 'plugin.json');
    if (!fs.existsSync(mf)) continue;
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    const media = m.media || {};
    const rel = (f) => `plugins/${e.name}/${f}`;
    const steps = m.install && m.install.steps ? m.install.steps : m.install && m.install.type === 'steamcmd' ? [{ type: 'steamcmd', appId: m.install.appId }] : [];
    const steam = steps.find((s) => s.type === 'steamcmd');
    const d = m.defaults || {};
    plugins.push({
      id: m.id, name: m.name, description: m.description || '', author: m.author || '', version: m.version || '', url: m.url || '',
      tags: m.tags || [],
      docs: (m.docs || []).map((d) => ({ title: d.title, url: d.url, type: d.type, description: d.description || '' })),
      install: steam ? 'steamcmd' : steps.length ? 'download' : 'manual',
      steamAppId: steam ? String(steam.appId) : null,
      ports: { game: d.port || null, query: d.queryPort || null },
      maxPlayers: d.maxPlayers || null, query: m.query || null,
      configs: (m.configs || []).map((c) => ({ name: c.name, path: c.path, format: c.format || 'text' })),
      logs: (m.logs || []).map((l) => ({ name: l.name, path: l.path })),
      metrics: (m.metrics || []).map((x) => ({ id: x.id, name: x.name, unit: x.unit || '' })),
      media: {
        icon: rel(media.icon || 'icon.png'),
        banner: media.banner ? rel(media.banner) : null,
        readme: rel(media.readme || 'README.md'),
        screenshots: (media.screenshots || []).map(rel),
      },
      folder: `plugins/${e.name}`,
    });
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return { schema: 1, count: plugins.length, plugins };
}

if (require.main === module) {
  const out = path.join(ROOT, 'registry.json');
  fs.writeFileSync(out, JSON.stringify(buildRegistry(), null, 2) + '\n');
  console.log(`Wrote ${path.relative(process.cwd(), out)}`);
}

module.exports = { buildRegistry };
