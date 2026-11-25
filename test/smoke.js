'use strict';
// Headless tests of the server manager + plugin system (no Electron, no internet).
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http'); const assert = require('assert');
const AdmZip = require('adm-zip');
const { ServerManager } = require('../src/main/serverManager');
const P = require('../src/main/plugins');
const { runInstall } = require('../src/main/installRunner');
const { resolveLog } = require('../src/main/logTail');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodegsm-'));
const m = new ServerManager(dir);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eq = assert.deepStrictEqual;

(async () => {
  // ---- catalog (everything is a plugin) ----
  assert(P.GAMES.length >= 46, 'bundled catalog loaded: ' + P.GAMES.length);
  assert(P.GAMES.every((g) => g.source === 'bundled' && g.exe && g.icon), 'all bundled with exe+icon');
  assert.strictEqual(m.pluginInfo.errors.length, 0, 'no plugin load errors: ' + JSON.stringify(m.pluginInfo.errors));
  for (const g of P.GAMES) assert(Array.isArray(g.args({ port: '1', param: 'a "b c"', map: 'x', name: 'n', ip: '1.2.3.4', maxPlayers: '8' }, { serverFiles: 'x' })), g.id);

  // ---- argument templates ----
  const ctx = { serverFiles: 'C:/s' };
  const cfg = { name: 'My Srv', ip: '', port: '7777', queryPort: '', map: 'M', maxPlayers: '8', gslt: '', param: '-a "b c"' };
  eq(P.expandItem('{param}', cfg, ctx), ['-a', 'b c']);
  eq(P.expandItem(['-ip', '{ip}'], cfg, ctx), [], 'group dropped when placeholder empty');
  eq(P.expandItem(['-port', '{port}'], cfg, ctx), ['-port', '7777']);
  eq(P.expandItem('-ServerName={name}', cfg, ctx), ['-ServerName=My Srv'], 'spaces stay in one argv');
  eq(P.expandItem('-Beacon={port+10}', cfg, ctx), ['-Beacon=7787']);
  eq(P.expandItem('[{map}]?listen[?Q={queryPort}][?P={port}]{paramRaw}', cfg, ctx), ['M?listen?P=7777-a "b c"'], 'optional parts + raw');
  eq(P.expandItem('[{ip}]', cfg, ctx), [], 'empty result dropped');

  // ---- built-in conversions behave like the C# originals ----
  m.create('csgo', 'Test CSGO');
  m.saveConfig('1', { gslt: 'TOK', port: '27015', ip: '' });
  eq(m.buildLaunch('1').args, ['-console', '-game', 'csgo', '-port', '27015', '-maxplayers_override', '24', '+sv_setsteamaccount', 'TOK', '-tickrate', '64', '-usercon', '+game_type', '0', '+game_mode', '0', '+mapgroup', 'mg_active', '+map', 'de_dust2']);
  const cs = P.byId('cs');
  eq(cs.steps.map((s) => s.type), ['steamcmd', 'write']); assert.strictEqual(cs.appId, '90', 'GoldSource installs HLDS app 90');
  eq(m.steam.buildArgs('D:/x', '90', { validate: true, mod: 'cstrike', repeat: 2 }),
    ['+force_install_dir', 'D:/x', '+login', 'anonymous', '+app_set_config', '90', 'mod', 'cstrike', '+app_update', '90', 'validate', '+app_update', '90', 'validate', '+quit']);
  const c2 = m.create('csgo', 'Second'); assert.notStrictEqual(m.getConfig('1').port, c2.port, 'port de-dup');
  const pal = m.create('palworld', 'My Pal'); m.saveConfig(pal.id, { ip: '', name: 'My Pal', param: '-publiclobby' });
  eq(m.buildLaunch(pal.id).args, ['-publiclobby', '-port=8211', '-publicport=8211', '-players=32', '-servername=My Pal']);
  eq(m.create('palworld', 'P2').port, '8213', 'portIncrement=2 respected');

  // ---- install steps: download + extract + write + mkdir against a local HTTP server ----
  const z = new AdmZip(); z.addFile('bin/tool.txt', Buffer.from('hello')); const zbuf = z.toBuffer();
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Length': zbuf.length }); r.end(zbuf); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/pkg.zip`;
  const idir = path.join(dir, 'inst'); const logs = [];
  const fakeGame = { appId: null, hooks: {}, steps: [
    { type: 'download', url, to: 'pkg.zip', extract: true, extractTo: 'app' },
    { type: 'mkdir', path: 'cfg/sub' },
    { type: 'write', path: 'cfg/server.ini', content: '[S]\nName={name}\n' },
  ] };
  await runInstall(fakeGame, { dir: idir, cfg: { name: 'Hello' }, log: (l) => logs.push(l), steam: null });
  assert.strictEqual(fs.readFileSync(path.join(idir, 'app/bin/tool.txt'), 'utf8'), 'hello', 'download+extract');
  assert(!fs.existsSync(path.join(idir, 'pkg.zip')), 'archive deleted after extract');
  assert.strictEqual(fs.readFileSync(path.join(idir, 'cfg/server.ini'), 'utf8'), '[S]\nName=Hello\n', 'write with placeholders');
  await assert.rejects(runInstall({ ...fakeGame, steps: [{ type: 'write', path: '../evil.txt', content: 'x' }] }, { dir: idir, cfg: {}, log() {} , steam: null }), /escapes/, 'path traversal blocked');
  await runInstall({ ...fakeGame, hooks: { install: async (h) => { await h.download(url, 'again.zip'); h.extract('again.zip', 'x'); } }, steps: [{ type: 'script' }] }, { dir: idir, cfg: {}, log() {}, steam: null });
  assert(fs.existsSync(path.join(idir, 'x/bin/tool.txt')), 'script hook helpers work');
  srv.close();

  // ---- validation ----
  assert(P.validate({ id: 'x' }, null).errors.length > 0, 'invalid plugin rejected');
  assert(P.validate({ id: 'ok1', name: 'N', install: { type: 'manual' }, run: { exe: '../up.exe' } }, null).errors.some((e) => /relative/.test(e)), 'exe traversal rejected');
  assert(P.validate({ id: 'ok1', name: 'N', install: { type: 'manual' }, run: { exe: 'a.exe' }, configs: [{ id: 'a', name: 'A', path: 'C:/win.ini' }] }, null).errors.length > 0, 'absolute config path rejected');

  // ---- user plugin install (zip) + override of a bundled game ----
  const pz = new AdmZip(); const man = JSON.parse(fs.readFileSync(path.join(P.BUNDLED_DIR, 'palworld', 'plugin.json'), 'utf8'));
  man.version = '9.9.9'; man.defaults.maxPlayers = '16';
  pz.addFile('palworld-fix/plugin.json', Buffer.from(JSON.stringify(man))); pz.addLocalFile(path.join(P.BUNDLED_DIR, 'palworld', 'icon.png'), 'palworld-fix'); pz.addFile('palworld-fix/README.md', Buffer.from('# local fix'));
  const zf = path.join(dir, 'p.zip'); pz.writeZip(zf);
  assert.strictEqual(m.installPlugin(zf), 'palworld');
  const over = P.byId('palworld'); assert(over.overrides && over.version === '9.9.9' && over.source === 'user', 'user plugin overrides bundled');
  fs.writeFileSync(path.join(m.pluginsDir, 'palworld', 'plugin.json'), '{ broken');
  const info = m.reloadPlugins(); assert(info.errors.length === 1 && P.byId('palworld').source === 'bundled', 'broken override reported, bundled still works');
  fs.rmSync(path.join(m.pluginsDir, 'palworld'), { recursive: true, force: true }); m.reloadPlugins();

  // ---- plugin-declared config files ----
  const cid = m.create('mc', 'MC').id; const mcdir = m.filesDir(cid);
  let cl = m.configList(cid); assert(cl.length === 3 && cl[0].exists === false, 'config list');
  m.createConfig(cid, 'whitelist'); assert.strictEqual(m.readConfig(cid, 'whitelist').text, '{}\n', 'json created');
  m.writeConfig(cid, 'whitelist', '[1]'); m.writeConfig(cid, 'whitelist', '[2]');
  assert(fs.existsSync(path.join(mcdir, 'whitelist.json.bak')), '.bak kept'); assert.strictEqual(fs.readFileSync(path.join(mcdir, 'whitelist.json.bak'), 'utf8'), '[1]');
  assert.throws(() => m.writeConfig(cid, 'whitelist', '{nope'), /valid JSON/, 'json validated');
  assert.throws(() => m.readConfig(cid, '../x'), /Unknown/, 'unknown config id');
  fs.writeFileSync(path.join(mcdir, 'server.properties'), '\uFEFFa=1\n'); assert.strictEqual(m.readConfig(cid, 'server-properties').text, 'a=1\n', 'BOM stripped');

  // ---- live logs ----
  fs.mkdirSync(path.join(mcdir, 'logs'), { recursive: true });
  const lf = path.join(mcdir, 'logs', 'latest.log'); fs.writeFileSync(lf, 'one\ntwo\n');
  assert(m.logsList(cid)[0].file === path.join('logs', 'latest.log'), 'log resolved');
  const got = []; m.on('logLines', (e) => got.push(e));
  const first = m.logStart(cid, 'latest'); eq(first.lines, ['one', 'two']);
  fs.appendFileSync(lf, 'three\nfour\n'); await sleep(1500);
  eq(got.flatMap((e) => e.lines), ['three', 'four'], 'appended lines streamed');
  fs.writeFileSync(lf, 'new\n'); await sleep(1500); // truncated / rotated in place
  assert(got.some((e) => e.reset) && got.flatMap((e) => e.lines).includes('new'), 'rotation handled');
  m.logStop(cid, 'latest');
  fs.writeFileSync(path.join(mcdir, 'logs', 'a.log'), 'x'); await sleep(20); fs.writeFileSync(path.join(mcdir, 'logs', 'b.log'), 'y');
  assert.strictEqual(path.basename(resolveLog(mcdir, 'logs/*.log')), 'b.log', 'wildcard picks newest');
  assert.strictEqual(resolveLog(mcdir, '../../etc/*.log'), null, 'log path escape blocked');

  // ---- documentation links ----
  assert(P.GAMES.every((g) => g.docs.length >= 1), 'every bundled plugin has docs links');
  assert(P.GAMES.every((g) => g.docs.every((d) => /^https?:\/\//.test(d.url) && ['official', 'unofficial'].includes(d.type) && d.title)), 'docs entries are well-formed');
  assert(P.detail('palworld').docs.some((d) => d.type === 'official') && P.detail('palworld').docs.some((d) => d.type === 'unofficial'), 'official + unofficial docs exposed to the game browser');
  const base = { id: 'okdocs', name: 'N', install: { type: 'manual' }, run: { exe: 'a.exe' } };
  assert.strictEqual(P.validate({ ...base, docs: [{ title: 'x', url: 'javascript:alert(1)', type: 'official' }, { title: 'y', url: 'https://a.b/c', type: 'maybe' }, { url: 'https://a.b', type: 'official' }] }, null).errors.length, 3, 'bad docs rejected (js: url, type, title)');
  assert.strictEqual(P.validate({ ...base, docs: [{ title: 'ok', url: 'https://a.b/c', type: 'unofficial', description: 'd' }] }, null).errors.length, 0, 'good docs accepted');
  assert(P.validate(base, null).warnings.some((w) => /docs/.test(w)), 'missing docs is a warning for local plugins');
  assert(require('../scripts/build-registry').buildRegistry().plugins.every((p) => Array.isArray(p.docs) && p.docs.length), 'registry carries docs');

  // ---- app settings (theme etc.) ----
  const S = require('../src/main/settings');
  eq(S.sanitize({ theme: 'neon', accent: 'red', evil: 1, animations: false, autoRestartApp: true }), { animations: false, autoRestartApp: true }, 'invalid theme/accent/unknown keys dropped');
  eq(S.sanitize({ theme: 'light', accent: '#2ECC71' }), { theme: 'light', accent: '#2ecc71' });
  assert.strictEqual(S.resolveTheme('system', false), 'light'); assert.strictEqual(S.resolveTheme('system', true), 'dark'); assert.strictEqual(S.resolveTheme('dark', false), 'dark');
  m.saveSettings({ theme: 'light', accent: '#1fb6d9', hardwareAcceleration: false });
  const persisted = S.read(dir);
  assert(persisted.theme === 'light' && persisted.accent === '#1fb6d9' && persisted.hardwareAcceleration === false && persisted.animations === true, 'settings persisted with defaults filled in');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ broken'); eq(S.read(dir), S.DEFAULTS, 'corrupt settings fall back to defaults');

  // ---- crash-restart policy ----
  const { shouldRestart } = require('../src/main/crash');
  let hist = []; const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) { const r = shouldRestart(hist, t0 + i * 1000); assert(r.allow, 'restart ' + (i + 1)); hist = r.history; }
  assert(!shouldRestart(hist, t0 + 5000).allow, '4th crash inside 10 minutes is a crash loop: do not relaunch');
  assert(shouldRestart(hist, t0 + 11 * 60 * 1000).allow, 'allowed again after the window');

  // ---- run a fake server end-to-end ----
  const fakeDir = path.join(dir, 'fake'); fs.mkdirSync(fakeDir);
  const g = P.byId('sw'); fs.copyFileSync(process.execPath, path.join(fakeDir, g.exe));
  const s = m.importServer('sw', 'Fake', fakeDir);
  m.saveConfig(s.id, { param: '-e "process.stdin.on(\'data\',d=>{console.log(\'got \'+d);if(/quit/.test(d))process.exit(0)});console.log(\'hello\');setInterval(()=>{},1000)"' });
  await m.start(s.id); await sleep(800);
  assert(m.getConsole(s.id).some((x) => x.includes('hello')), 'console captured');
  m.sendCommand(s.id, 'ping'); await sleep(300);
  assert(m.getConsole(s.id).some((x) => x.includes('got ping')), 'stdin works');
  await m.stop(s.id); assert.strictEqual(m.view(s.id).status, 'Stopped');
  const b = await m.backup(s.id); assert(m.backupList(s.id).length === 1 && b); await m.restore(s.id, b);
  m.saveConfig(s.id, { restartCrontab: true, crontabFormat: '* * * * *' }); m.cronTick();
  await m.remove(s.id, true);

  // ---- plugin "metrics" validation + table/dashboard settings ----
  const mbase = { id: 'okmet', name: 'N', install: { type: 'manual' }, run: { exe: 'a.exe' }, logs: [{ id: 'l', name: 'L', path: 'x.log' }] };
  const mErr = (metrics) => P.validate({ ...mbase, metrics }, null).errors;
  assert.strictEqual(mErr([{ id: 'fps', name: 'FPS', source: 'console', pattern: 'fps=([0-9.]+)', command: 'stats', intervalSec: 5 }, { id: 'e', name: 'E', source: 'log:l', pattern: 'e (\\d+)' }]).length, 0, 'valid metrics');
  assert(mErr([{ id: 'x', name: 'X', source: 'console', pattern: 'no group here' }]).some((e) => /capture group/.test(e)), 'pattern needs a capture group');
  assert(mErr([{ id: 'x', name: 'X', source: 'console', pattern: '(' }]).some((e) => /regular expression/.test(e)), 'bad regex');
  assert(mErr([{ id: 'x', name: 'X', source: 'log:nope', pattern: '(\\d)' }]).some((e) => /undeclared log/.test(e)), 'unknown log source');
  assert(mErr([{ id: 'x', name: 'X', source: 'file', pattern: '(\\d)' }]).length > 0 && mErr([{ id: 'x', name: 'X', source: 'console', pattern: '(\\d)', intervalSec: 1 }]).length > 0, 'bad source / interval');
  eq(S.sanitize({ tableColumns: ['id', 'bad col!', 'm:fps', 7], view: 'table' }), { tableColumns: ['id', 'm:fps'], view: 'table' }, 'column ids sanitised, table view accepted');
  eq(S.sanitize({ view: 'weird', dashboardChart: 'cpu' }), { dashboardChart: 'cpu' });
  eq(S.DEFAULTS.tableColumns.slice(0, 5), ['id', 'pid', 'icon', 'status', 'name'], 'default columns follow the WindowsGSM layout');

  // ---- process tree totals ----
  const { treeTotals, MetricsCollector } = require('../src/main/metrics');
  const rows = [{ pid: 1, ppid: 0, mem: 10, cpuTime: 100, threads: 2 }, { pid: 2, ppid: 1, mem: 20, cpuTime: 50, threads: 3 }, { pid: 3, ppid: 2, mem: 5, cpuTime: 5, threads: 1 }, { pid: 9, ppid: 0, mem: 999, cpuTime: 999, threads: 9 }];
  eq(treeTotals(rows, 1), { mem: 35, cpuTime: 155, threads: 6, procs: 3 }, 'server tree = process + all children');

  // ---- kill, bulk actions, dashboard metrics (two fake servers) ----
  const mdir = path.join(dir, 'metricsrv'); fs.mkdirSync(mdir);
  fs.copyFileSync(process.execPath, path.join(mdir, P.byId('sw').exe));
  fs.writeFileSync(path.join(mdir, 'fake.js'), "let n=0;console.log('fps=60');process.stdin.on('data',d=>{const t=String(d);if(/quit/.test(t))process.exit(0);if(/stats/.test(t))console.log('fps='+(60+(++n)));});setInterval(()=>{},1000);");
  const sw = P.byId('sw');
  sw.logs = [{ id: 'l', name: 'L', path: 'x.log' }];
  sw.metrics = [{ id: 'fps', name: 'Server FPS', unit: 'fps', source: 'console', pattern: 'fps[:= ]+([0-9.]+)', command: 'stats', intervalSec: 2 }, { id: 'ents', name: 'Entities', source: 'log:l', pattern: 'entities (\\d+)' }];
  const a1 = m.importServer('sw', 'Alpha', mdir).id; const a2 = m.importServer('sw', 'Beta', mdir).id;
  for (const x of [a1, a2]) m.saveConfig(x, { param: 'fake.js' });
  const col = new MetricsCollector(m, { intervalMs: 1e9 }); col.start(); await sleep(200);
  eq((await m.bulk('start', [a1, a2, 'nope'])).map((r) => [r.id, r.ok]), [[a1, true], [a2, true]], 'bulk start (unknown id ignored)');
  assert(m.isRunning(a1) && m.isRunning(a2), 'both started');
  eq((await m.bulk('start', [a1, a2])).map((r) => r.skipped), [true, true], 'start on running servers is skipped, not an error');
  await sleep(1500);
  let snap = await col.tick(); await sleep(1200); snap = await col.tick();
  const r1 = snap.servers.find((r) => r.id === a1);
  assert(r1.pid && r1.mem > 1e6 && typeof r1.cpu === 'number' && r1.threads > 0, 'per-server cpu/memory/threads from the process tree: ' + JSON.stringify(r1));
  assert(r1.metrics['m:fps'] && r1.metrics['m:fps'].value >= 60 && r1.metrics['m:fps'].unit === 'fps', 'plugin metric from console');
  assert(snap.defs.some((d) => d.id === 'm:fps' && d.name === 'Server FPS'), 'metric definitions exposed for the column picker');
  assert(snap.game.online === 2 && snap.game.installed === m.list().length && snap.game.max === 100, 'game server counts');
  assert(snap.system.cores > 0 && snap.system.memTotal > snap.system.memUsed && snap.system.disk && snap.system.disk.total > 0, 'system metrics');
  const fps0 = r1.metrics['m:fps'].value; await sleep(2600); snap = await col.tick();
  assert(snap.servers.find((r) => r.id === a1).metrics['m:fps'].value > fps0, 'metric polled by sending the declared console command');
  fs.writeFileSync(path.join(mdir, 'x.log'), 'tick\nentities 42\n'); await sleep(2200); snap = await col.tick();
  assert(snap.servers.find((r) => r.id === a1).metrics['m:ents'].value === 42, 'plugin metric from a declared log file');
  assert(col.history.length >= 4 && col.history[col.history.length - 1].s[a1], 'history points recorded');
  await m.bulk('stop', [a1, a2]); assert(!m.isRunning(a1) && !m.isRunning(a2), 'bulk stop (parallel)');
  snap = await col.tick(); assert(snap.servers.every((r) => r.cpu == null && r.mem == null) && !snap.servers.find((r) => r.id === a1).metrics['m:fps'], 'stopped servers have no live metrics');
  await m.bulk('start', [a1]); await sleep(400); const k0 = Date.now(); await m.bulk('kill', [a1]);
  assert(!m.isRunning(a1) && Date.now() - k0 < 6000, 'kill force-stops immediately');
  eq((await m.bulk('stop', [a1])).map((r) => r.skipped), [true], 'stop on a stopped server is skipped');
  await assert.rejects(m.bulk('explode', [a1]), /Unknown action/, 'unknown bulk action rejected');
  const bk = await m.bulk('backup', [a1, a2]); assert(bk.every((r) => r.ok) && m.backupList(a1).length === 1 && m.backupList(a2).length === 1, 'bulk backup, one after another');
  col.stop(); await m.remove(a1, true); await m.remove(a2, true);

  console.log('smoke test passed');
  m.logTail.shutdown(); fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
