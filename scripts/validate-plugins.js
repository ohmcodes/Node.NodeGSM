'use strict';
// Validates every plugins/<id>/ folder. Used locally (`npm run validate:plugins`) and by CI on pull requests.
//   node scripts/validate-plugins.js            validate everything
//   node scripts/validate-plugins.js mygame     validate one plugin
//   node scripts/validate-plugins.js --check    also fail if plugins/registry.json is out of date
const fs = require('fs');
const path = require('path');
const { validate } = require('../src/main/plugins');
const { buildRegistry } = require('./build-registry');

const ROOT = path.join(__dirname, '..', 'plugins');
const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('--'));
const folders = fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  .filter((n) => !only.length || only.includes(n));

let bad = 0; let warns = 0; const ids = new Map();
for (const f of folders) {
  const dir = path.join(ROOT, f);
  const mf = path.join(dir, 'plugin.json');
  const out = [];
  if (!fs.existsSync(mf)) { console.log(`✖ ${f}: plugin.json missing`); bad++; continue; }
  let m;
  try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) { console.log(`✖ ${f}: invalid JSON - ${e.message}`); bad++; continue; }
  const { errors, warnings } = validate(m, dir);
  const template = f === '_template';
  if (!template) {
    if (m.id !== f) errors.push(`folder name "${f}" must equal id "${m.id}"`);
    if (!fs.existsSync(path.join(dir, 'icon.png')) && !(m.media && m.media.icon)) errors.push('icon.png is required');
    if (!fs.existsSync(path.join(dir, (m.media && m.media.readme) || 'README.md'))) errors.push('README.md is required');
    if (!m.description) errors.push('"description" is required');
    if (!m.author) errors.push('"author" is required');
    if (ids.has(m.id)) errors.push(`duplicate id (also in ${ids.get(m.id)})`);
    ids.set(m.id, f);
  }
  out.push(...errors.map((e) => `  ✖ ${e}`), ...warnings.filter((w) => !errors.length).map((w) => `  ! ${w}`));
  if (errors.length) { bad++; console.log(`✖ ${f}`); } else console.log(`✔ ${f}`);
  if (out.length) console.log(out.join('\n'));
  warns += warnings.length;
}

if (args.includes('--check') && !only.length) {
  const file = path.join(ROOT, 'registry.json');
  const want = JSON.stringify(buildRegistry(), null, 2) + '\n';
  const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
  if (have !== want) { console.log('✖ plugins/registry.json is out of date - run: npm run registry'); bad++; }
}

console.log(`\n${folders.length} plugin(s) checked, ${bad} with errors, ${warns} warning(s).`);
process.exit(bad ? 1 : 0);
