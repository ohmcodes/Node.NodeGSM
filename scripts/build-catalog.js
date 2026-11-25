'use strict';
// Builds the plugin CATALOG: the single published index that the website and the app (online mode) both read.
//   node scripts/build-catalog.js [outDir]      default outDir: catalog/
// Output (relative URLs, resolved against the index.json location, so it can be hosted anywhere):
//   index.json          { schema, count, tags, plugins:[{ id, name, version, sha256, size, hasScript, zip, icon, readme, ... }] }
//   zips/<id>.zip       one zip per plugin folder (deterministic, so sha256 only changes when the plugin changes)
//   icons/<id>.png
// This script is meant to move to the plugins repository unchanged; it only reads plugins/ (and plugins/registry.json).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const ROOT = path.join(__dirname, '..');
const FIXED_TIME = new Date(Date.UTC(2020, 0, 1)); // deterministic zips

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, base, out); else out.push(f);
  }
  return out;
}

function zipPlugin(dir, id) {
  const zip = new AdmZip();
  for (const f of walk(dir)) {
    const rel = path.relative(dir, f).split(path.sep).join('/');
    zip.addFile(`${id}/${rel}`, fs.readFileSync(f));
  }
  zip.getEntries().forEach((e) => { e.header.time = FIXED_TIME; });
  return zip.toBuffer();
}

function buildCatalog(outDir, opts = {}) {
  const repo = opts.repo || 'https://github.com/ohmcodes/Node.WGSM2026';
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'registry.json'), 'utf8'));
  fs.rmSync(path.join(outDir, 'zips'), { recursive: true, force: true });
  fs.rmSync(path.join(outDir, 'icons'), { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'zips'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'icons'), { recursive: true });

  const plugins = reg.plugins.map((p) => {
    const dir = path.join(ROOT, p.folder);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    const buf = zipPlugin(dir, p.id);
    fs.writeFileSync(path.join(outDir, 'zips', `${p.id}.zip`), buf);
    const icon = path.join(ROOT, p.media.icon);
    if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(outDir, 'icons', `${p.id}.png`));
    const rp = path.join(ROOT, p.media.readme);
    return {
      id: p.id, name: p.name.replace(/ Dedicated Server$/, ''), fullName: p.name, description: p.description, author: p.author, version: p.version,
      url: p.url, tags: p.tags, docs: p.docs || [], install: p.install, steamAppId: p.steamAppId, ports: p.ports, maxPlayers: p.maxPlayers, query: p.query,
      configs: p.configs, logs: p.logs,
      hasScript: fs.existsSync(path.join(dir, 'plugin.js')),
      minAppVersion: manifest.minAppVersion || null,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length,
      zip: `zips/${p.id}.zip`, icon: `icons/${p.id}.png`,
      source: `${repo}/tree/main/${p.folder}`,
      readme: fs.existsSync(rp) ? fs.readFileSync(rp, 'utf8') : '',
    };
  });
  const tags = [...new Set(plugins.flatMap((p) => p.tags))].sort();
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ schema: 1, count: plugins.length, tags, plugins }, null, 1));
  return plugins;
}

module.exports = { buildCatalog };

if (require.main === module) {
  const out = path.resolve(process.argv[2] || path.join(ROOT, 'catalog'));
  const l = buildCatalog(out);
  console.log(`catalog built: ${l.length} plugins (${l.filter((p) => p.hasScript).length} with plugin.js) -> ${out}`);
}
