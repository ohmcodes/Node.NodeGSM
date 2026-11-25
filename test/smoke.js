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
const spawnKill = (pid) => require('child_process').spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });

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

  // ---- Phase 0: new optional plugin fields ----
  const xbase = { id: 'okext', name: 'N', install: { type: 'manual' }, run: { exe: 'a.exe' }, logs: [{ id: 'l', name: 'L', path: 'x.log' }], configs: [{ id: 'c', name: 'C', path: 'a.ini', protect: ['port', 'rcon.*'] }] };
  const xErr = (extra) => P.validate({ ...xbase, ...extra }, null).errors;
  const goodExt = {
    cluster: { protectedConfigKeys: ['port'], clearFolders: [{ path: 'Saved/Logs', pattern: '*.log', olderThanDays: 7 }], preserve: ['Saved/SaveGames'] },
    backup: { presets: [{ id: 'saves', name: 'Saves', paths: ['Saved/SaveGames'] }], exclude: ['*.tmp'] },
    events: [{ id: 'join', label: 'Join', default: true }],
    logging: { logFiles: ['logs/*.log'], patterns: [{ id: 'sud', regex: 'stopped suddenly', level: 'error' }] },
    consoles: [{ id: 'game', name: 'Game', type: 'process' }, { id: 'lg', name: 'Log', type: 'log', source: 'l' }, { id: 'r', name: 'RCON', type: 'rcon', source: 'rcon' }],
    update: { validateArgs: { steamcmd: 'validate' } },
    files: { autoClear: [{ path: 'Saved/Crashes', pattern: '*', olderThanDays: 14, intervalMin: 60, default: false }] },
  };
  eq(xErr(goodExt), [], 'new optional fields accepted');
  assert.strictEqual(P.validate(xbase, null).errors.length, 0, 'plugins without the new fields still valid');
  assert(xErr({ cluster: { preserve: ['../saves'] } }).some((x) => /cluster\.preserve/.test(x)), '".." rejected in cluster.preserve');
  assert(xErr({ backup: { presets: [{ id: 'a', name: 'A', paths: ['C:/Windows'] }] } }).length > 0, 'absolute backup path rejected');
  assert(xErr({ files: { autoClear: [{ path: '../x' }] } }).length > 0, '".." rejected in files.autoClear');
  assert(xErr({ cluster: { clearFolders: [{ path: '/etc' }] } }).length > 0, 'absolute clearFolders path rejected');
  assert(xErr({ logging: { patterns: [{ id: 'p', regex: '(' }] } }).some((x) => /regular expression/.test(x)), 'bad logging regex rejected');
  assert(xErr({ logging: { patterns: [{ id: 'p', regex: 'x', level: 'loud' }] } }).length > 0, 'bad log level rejected');
  assert(xErr({ consoles: [{ id: 'c', name: 'C', type: 'telnet' }] }).length > 0, 'bad console type rejected');
  assert(xErr({ consoles: [{ id: 'c', name: 'C', type: 'log', source: 'nope' }] }).length > 0, 'log console needs a declared log');
  assert(xErr({ events: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }).length > 0, 'duplicate event id rejected');
  assert(xErr({ cluster: 'yes' }).length > 0 && xErr({ backup: [] }).length > 0, 'wrong types rejected');
  assert(P.validate({ ...xbase, configs: [{ id: 'c', name: 'C', path: 'a.ini', protect: 'port' }] }, null).errors.length > 0, 'configs[].protect must be an array');
  const xdir = path.join(dir, 'extplug'); fs.mkdirSync(xdir);
  fs.writeFileSync(path.join(xdir, 'plugin.json'), JSON.stringify({ ...xbase, ...goodExt })); fs.writeFileSync(path.join(xdir, 'README.md'), '# x');
  const xg = P.validate({ ...xbase, ...goodExt }, xdir); eq(xg.errors, [], 'valid with a plugin folder');
  const xgame = require('../src/main/plugins').toGame({ ...xbase, ...goodExt }, xdir, 'user');
  eq([xgame.cluster.preserve, xgame.backup.presets[0].id, xgame.events[0].id, xgame.logging.patterns[0].id, xgame.consoles.length, xgame.update.validateArgs.steamcmd, xgame.autoClear[0].path, xgame.configs[0].protect],
    [['Saved/SaveGames'], 'saves', 'join', 'sud', 3, 'validate', 'Saved/Crashes', ['port', 'rcon.*']], 'toGame carries the new fields');
  const plain = require('../src/main/plugins').toGame(xbase, xdir, 'user');
  eq([plain.cluster.clearFolders, plain.backup.presets, plain.events, plain.consoles, plain.autoClear], [[], [], [], [], []], 'toGame defaults are empty');
  const reg = require('../scripts/build-registry').buildRegistry();
  assert(reg.plugins.every((p) => !('cluster' in p) && !('backup' in p) || p.cluster || p.backup), 'registry includes new fields only when present');
  eq(P.validate(JSON.parse(fs.readFileSync(path.join(P.BUNDLED_DIR, '_template', 'plugin.json'), 'utf8')), null).errors, [], 'template (with all example fields) is valid');

  // ---- Phase 0: new settings keys ----
  const sd = S.DEFAULTS;
  assert(sd.ui.leftCollapsed === false && sd.headerStats.cpu && sd.headerStats.ram && sd.headerStats.servers && !sd.headerStats.disk && sd.logging.retentionDays === 30 && sd.discord.allowRawCommands === false, 'new defaults');
  eq(S.sanitize({ ui: { leftCollapsed: 1, bogus: true, navCollapsed: 'x' } }), { ui: { leftCollapsed: true, rightCollapsed: false, bottomCollapsed: false, navCollapsed: true } }, 'ui booleans coerced, unknown dropped');
  eq(S.sanitize({ headerStats: { tick: true, cpu: false, evil: 1 } }).headerStats, { cpu: false, ram: true, disk: false, servers: true, players: false, tick: true }, 'headerStats');
  const dc = S.sanitize({ discord: { webhookUrl: '  https://discord.com/api/webhooks/123/abc-DEF_1  ', botToken: 'T'.repeat(500), applicationId: 123, guildId: {}, allowedUserIds: ['123', 'abc', '123', 456, ' 789 '], adminRoleIds: 'nope', allowRawCommands: 'true', events: { 'server:started': 1, 'bad key!': true } } }).discord;
  assert.strictEqual(dc.webhookUrl, 'https://discord.com/api/webhooks/123/abc-DEF_1', 'trimmed'); assert.strictEqual(dc.botToken.length, 200, 'length capped');
  assert(dc.applicationId === '' && dc.guildId === '', 'non-strings become empty');
  eq(dc.allowedUserIds, ['123', '456', '789'], 'ids: digit strings only, de-duplicated'); eq(dc.adminRoleIds, []);
  assert(dc.allowRawCommands === false, 'allowRawCommands only accepts real true'); eq(dc.events, { 'server:started': true }, 'event keys validated');
  eq(S.sanitize({ logging: { retentionDays: 0 } }).logging, { retentionDays: 30 }, 'bad retention -> default'); eq(S.sanitize({ logging: { retentionDays: '14' } }).logging, { retentionDays: 14 });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
  m.settings = S.read(dir); m.saveSettings({ ui: { leftCollapsed: true } }); m.saveSettings({ discord: { botToken: 'abc' } }); m.saveSettings({ discord: { guildId: '42' } });
  const pst = S.read(dir); assert(pst.ui.leftCollapsed === true && pst.ui.navCollapsed === false && pst.discord.botToken === 'abc' && pst.discord.guildId === '42', 'partial nested patches merge instead of resetting siblings');

  // ---- Phase 0: server events from a fake server ----
  const evs = []; const evNames = ['started', 'stopped', 'crashed', 'restarted', 'updated', 'backup', 'restore', 'command'];
  for (const n of evNames) m.events.on('server:' + n, (p) => evs.push([n, p]));
  const ev = m.importServer('sw', 'EvSrv', fakeDir); m.saveConfig(ev.id, { param: '-e "process.stdin.on(\'data\',d=>{if(/quit/.test(d))process.exit(0)});setInterval(()=>{},1000)"' });
  await m.start(ev.id); await sleep(300);
  assert(evs.some(([n, p]) => n === 'started' && p.id === ev.id && p.name === 'EvSrv' && p.game === 'sw' && typeof p.ts === 'number' && p.detail.pid), 'server:started payload');
  m.sendCommand(ev.id, 'hi'); assert(evs.some(([n, p]) => n === 'command' && p.detail.command === 'hi'), 'server:command');
  await m.stop(ev.id); await sleep(300);
  assert(evs.some(([n]) => n === 'stopped') && !evs.some(([n]) => n === 'crashed'), 'server:stopped on graceful stop, no crash');
  await m.backup(ev.id); await m.restore(ev.id, m.backupList(ev.id)[0].file);
  assert(evs.some(([n]) => n === 'backup') && evs.some(([n]) => n === 'restore'), 'server:backup / server:restore');
  await m.start(ev.id); await sleep(300); await m.kill(ev.id); await sleep(300);
  assert(evs.some(([n]) => n === 'stopped'), 'kill is an intentional stop');
  await m.start(ev.id); await sleep(300); m.runtime.get(ev.id).stopping = false; spawnKill(m.runtime.get(ev.id).proc.pid); await sleep(1500);
  assert(evs.some(([n, p]) => n === 'crashed' && p.id === ev.id), 'server:crashed when the process dies unexpectedly');
  await m.remove(ev.id, true);

  // ---- Phase 0: api table + services skeleton ----
  const { buildApi } = require('../src/main/api');
  const api = buildApi({ mgr: m, collector: { state: () => ({}) }, publicGames: () => [], shell: {}, dialog: {}, app: {}, nativeTheme: {}, getWin: () => null, currentBg: () => '#000', beforeRelaunch() {} });
  for (const k of ['games', 'list', 'get', 'create', 'import', 'install', 'save', 'start', 'stop', 'restart', 'remove', 'console', 'command', 'checkUpdate', 'update', 'backups', 'backup', 'restore', 'deleteBackup', 'firewall', 'listDir', 'readFile', 'writeFile', 'openFolder', 'configList', 'configRead', 'configWrite', 'configCreate', 'logsList', 'logStart', 'logStop', 'pluginDetail', 'openExternal', 'bulk', 'kill', 'settingsDefaults', 'metricsState', 'pluginsInfo', 'pluginsReload', 'pluginsInstallZip', 'pluginsInstallFolder', 'pluginsFolder', 'metrics', 'settings', 'saveSettings', 'relaunch', 'pickFolder']) assert.strictEqual(typeof api[k], 'function', 'api.' + k);
  assert.throws(() => api.openExternal('file:///c:/x'), /http/, 'api.openExternal rejects non-http');
  for (const [f, C] of [['eventLog', 'EventLog'], ['discord', 'Discord'], ['discordBot', 'DiscordBot'], ['backup', 'BackupService'], ['cluster', 'Cluster'], ['autoClear', 'AutoClear']]) {
    const svc = new (require('../src/main/services/' + f)[C])(m, P, m.settings, dir); svc.start(); svc.stop();
  }

  { // Phase 2 block (own scope)
  // ---- Phase 2: settings - discord templates / webhook / per-server override sanitising ----
  eq(S.sanitize({ discord: { webhookUrl: 'https://evil.example/api/webhooks/1/a' } }).discord.webhookUrl, '', 'webhook on a foreign host is dropped');
  eq(S.sanitize({ discord: { webhookUrl: 'http://discord.com/api/webhooks/1/a' } }).discord.webhookUrl, '', 'webhook must be https');
  eq(S.sanitize({ discord: { webhookUrl: 'https://discord.com/other/1/a' } }).discord.webhookUrl, '', 'webhook path must be /api/webhooks/id/token');
  eq(S.sanitize({ discord: { webhookUrl: 'https://u:p@discord.com/api/webhooks/1/a' } }).discord.webhookUrl, '', 'no credentials in the webhook URL');
  assert(S.isDiscordWebhook('https://discordapp.com/api/webhooks/12/tok_en-1') && S.isDiscordWebhook('https://ptb.discord.com/api/webhooks/12/t/'), 'discordapp.com / ptb accepted');
  const tpl = S.sanitize({ discord: { templates: {
    'server:started': { mode: 'weird', title: 'T'.repeat(400), description: 'D'.repeat(3000), content: 5, color: 'red', thumbnail: 'http://x.example/a.png', image: 'https://x.example/i.png', footer: 'F'.repeat(300),
      fields: Array.from({ length: 15 }, (_, i) => ({ name: 'n' + i, value: 'v'.repeat(900), inline: 'yes' })).concat([{ name: '', value: 'x' }, 'bad', null]) },
    'bad key!': { title: 'x' }, 'server:crashed': 'nope' } } }).discord.templates;
  eq(Object.keys(tpl).sort(), ['server:crashed', 'server:started'], 'template keys validated, non-objects become defaults');
  const t0 = tpl['server:started'];
  assert(t0.mode === 'embed' && t0.title.length === 256 && t0.description.length === 2000 && t0.content === '' && t0.color === '' && t0.thumbnail === '' && t0.image === 'https://x.example/i.png' && t0.footer.length === 200, 'template field types + caps + https-only images');
  assert(t0.fields.length === 10 && t0.fields[0].value.length === 500 && t0.fields[0].inline === false, 'max 10 fields, value capped, inline only for real true');
  eq(S.sanitize({ discord: { templates: { 'server:started': { mode: 'simple', color: '#AABBCC' } } } }).discord.templates['server:started'].color, '#aabbcc', 'colour lower-cased');
  eq(S.sanitizeServerDiscord({ discordEvents: { 'server:started': 1, 'x y': true }, discordMessage: 'm'.repeat(900), discordWebhook: '  https://discord.com/api/webhooks/1/abc ' }),
    { discordEvents: { 'server:started': true }, discordMessage: 'm'.repeat(500), discordWebhook: 'https://discord.com/api/webhooks/1/abc' }, 'per-server override sanitised');
  assert.throws(() => S.sanitizeServerDiscord({ discordWebhook: 'https://evil.example/x' }), /Discord webhook/, 'per-server webhook must be a Discord URL');
  eq(S.sanitizeServerDiscord({ name: 'x' }), {}, 'only discord keys are touched');
  m.settings = S.read(dir); m.saveSettings({ discord: { templates: { 'server:started': { title: 'Hello' } } } }); m.saveSettings({ discord: { webhookUrl: 'https://discord.com/api/webhooks/9/z' } });
  const p2 = S.read(dir).discord; assert(p2.templates['server:started'].title === 'Hello' && p2.webhookUrl.endsWith('/9/z'), 'templates + webhook persisted, siblings kept');
  m.saveSettings({ discord: { templates: {}, webhookUrl: '' } });

  // ---- Phase 2: NGSM event log ----
  const { EventEmitter } = require('events');
  const { EventLog } = require('../src/main/services/eventLog');
  const { Discord, render, legacyFlag, DEFAULT_TEMPLATES } = require('../src/main/services/discord');
  let clock = Date.parse('2026-11-24T12:00:00');
  const fm = new EventEmitter(); fm.events = new EventEmitter(); fm.settings = { logging: { retentionDays: 3 } };
  fm.getConfig = (id) => ({ name: 'Fake ' + id, game: 'gx' }); fm.ids = () => ['1'];
  const fp = { byId: () => ({ name: 'Game X', events: [{ id: 'join', label: 'Player joined' }], logging: { patterns: [{ id: 'sudden', regex: 'stopped suddenly', level: 'error' }, { id: 'join', regex: 'joined the game', level: 'info' }, { id: 'broken', regex: '(', level: 'info' }] } }) };
  const ldir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodegsm-log-'));
  const el = new EventLog(fm, fp, fm.settings, ldir, { now: () => clock }); el.start();
  const fe = (type, detail) => fm.events.emit(type, { id: '1', name: 'Fake 1', game: 'gx', ts: clock, detail });
  fe('server:started', { pid: 42 }); fe('server:crashed', { code: 1 }); fe('server:command', { command: 'status', silent: true }); fe('server:command', { command: 'say hi' }); fe('server:config', { config: 'c', path: 'a/b.ini' });
  const day1 = path.join(ldir, 'logs', 'ngsm-2026-11-24.log'); assert(fs.existsSync(day1), 'daily file ngsm-YYYY-MM-DD.log');
  const raw = fs.readFileSync(day1, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  eq(Object.keys(raw[0]).sort(), ['detail', 'event', 'level', 'message', 'serverId', 'serverName', 'ts'], 'entry shape');
  eq(raw.map((r) => r.event), ['server:started', 'server:crashed', 'server:command', 'server:config'], 'silent commands are not logged');
  assert(raw[1].level === 'error' && /stopped suddenly/.test(raw[1].message) && raw[0].serverName === 'Fake 1', 'crash = error entry');
  el.log({ level: 'bogus', event: 'backup:x', serverId: '1', message: 'm'.repeat(5000), detail: { a: 'x'.repeat(9000) } });
  const bx = el.query({ event: 'backup:x' })[0]; assert(bx.level === 'info' && bx.message.length === 1000 && bx.detail.truncated, 'log() validates level, caps message and detail');
  eq(el.query({ level: 'error' }).length, 1, 'level filter'); eq(el.query({ serverId: '1', event: 'command' }).length, 1, 'event substring + server filter'); eq(el.query({ serverId: '2' }).length, 0, 'server filter');
  eq(el.query({ text: 'say hi' }).length, 1, 'text filter'); eq(el.query({ limit: 2 }).length, 2, 'limit'); assert(el.query({})[0].ts >= el.query({})[1].ts, 'newest first');
  // pattern matching + rate limit
  const line = (t) => fm.emit('console', { id: '1', line: t });
  line('[Server] stopped suddenly!'); line('[Server] stopped suddenly again'); line('Bob joined the game'); line('nothing here');
  eq(el.query({ event: 'pattern:sudden' }).length, 1, 'plugin pattern -> log entry, rate limited to 1 per 10 s');
  const pj = el.query({ event: 'game:join' }); eq(pj.length, 1, 'pattern id that is a plugin event becomes game:<id>'); assert(pj[0].serverId === '1' && pj[0].detail.pattern === 'join');
  clock += 11000; line('stopped suddenly'); eq(el.query({ event: 'pattern:sudden' }).length, 2, 'logged again after the cool-down');
  // rotation + retention
  clock = Date.parse('2026-11-20T10:00:00'); el.log({ event: 'old', message: 'old entry' }); clock = Date.parse('2026-11-23T10:00:00'); el.log({ event: 'recent', message: 'recent entry' });
  clock = Date.parse('2026-11-24T12:00:00');
  eq(el.files().length, 3, 'one file per day'); eq(el.prune(), 1, 'prune removes files older than retentionDays');
  assert(!fs.existsSync(path.join(ldir, 'logs', 'ngsm-2026-11-20.log')) && fs.existsSync(path.join(ldir, 'logs', 'ngsm-2026-11-23.log')), 'only the old file was removed');
  const sinceMs = Date.parse('2026-11-24T00:00:00'); assert(el.query({ since: sinceMs }).every((e) => Date.parse(e.ts) >= sinceMs) && el.query({ since: sinceMs }).length > 0, 'since filter');
  fm.settings.logging.retentionDays = 1; eq(el.prune(), 0, 'retention 1 keeps yesterday'); fm.settings.logging.retentionDays = 3;
  const ex = el.export({}); assert(/ERROR server:crashed \[#1 Fake 1\]/.test(ex) && ex.endsWith('\n') && ex.indexOf('server:started') < ex.indexOf('server:crashed'), 'export is readable text, oldest first');
  assert(el.export({ format: 'jsonl' }).trim().split('\n').every((l) => JSON.parse(l).ts), 'export jsonl');
  const nclear = el.clear(); assert(nclear >= 1 && el.query({}).length === 1 && el.query({})[0].event === 'log:cleared', 'clear removes files and records that it did');
  el.stop(); fe('server:started', {}); eq(el.query({ event: 'server:started' }).length, 0, 'stop() unsubscribes');
  // real ServerManager events end up in the log
  const rl = new EventLog(m, P, m.settings, dir); rl.start();
  const ls = m.create('csgo', 'LogSrv'); m.emitEvent('server:backup', ls.id, { file: 'b.zip' }); m.emitEvent('server:restarted', ls.id, { reason: 'cron' });
  assert(rl.query({ serverId: ls.id }).length === 2 && rl.query({ event: 'restarted' })[0].serverName === 'LogSrv', 'ServerManager events are logged with the server name');
  const cgame = P.GAMES.find((g) => g.configs.length); const cs2 = m.create(cgame.id, 'CfgSrv'); m.writeConfig(cs2.id, cgame.configs[0].id, cgame.configs[0].format === 'json' ? '{}' : 'x');
  assert(rl.query({ event: 'server:config', serverId: cs2.id }).length === 1, 'config edits are logged');
  rl.stop();

  // ---- Phase 2: Discord rendering ----
  const vars = { server: 'Alpha', event: 'Server started', game: 'CS2', ip: '1.2.3.4', port: '27015', players: '2/10', id: '7', reason: '', file: '', message: '' };
  const r1 = render({ ...DEFAULT_TEMPLATES['server:started'], title: '{server} is up', description: 'Join {ip}:{port} - {players} - {unknown}' }, vars, 0);
  const e1 = r1.embeds[0];
  assert(e1.title === 'Alpha is up' && e1.description === 'Join 1.2.3.4:27015 - 2/10 - {unknown}' && e1.color === 0x2ecc71 && e1.footer.text === 'NodeGSM - server #7' && e1.timestamp === '1970-01-01T00:00:00.000Z', 'embed placeholders, colour, footer');
  eq(e1.fields.map((f) => f.value), ['CS2', '1.2.3.4:27015', '2/10'], 'field placeholders'); eq(r1.allowed_mentions, { parse: [] }, 'mentions disabled');
  const r2 = render({ mode: 'simple', content: '{event}: {server} @everyone' }, vars); assert(r2.content === 'Server started: Alpha @everyone' && !r2.embeds, 'simple mode'); eq(r2.allowed_mentions.parse, []);
  const r3 = render({ mode: 'embed', title: '', description: '', fields: [], content: 'only text' }, vars); assert(r3.content === 'only text' && !r3.embeds, 'an empty embed falls back to text');
  assert(render({ mode: 'embed', title: '{server}', fields: [{ name: 'a', value: '{server}' }, { name: 'b', value: '{message}' }] }, vars).embeds[0].fields.length === 1, 'fields with an empty rendered value are dropped, others kept');
  assert(render({ mode: 'embed', title: '{server}', fields: [{ name: 'b', value: '{message}' }] }, vars).embeds[0].fields === undefined, 'fields whose value renders empty are dropped');
  assert(render({ mode: 'embed', title: '{server}' }, { ...vars, server: 'x'.repeat(2000) }).embeds[0].title.length === 256, 'title capped at 256');
  assert(!('color' in render({ mode: 'embed', title: 't', color: 'blue' }, vars).embeds[0]), 'bad colour is omitted');
  assert(!('thumbnail' in render({ mode: 'embed', title: 't', thumbnail: 'http://insecure/x.png' }, vars).embeds[0]), 'http thumbnail dropped');
  assert(legacyFlag('server:started') === 'autoStartAlert' && legacyFlag('server:crashed') === 'crashAlert' && legacyFlag('server:restarted', { reason: 'cron' }) === 'restartCrontabAlert' && legacyFlag('server:restarted', { reason: 'crash' }) === 'autoRestartAlert' && legacyFlag('server:updated', { auto: true }) === 'autoUpdateAlert' && legacyFlag('server:backup') === null && legacyFlag('server:restarted', { reason: 'manual' }) === false, 'old flags map to events');

  // ---- Phase 2: Discord sending against a local http server (never a real webhook) ----
  const hits = []; let mode429 = 1; let failWith = 0;
  const dsrv = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => {
      hits.push({ url: q.url, body: JSON.parse(b || '{}') });
      if (failWith) { r.writeHead(failWith); return r.end('{}'); }
      if (mode429 > 0) { mode429--; r.writeHead(429, { 'Content-Type': 'application/json' }); return r.end('{"message":"rate limited","retry_after":0.05,"global":false}'); }
      r.writeHead(204); r.end();
    });
  });
  await new Promise((r) => dsrv.listen(0, '127.0.0.1', r));
  const hook = (n) => `http://127.0.0.1:${dsrv.address().port}/api/webhooks/${n}/tok`;
  const ds = new Discord(m, P, m.settings, dir, { allowAnyUrl: true, delayMs: 5 }); ds.start();
  m.settings.discord = { ...S.DEFAULTS.discord, webhookUrl: hook(1) };
  const tr = await ds.test('server:started', { mode: 'embed', title: 'Unsaved {server}', description: 'x', color: '#112233' });
  eq(tr, { ok: true, status: 204 }, 'test send: 429 is retried after retry_after, then succeeds'); eq(hits.length, 2, '429 -> one retry');
  assert(hits[1].body.embeds[0].title === 'Unsaved My Server' && hits[1].body.embeds[0].color === 0x112233 && hits[1].url === '/api/webhooks/1/tok', 'test uses the unsaved template with sample values');
  hits.length = 0; const plain = await ds.test('plain'); assert(plain.ok && /NodeGSM test/.test(hits[0].body.content), 'plain test message');
  const pv = ds.preview({ mode: 'embed', title: 'P {server}', color: '#ff0000' }, { server: 'Zed' }); assert(pv.embeds[0].title === 'P Zed' && pv.embeds[0].color === 0xff0000, 'preview renders with sample vars');
  failWith = 500; const bad = await new Discord(m, P, m.settings, dir, { allowAnyUrl: true, delayMs: 1, maxRetries: 0 }).test('plain'); assert(!bad.ok && bad.status === 500, 'HTTP errors are reported, not thrown'); failWith = 0;
  const savedHook = m.settings.discord.webhookUrl; m.settings.discord.webhookUrl = 'http://127.0.0.1:1/api/webhooks/1/x';
  const dr = await new Discord(m, P, m.settings, dir, { allowAnyUrl: true, maxRetries: 0 }).test('plain'); assert(dr.ok === false && dr.status === 0 && dr.error, 'unreachable host -> { ok:false } without throwing');
  m.settings.discord.webhookUrl = savedHook;
  m.settings.discord.webhookUrl = 'http://127.0.0.1:1/api/webhooks/1/x'; const sr = await new Discord(m, P, m.settings, dir).test('plain'); assert(!sr.ok && /Not a Discord webhook/.test(sr.error), 'production sender refuses non-Discord URLs (even http://127.0.0.1)');
  m.settings.discord.webhookUrl = ''; eq((await ds.test('plain')).status, 0, 'no webhook -> { ok:false, status:0 }'); m.settings.discord.webhookUrl = savedHook;
  hits.length = 0; const qs = await Promise.all([1, 2, 3].map((i) => ds.enqueue(hook(1), { content: 'm' + i }))); assert(qs.every((x) => x.ok) && hits.map((x) => x.body.content).join() === 'm1,m2,m3', 'queue delivers in order');

  // toggle logic + bus integration
  const sv = m.create('csgo', 'AlertSrv'); const sid = sv.id;
  const rawSave = (id, patch) => fs.writeFileSync(m.cfgFile(id), JSON.stringify({ ...JSON.parse(fs.readFileSync(m.cfgFile(id), 'utf8')), ...patch })); // bypasses the Discord-URL check so a local http hook can be used
  assert.throws(() => m.saveConfig(sid, { discordWebhook: 'https://evil.example/hook' }), /Discord webhook/, 'saveConfig rejects a non-Discord webhook'); eq(m.getConfig(sid).discordWebhook, '', 'rejected webhook not stored');
  const tg = (k, d = {}) => ds.targets(k, sid, d);
  m.settings.discord = { ...S.DEFAULTS.discord, webhookUrl: hook(1) };
  eq(tg('server:started'), [hook(1)], 'default-on event goes to the global webhook'); eq(tg('server:stopped'), [], 'default-off event is silent');
  m.settings.discord.events = { 'server:started': false, 'server:stopped': true }; eq(tg('server:started'), [], 'global toggle off'); eq(tg('server:stopped'), [hook(1)], 'global toggle on');
  m.saveConfig(sid, { discordEvents: { 'server:started': true, 'server:stopped': false } }); eq(tg('server:started'), [hook(1)], 'per-server override on beats global off'); eq(tg('server:stopped'), [], 'per-server override off beats global on');
  rawSave(sid, { discordEvents: {}, discordAlert: true, discordWebhook: hook(2), crashAlert: false, autoStartAlert: true });
  eq(tg('server:started'), [hook(2)], 'old autoStartAlert still drives the per-server webhook while the global toggle is off'); m.settings.discord.events = {};
  eq(tg('server:started').sort(), [hook(1), hook(2)].sort(), 'global + per-server webhook both receive');
  eq(tg('server:crashed'), [hook(1)], 'old crashAlert=false silences the per-server webhook only');
  eq(tg('server:restarted', { reason: 'manual' }), [hook(1)], 'manual restarts never went to the per-server webhook');
  eq(tg('server:restarted', { reason: 'cron' }).sort(), [hook(1), hook(2)].sort(), 'cron restarts follow restartCrontabAlert (default true)');
  rawSave(sid, { discordWebhook: hook(1) }); eq(tg('server:started'), [hook(1)], 'same URL is not sent twice');
  m.saveConfig(sid, { discordAlert: false });
  hits.length = 0; m.emitEvent('server:crashed', sid, { code: 3 }); await sleep(300);
  assert(hits.length === 1 && hits[0].body.embeds[0].title === 'Server crashed' && hits[0].body.embeds[0].color === 0xe74c3c && /AlertSrv/.test(hits[0].body.embeds[0].description) && /Exit code 3/.test(hits[0].body.embeds[0].description), 'server:crashed on the bus -> red embed with exit code');
  hits.length = 0; m.emitEvent('server:stopped', sid, { code: 0 }); m.emitEvent('server:command', sid, { command: 'x' }); await sleep(100); eq(hits.length, 0, 'disabled / non-alert events send nothing');
  hits.length = 0; m.settings.discord.templates = { 'server:started': { mode: 'simple', content: 'UP {server} on {port}' } }; m.emitEvent('server:started', sid, { pid: 1 }); await sleep(300);
  assert(hits.length === 1 && hits[0].body.content === 'UP AlertSrv on ' + m.getConfig(sid).port && !hits[0].body.embeds, 'saved simple-mode template is used'); m.settings.discord.templates = {};
  // plugin events through the event log
  const fakePlugins = { byId: (g) => (g === 'csgo' ? { name: 'CS', events: [{ id: 'join', label: 'Player joined', default: true }], logging: { patterns: [{ id: 'join', regex: 'has joined', level: 'info' }] } } : P.byId(g)), GAMES: P.GAMES };
  const ds2 = new Discord(m, fakePlugins, m.settings, dir, { allowAnyUrl: true, delayMs: 1 }); ds2.start(); ds.stop();
  const el2 = new EventLog(m, fakePlugins, m.settings, dir); el2.start();
  assert(ds2.catalog().some((e) => e.key === 'game:join' && e.on === true), 'plugin events[] appear in the catalog');
  hits.length = 0; m.log(sid, 'Bob has joined'); await sleep(300);
  assert(hits.length === 1 && hits[0].body.embeds[0].title === 'Player joined' && /has joined/.test(hits[0].body.embeds[0].description), 'console pattern -> game:<id> event log entry -> Discord embed');
  el2.stop(); ds2.stop();
  assert(ds.info().events.length >= 7 && Object.keys(ds.info().defaults).length >= 7, 'info() lists events with default templates');
  dsrv.close();

  // ---- Phase 2: IPC ----
  const api2 = buildApi({ mgr: m, collector: { state: () => ({}) }, publicGames: () => [], shell: {}, dialog: {}, app: {}, nativeTheme: {}, getWin: () => null, currentBg: () => '#000', beforeRelaunch() {}, eventLog: rl, discord: ds });
  for (const k of ['eventLogQuery', 'eventLogExport', 'eventLogClear', 'discordTest', 'discordPreview', 'discordInfo']) assert.strictEqual(typeof api2[k], 'function', 'api.' + k);
  assert(Array.isArray(api2.eventLogQuery({})) && typeof api2.eventLogExport({}) === 'string', 'eventLogQuery / eventLogExport');
  assert(api2.discordPreview({ mode: 'embed', title: 'x' }, {}).embeds[0].title === 'x', 'discordPreview');
  assert.throws(() => api.eventLogQuery({}), /Service not available/, 'api without services throws a clear error');
  api2.eventLogClear(); assert(rl.query({}).length === 1, 'eventLogClear');
  fs.rmSync(ldir, { recursive: true, force: true });
  }

  // ---- Phase 1: app shell (settings round trip, footer links, static HTML checks) ----
  m.saveSettings({ ui: { rightCollapsed: true, bottomCollapsed: true } }); m.saveSettings({ headerStats: { disk: true, tick: true } });
  const sh = S.read(dir);
  eq(sh.ui, { leftCollapsed: true, rightCollapsed: true, bottomCollapsed: true, navCollapsed: false }, 'ui collapse state round-trips through settings.json');
  eq(sh.headerStats, { cpu: true, ram: true, disk: true, servers: true, players: false, tick: true }, 'headerStats round-trips');
  const LINKS = require('../src/renderer/links.js');
  for (const k of ['website', 'discord', 'patreon', 'paypal', 'buymeacoffee']) assert(typeof LINKS[k] === 'string' && /^https?:\/\/[^\s]+$/.test(LINKS[k]), 'links.js ' + k + ' is an http(s) URL');
  const RD = path.join(__dirname, '..', 'src', 'renderer'); const html = fs.readFileSync(path.join(RD, 'index.html'), 'utf8');
  assert(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html) && !/\son\w+\s*=/i.test(html), 'index.html has no inline scripts / handlers (CSP)');
  for (const f of [...html.matchAll(/<script src="([^"]+)"/g)].map((x) => x[1])) assert(fs.existsSync(path.join(RD, f)), 'script exists: ' + f);
  for (const v of ['servers', 'table', 'dashboard', 'plugins', 'settings', 'discord', 'logs']) assert(html.includes('data-view="' + v + '"'), 'nav entry for view ' + v);
  for (const id of ['leftPanel', 'rightPanel', 'bottomPanel', 'metrics', 'setStats', 'tgLeft', 'tgRight', 'tgBottom', 'tgNav', 'vPlugins', 'vSettings', 'vDiscord', 'vLogs', 'dcWebhook', 'dcTest', 'dcEvents', 'dcEditor', 'dcPreview', 'lgTable']) assert(html.includes('id="' + id + '"'), 'element #' + id);
  for (const k of ['website', 'discord', 'patreon', 'paypal', 'buymeacoffee']) assert(html.includes('data-link="' + k + '"'), 'footer link ' + k);
  const boot = fs.readFileSync(path.join(RD, 'theme-boot.js'), 'utf8');
  assert(/nodegsm\.ui/.test(boot) && /leftCollapsed/.test(boot), 'theme-boot applies the panel layout before first paint');

  console.log('smoke test passed');
  m.logTail.shutdown(); fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
