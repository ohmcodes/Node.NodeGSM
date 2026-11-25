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

  { // Phase 3 block (own scope): backups
  // ---- Phase 3: helpers (paths, exclude patterns, crc, zip writer/reader) ----
  const { BackupService, safeRel, inside, compileExclude } = require('../src/main/services/backup');
  const zipmod = require('../src/main/services/zip');
  const { EventLog: ELog } = require('../src/main/services/eventLog');
  for (const bad of ['../x', 'a/../../x', '/abs', 'C:/x', 'C:\\x', '..\\x', '', '   ', 'a\0b', 'a/b:stream', '.', './']) assert.throws(() => safeRel(bad), /Invalid path/, 'safeRel rejects ' + JSON.stringify(bad));
  eq([safeRel('a\\b/./c//d'), safeRel('./saves/'), safeRel('x')], ['a/b/c/d', 'saves', 'x'], 'safeRel normalises');
  const root = path.resolve(dir, 'conf'); assert.throws(() => inside(root, '../conf2/x'), /escapes/, 'inside() blocks a sibling that shares the prefix'); assert(inside(root, 'a/b').startsWith(root + path.sep), 'inside() accepts children');
  const ex = compileExclude(['*.tmp', 'cache', 'Saved/Logs', '**/x.log', '']);
  assert(ex('a/b/c.tmp', 'c.tmp') && ex('cache', 'cache') && ex('deep/cache', 'cache') && ex('Saved/Logs', 'Logs') && ex('SAVED/logs', 'logs') && ex('a/b/x.log', 'x.log'), 'exclude patterns match');
  assert(!ex('Other/Saved/Logs', 'Logs') && !ex('a/c.tmpx', 'c.tmpx') && !ex('cachex', 'cachex'), 'anchored patterns only match from the root; names match exactly');
  assert.strictEqual(zipmod.crc32(Buffer.from('123456789')), 0xCBF43926, 'crc32 check value');
  { const zl = require('zlib'); const orig = zl.crc32; zl.crc32 = undefined; try { assert.strictEqual(zipmod.crc32(Buffer.from('123456789')), 0xCBF43926, 'table crc32 fallback'); assert.strictEqual(zipmod.crc32(Buffer.from('6789'), zipmod.crc32(Buffer.from('12345'))), 0xCBF43926, 'crc32 continues'); } finally { zl.crc32 = orig; } }

  // zip64 forced on tiny files: our reader reads it back; a flipped byte is detected
  const zsrc = path.join(dir, 'z64src'); fs.mkdirSync(zsrc); const rnd = require('crypto').randomBytes(200 * 1024);
  fs.writeFileSync(path.join(zsrc, 'rnd.bin'), rnd); fs.writeFileSync(path.join(zsrc, 'empty.txt'), ''); fs.writeFileSync(path.join(zsrc, 'uni\u00e9.txt'), 'utf8 name');
  for (const opts of [{ forceZip64: true }, {}]) {
    const zf = path.join(dir, 'z64.zip'); const zw = new zipmod.ZipWriter(zf, opts);
    for (const n of ['rnd.bin', 'empty.txt', 'uni\u00e9.txt']) await zw.addFile(n, path.join(zsrc, n), fs.statSync(path.join(zsrc, n)));
    await zw.addDir('d/e', Date.now()); await zw.addBuffer('b.txt', Buffer.from('buffer'), Date.now()); await zw.finish();
    const zr = await zipmod.openZip(zf); eq(zr.entries.map((e) => e.name), ['rnd.bin', 'empty.txt', 'uni\u00e9.txt', 'd/e/', 'b.txt'], 'entries listed ' + JSON.stringify(opts));
    const out = path.join(dir, 'z64out'); fs.mkdirSync(out, { recursive: true });
    for (const e of zr.entries.filter((x) => !x.dir)) await zipmod.extractEntry(zr, e, path.join(out, e.name));
    assert(fs.readFileSync(path.join(out, 'rnd.bin')).equals(rnd) && fs.readFileSync(path.join(out, 'uni\u00e9.txt'), 'utf8') === 'utf8 name' && fs.readFileSync(path.join(out, 'empty.txt')).length === 0, 'zip roundtrip ' + JSON.stringify(opts));
    if (!opts.forceZip64) { const az = new AdmZip(zf); assert(az.getEntry('rnd.bin').getData().equals(rnd) && az.getEntries().length === 5, 'AdmZip reads our zip (standard layout)'); }
    await zr.close(); fs.rmSync(out, { recursive: true, force: true });
  }
  { const zf = path.join(dir, 'z64.zip'); const zb = fs.readFileSync(zf); zb[200] ^= 0xff; fs.writeFileSync(zf, zb);
    const zr = await zipmod.openZip(zf); await assert.rejects(zipmod.extractEntry(zr, zr.entries[0], path.join(dir, 'corrupt.out')), /./, 'corrupt data is detected');
    assert(!fs.existsSync(path.join(dir, 'corrupt.out')) && !fs.existsSync(path.join(dir, 'corrupt.out.nodegsm-part')), 'no partial file left'); await zr.close(); }

  // ---- Phase 3: a fake plugin game that installs locally (no network) ----
  const fgDir = path.join(dir, 'bkfake-plugin'); fs.mkdirSync(fgDir);
  const fgame = P.toGame({ id: 'bkfake', name: 'Backup Fake', install: { steps: [{ type: 'write', path: 'game.exe', content: 'EXE' }, { type: 'write', path: 'data/base.txt', content: 'base' }] }, run: { exe: 'game.exe', args: [] },
    defaults: { port: '30000', queryPort: '30001', map: 'm', maxPlayers: '4' }, backup: { presets: [{ id: 'saves', name: 'Saves', paths: ['saves'] }, { id: 'cfg', name: 'Cfg', paths: ['cfg/server.ini'] }], exclude: ['*.tmp', 'cache'] } }, fgDir, 'user');
  P.GAMES.push(fgame);
  const bk = new BackupService(m, P, m.settings, dir); assert(m.bk() === bk, 'mgr.bk() returns the registered service');
  const belog = new ELog(m, P, m.settings, dir); belog.start();
  const bevs = []; for (const n of ['backup', 'restore']) m.events.on('server:' + n, (p) => bevs.push([n, p]));
  const put = (id, rel, data) => { const f = path.join(m.filesDir(id), rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
  const rd = (id, rel) => fs.readFileSync(path.join(m.filesDir(id), rel), 'utf8');
  const big = require('crypto').randomBytes(3 * 1024 * 1024);
  const b1 = m.create('bkfake', 'BK One').id; await m.install(b1);
  m.saveConfig(b1, { param: '-custom "a b"', backupKeep: 0 });
  const W1 = 'W1'.repeat(40000);
  put(b1, 'saves/world1.dat', W1); put(b1, 'saves/sub/a.txt', 'A'); put(b1, 'cfg/server.ini', 'ini'); put(b1, 'cfg/other.ini', 'other'); put(b1, 'cache/x.bin', 'cache'); put(b1, 'logs/a.tmp', 'tmp'); put(b1, 'data/big.bin', big); fs.mkdirSync(path.join(m.filesDir(b1), 'emptydir'), { recursive: true });
  const zipPath = (id, f) => path.join(m.backupsDir, id, f);
  const names = (id, f) => new AdmZip(zipPath(id, f)).getEntries().map((e) => e.entryName).sort();
  const files = (id, f) => names(id, f).filter((x) => !x.endsWith('/'));
  const manifestOf = (id, f) => JSON.parse(fs.readFileSync(zipPath(id, f).replace(/\.zip$/, '.json'), 'utf8'));
  const noPartial = (id) => !fs.readdirSync(path.join(m.backupsDir, id)).some((f) => f.endsWith('.partial'));

  // full backup: manifest, contents, exclusions, event
  const fullF = await m.backup(b1); assert(/^backup-.*\.zip$/.test(fullF), 'backup() resolves to the file name');
  const fm = manifestOf(b1, fullF);
  eq([fm.version, fm.mode, fm.game, fm.serverName, fm.serverId, fm.includesServerSettings, fm.paths, fm.gameVersion], [1, 'full', 'bkfake', 'BK One', b1, true, [], null], 'full manifest');
  assert(fm.sizeBytes === fs.statSync(zipPath(b1, fullF)).size && fm.fileCount === 7 && fm.uncompressedBytes > big.length && !isNaN(Date.parse(fm.createdAt)) && fm.exclude.includes('*.tmp') && fm.exclude.includes('cache'), 'manifest sizes, counts, effective exclude list');
  eq(files(b1, fullF), ['__nodegsm/wgsm.json', 'cfg/other.ini', 'cfg/server.ini', 'data/base.txt', 'data/big.bin', 'game.exe', 'saves/sub/a.txt', 'saves/world1.dat'], 'full zip contents (plugin excludes applied)');
  assert(names(b1, fullF).includes('emptydir/'), 'empty directories are kept');
  assert(new AdmZip(zipPath(b1, fullF)).getEntry('data/big.bin').getData().equals(big), 'streamed zip is readable by AdmZip, data intact');
  assert(bevs.some(([n, p]) => n === 'backup' && p.id === b1 && p.detail.file === fullF && p.detail.mode === 'full' && p.detail.fileCount === 7), 'server:backup event with mode and file count');
  assert(belog.query({ event: 'server:backup', serverId: b1 })[0].message.includes(fullF), 'event log has the backup entry'); assert(noPartial(b1), 'no partial file after success');

  // full restore roundtrip
  put(b1, 'saves/world1.dat', 'CHANGED'); fs.rmSync(path.join(m.filesDir(b1), 'data/base.txt'));
  bevs.length = 0; await m.restore(b1, fullF);
  assert(rd(b1, 'saves/world1.dat') === W1 && rd(b1, 'data/base.txt') === 'base' && fs.readFileSync(path.join(m.filesDir(b1), 'data/big.bin')).equals(big), 'full restore brings files back');
  assert(rd(b1, 'cache/x.bin') === 'cache' && !fs.existsSync(path.join(m.filesDir(b1), '__nodegsm')), 'files outside the backup stay; the metadata folder is never extracted');
  assert(bevs.some(([n, p]) => n === 'restore' && p.detail.file === fullF && p.detail.mode === 'full'), 'server:restore event');
  assert(belog.query({ event: 'server:restore', serverId: b1 }).length === 1, 'event log has the restore entry'); assert(m.view(b1).pending === null, 'busy flag cleared after restore');

  // neat pick: presets + custom paths + exclude + settings flag
  put(b1, 'data/base.txt', 'base-modified');
  const npF = await m.backup(b1, { mode: 'neatpick', presets: ['saves', 'cfg'], paths: ['data/base.txt', 'data\\base.txt'], exclude: ['*.dat'] });
  const nm = manifestOf(b1, npF);
  eq(files(b1, npF), ['cfg/server.ini', 'data/base.txt', 'saves/sub/a.txt'], 'neat pick contents (preset dir, preset file, custom file; user exclude applied; no wgsm.json by default)');
  eq([nm.mode, nm.paths, nm.presets, nm.includesServerSettings, nm.exclude.includes('*.dat')], ['neatpick', ['saves', 'cfg/server.ini', 'data/base.txt'], ['saves', 'cfg'], false, true], 'neat pick manifest');
  const npS = await m.backup(b1, { mode: 'neatpick', presets: ['cfg'], includeServerSettings: true });
  assert(names(b1, npS).includes('__nodegsm/wgsm.json') && manifestOf(b1, npS).includesServerSettings === true, 'includeServerSettings adds the server settings');
  const stOnly = await m.backup(b1, { mode: 'neatpick', paths: ['does-not-exist'], includeServerSettings: true });
  eq([manifestOf(b1, stOnly).fileCount, manifestOf(b1, stOnly).missing], [0, ['does-not-exist']], 'a backup of only the settings is allowed; missing paths are reported');
  const pv = await bk.preview(b1, { mode: 'neatpick', presets: ['saves'] }); eq([pv.fileCount, pv.totalBytes], [2, W1.length + 1], 'preview: file count and bytes');
  assert((await bk.preview(b1, { mode: 'full' })).fileCount === 7 && (await bk.preview(b1, {})).mode === 'full', 'preview full / default mode');
  eq(bk.info(b1).presets.map((p) => p.id), ['saves', 'cfg'], 'info() exposes the plugin presets'); eq(bk.info(b1).exclude, ['*.tmp', 'cache']);

  // validation + path confinement on backup
  for (const bad of ['../x', 'a/../../x', '/etc', 'C:\\Windows', '..\\..\\x']) await assert.rejects(m.backup(b1, { mode: 'neatpick', paths: [bad] }), /Invalid path/, 'neat pick rejects ' + bad);
  await assert.rejects(m.backup(b1, { mode: 'neatpick', presets: ['nope'] }), /Unknown backup preset/); await assert.rejects(m.backup(b1, { mode: 'weird' }), /Unknown backup mode/);
  await assert.rejects(m.backup(b1, { mode: 'neatpick' }), /at least one/, 'empty neat pick refused'); await assert.rejects(m.backup(b1, { mode: 'neatpick', paths: ['nothing-here'] }), /Nothing to back up/, 'nothing matched');
  assert(noPartial(b1), 'failed backups leave no partial file');
  const outside = path.join(dir, 'outside-secret'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
  let linked = false; try { fs.symlinkSync(outside, path.join(m.filesDir(b1), 'saves', 'link'), 'junction'); linked = true; } catch { /* no permission to create links here */ }
  if (linked) {
    const lf = await m.backup(b1); assert(!names(b1, lf).some((x) => /secret|link/.test(x)) && manifestOf(b1, lf).skipped >= 1, 'symlinks / junctions are never followed (skipped and counted)');
    await assert.rejects(m.backup(b1, { mode: 'neatpick', paths: ['saves/link/secret.txt'] }), /Nothing to back up/, 'a path that goes through a link is not read');
    fs.rmSync(path.join(m.filesDir(b1), 'saves', 'link'), { recursive: true, force: true }); assert(fs.existsSync(path.join(outside, 'secret.txt')), 'removing the link did not touch the target');
  }

  // zip-slip: every malicious name is rejected before anything is written
  const evilZip = async (id, name, entryName) => { const f = zipPath(id, name); const zw = new zipmod.ZipWriter(f); await zw.addBuffer('ok.txt', Buffer.from('ok'), Date.now()); await zw.addBuffer(entryName, Buffer.from('EVIL'), Date.now()); await zw.finish(); };
  const evilNames = ['../evil.txt', 'a/../../evil.txt', '/abs-evil.txt', 'C:/evil.txt', '..\\evil.txt', 'sub/..\\..\\evil.txt'];
  for (const [i, en] of evilNames.entries()) { await evilZip(b1, `backup-evil${i}.zip`, en); await assert.rejects(m.restore(b1, `backup-evil${i}.zip`), /Invalid path/, 'zip-slip rejected: ' + en); }
  assert(!fs.existsSync(path.join(m.filesDir(b1), '..', 'evil.txt')) && !fs.existsSync(path.join(m.filesDir(b1), 'ok.txt')) && !fs.existsSync(path.join(path.parse(dir).root, 'evil.txt')), 'a rejected backup extracts nothing, not even the harmless entries');
  const idsBefore = m.ids().length;
  await assert.rejects(bk.restoreAsNew({ folder: b1, file: 'backup-evil0.zip' }, { game: 'bkfake' }), /Invalid path/, 'restore-as-new checks entries too'); eq(m.ids().length, idsBefore, 'and creates no server');
  for (const f of fs.readdirSync(path.join(m.backupsDir, b1)).filter((x) => x.startsWith('backup-evil'))) fs.rmSync(zipPath(b1, f));
  assert.strictEqual(bk.filePath('1', '../../x.zip'), path.join(m.backupsDir, '1', 'x.zip'), 'file names are confined to the backup folder (basename)'); assert.throws(() => bk.filePath('../x', 'a.zip'), /Invalid backup folder/); assert.throws(() => bk.filePath('1', 'a.txt'), /Invalid backup file/);
  await assert.rejects(m.restore(b1, 'backup-missing.zip'), /Backup not found/);

  // legacy backup without a sidecar manifest (made by AdmZip like the old code did)
  const lz = new AdmZip(); lz.addFile('legacy/old.txt', Buffer.from('OLD')); lz.addFile('saves/world1.dat', Buffer.from('LEGACY')); lz.writeZip(zipPath(b1, 'backup-legacy.zip'));
  const legacy = m.backupList(b1).find((x) => x.file === 'backup-legacy.zip'); assert(legacy && legacy.legacy === true && legacy.mode === 'full' && legacy.manifest === null && legacy.size > 0 && legacy.time > 0, 'legacy backup listed as mode full');
  await m.restore(b1, 'backup-legacy.zip'); assert(rd(b1, 'legacy/old.txt') === 'OLD' && rd(b1, 'saves/world1.dat') === 'LEGACY', 'legacy backup restores (AdmZip-made zip read by the streaming reader)');
  await assert.rejects(bk.restoreAsNew({ folder: b1, file: 'backup-legacy.zip' }), /without a manifest/, 'restore-as-new needs a game for a legacy backup');
  const lg = await bk.restoreAsNew({ folder: b1, file: 'backup-legacy.zip' }, { game: 'bkfake', name: 'From legacy' });
  assert(rd(lg.id, 'legacy/old.txt') === 'OLD' && m.getConfig(lg.id).name === 'From legacy' && lg.settingsRestored === false, 'legacy restore-as-new with an explicit game'); await m.remove(lg.id, true);
  put(b1, 'saves/world1.dat', W1); fs.rmSync(path.join(m.filesDir(b1), 'legacy'), { recursive: true, force: true });

  // retention
  for (const f of m.backupList(b1)) m.deleteBackup(b1, f.file);
  eq(m.backupList(b1), [], 'deleteBackup removes everything'); assert(!fs.readdirSync(path.join(m.backupsDir, b1)).some((f) => f.endsWith('.json')), 'deleteBackup also removes the sidecar manifest');
  eq([1, '3', 0, -5, 'x', 5000, 2.9].map((v) => m.saveConfig(b1, { backupKeep: v }).backupKeep), [1, 3, 0, 0, 0, 0, 2], 'backupKeep is sanitised (0 .. 1000)');
  m.saveConfig(b1, { backupKeep: 2 });
  const made = []; for (let i = 0; i < 4; i++) { made.push(await m.backup(b1, { mode: 'neatpick', presets: ['cfg'] })); await sleep(5); }
  eq(m.backupList(b1).map((x) => x.file), [made[3], made[2]], 'retention keeps the newest N');
  assert(fs.readdirSync(path.join(m.backupsDir, b1)).filter((f) => f.endsWith('.json')).length === 2 && belog.query({ event: 'backup:pruned' }).length === 2, 'old sidecars removed, prune is logged');
  m.saveConfig(b1, { backupKeep: 0 }); await m.backup(b1, { mode: 'neatpick', presets: ['cfg'] }); await m.backup(b1, { mode: 'neatpick', presets: ['cfg'] }); assert(m.backupList(b1).length === 4, '0 = unlimited');
  for (const f of m.backupList(b1)) m.deleteBackup(b1, f.file);

  // bulk backup keeps working (full by default)
  eq((await m.bulk('backup', [b1])).map((r) => r.ok), [true], 'bulk backup'); const bb = m.backupList(b1); assert(bb.length === 1 && bb[0].mode === 'full' && bb[0].manifest.includesServerSettings, 'bulk backup is a full backup');
  const full2 = bb[0].file;

  // restore as new (full): new id, settings applied, port conflict resolved, event
  const origPort = m.getConfig(b1).port; m.saveConfig(b1, { param: '-after-backup' });
  bevs.length = 0; const rn = await bk.restoreAsNew({ folder: b1, file: full2 }, { name: 'Clone' });
  assert(rn.id !== b1 && rn.name === 'Clone' && rn.mode === 'full' && rn.settingsRestored === true && rn.portAdjusted === true, 'restore-as-new result: ' + JSON.stringify(rn));
  const cc = m.getConfig(rn.id); assert(cc.game === 'bkfake' && cc.name === 'Clone' && cc.param === '-custom "a b"' && cc.port !== origPort && cc.installDir === '', 'clone: settings from the backup (param), name from the request, port moved to a free one: ' + cc.port);
  assert(new Set([m.getConfig(b1).port, m.getConfig(b1).queryPort, cc.port, cc.queryPort]).size === 4, 'no port is used twice');
  assert(rd(rn.id, 'saves/world1.dat') === W1 && fs.readFileSync(path.join(m.filesDir(rn.id), 'data/big.bin')).equals(big) && rd(rn.id, 'game.exe') === 'EXE', 'clone has the files');
  assert(bevs.some(([n, p]) => n === 'restore' && p.id === rn.id && p.detail.asNew === true && p.detail.from === b1), 'server:restore event for the new server'); assert(m.view(rn.id).status === 'Stopped', 'new server is stopped');
  assert(/as a new server/.test(belog.query({ event: 'server:restore', serverId: rn.id })[0].message), 'logged');
  const rn2 = await bk.restoreAsNew(full2, { restoreSettings: false }); eq([rn2.settingsRestored, m.getConfig(rn2.id).name, m.getConfig(rn2.id).param], [false, 'BK One (restored)', m.getConfig(rn2.id).param], 'bare file name is found in any folder; default name');
  assert(m.getConfig(rn2.id).param !== '-custom "a b"', 'settings skipped on request'); await m.remove(rn2.id, true);

  // neat pick: refused on a server that is not installed, applied once installed; wrong game refused
  const npKeep = await m.backup(b1, { mode: 'neatpick', presets: ['saves'], paths: ['data/base.txt'] });
  const un = m.create('bkfake', 'Not installed').id; fs.mkdirSync(path.join(m.backupsDir, un), { recursive: true });
  for (const ext of ['.zip', '.json']) fs.copyFileSync(zipPath(b1, npKeep.replace('.zip', ext)), zipPath(un, npKeep.replace('.zip', ext)));
  await assert.rejects(m.restore(un, npKeep), /install the game first/i, 'neat pick restore needs an installed server');
  assert(!fs.existsSync(path.join(m.filesDir(un), 'saves')) && m.view(un).pending === null, 'nothing was written, server not left busy');
  await m.install(un); const rr = await m.restore(un, npKeep); eq([rr.mode, rd(un, 'saves/sub/a.txt'), rd(un, 'data/base.txt')], ['neatpick', 'A', 'base-modified'], 'neat pick restore after install');
  fs.copyFileSync(zipPath(b1, npKeep), path.join(m.backupsDir, un, 'backup-other.zip')); fs.writeFileSync(path.join(m.backupsDir, un, 'backup-other.json'), JSON.stringify({ ...manifestOf(b1, npKeep), game: 'csgo' }));
  await assert.rejects(m.restore(un, 'backup-other.zip'), /belongs to a "csgo" server/, 'a backup of another game is refused'); await m.remove(un, true);

  // restore as new (neat pick): create + install + apply
  const rnp = await bk.restoreAsNew({ folder: b1, file: npKeep }, { name: 'NP clone' });
  eq([rnp.mode, rnp.settingsRestored, m.getConfig(rnp.id).name, rd(rnp.id, 'game.exe'), rd(rnp.id, 'saves/sub/a.txt'), rd(rnp.id, 'data/base.txt')], ['neatpick', false, 'NP clone', 'EXE', 'A', 'base-modified'], 'neat pick restore-as-new: game installed, then backup applied over it');

  // plugin missing / broken install: clear error, no server left behind
  fs.copyFileSync(zipPath(b1, npKeep), zipPath(b1, 'backup-noplugin.zip')); fs.writeFileSync(zipPath(b1, 'backup-noplugin.json'), JSON.stringify({ ...manifestOf(b1, npKeep), game: 'no-such-game' }));
  const nIds = m.ids().length; await assert.rejects(bk.restoreAsNew({ folder: b1, file: 'backup-noplugin.zip' }), /plugin for "no-such-game" is not installed/, 'missing plugin -> clear error'); eq(m.ids().length, nIds, 'no server created');
  fgame.steps = [{ type: 'write', path: 'nothing.txt', content: 'x' }];
  await assert.rejects(bk.restoreAsNew({ folder: b1, file: npKeep }), /Install incomplete/, 'a failing install is reported'); eq(m.ids().length, nIds, 'and the half-created server is removed');
  fgame.steps = [{ type: 'write', path: 'game.exe', content: 'EXE' }, { type: 'write', path: 'data/base.txt', content: 'base' }];

  // all-backups listing (+ deleted servers) and the IPC table
  await m.backup(rnp.id); const rnpId = rnp.id;
  const all = bk.listAll(); assert(all.length >= 3 && all.every((r) => r.folder && r.file && typeof r.size === 'number' && r.mode && 'deleted' in r), 'listAll rows');
  const mine = all.filter((r) => r.serverId === b1 && r.game === 'bkfake'); assert(mine.length >= 2 && mine.every((r) => r.serverName === 'BK One' && r.gameName === 'Backup Fake' && r.deleted === false && r.pluginMissing === false), 'rows carry the server and game name');
  assert(all.find((r) => r.file === 'backup-noplugin.zip').pluginMissing === true, 'rows flag a missing plugin');
  assert(all.every((r, i) => !i || all[i - 1].time >= r.time), 'newest first');
  await m.remove(rnpId, true);
  const delRows = bk.listAll().filter((r) => r.deleted && r.serverName === 'NP clone'); assert(delRows.length === 1 && delRows[0].deleted === true && delRows[0].serverName === 'NP clone' && /deleted-\d+$/.test(delRows[0].folder), 'backups of a deleted server stay listed, marked deleted, name from the manifest');
  const fromDeleted = await bk.restoreAsNew({ folder: delRows[0].folder, file: delRows[0].file }, { name: 'Back from the dead' }); eq([m.getConfig(fromDeleted.id).name, rd(fromDeleted.id, 'game.exe')], ['Back from the dead', 'EXE'], 'restore-as-new works from a deleted server');
  const apx = buildApi({ mgr: m, collector: { state: () => ({}) }, publicGames: () => [], shell: { showItemInFolder: (p) => { apx.shown = p; }, openPath: (p) => { apx.opened = p; } }, dialog: {}, app: {}, nativeTheme: {}, getWin: () => null, currentBg: () => '#000', beforeRelaunch() {} });
  assert(apx.backups().length === bk.listAll().length && apx.backups(b1).every((r) => r.serverId === b1) && apx.backups('').length === bk.listAll().length, 'api.backups(): all, api.backups(id): one server');
  for (const k of ['backup', 'backupInfo', 'backupPreview', 'restore', 'restoreNew', 'deleteBackup', 'backupDownload', 'backupOpenFolder']) assert.strictEqual(typeof apx[k], 'function', 'api.' + k);
  eq((await apx.backupPreview(b1, { mode: 'full' })).mode, 'full'); apx.backupDownload(b1, full2); assert(apx.shown === zipPath(b1, full2), 'backupDownload reveals the zip'); apx.backupOpenFolder(delRows[0].folder); assert(apx.opened === path.join(m.backupsDir, delRows[0].folder), 'backupOpenFolder');
  assert.throws(() => apx.backupDownload('../x', 'a.zip'), /Invalid/, 'api confines folder names');
  const apiRn = await apx.restoreNew(b1, full2, { name: 'Via API' }); assert(apiRn.server && apiRn.server.name === 'Via API' && apiRn.id === apiRn.server.id, 'api.restoreNew returns the new server view');
  for (const id of [fromDeleted.id, apiRn.id, rn.id]) await m.remove(id, true);
  belog.stop(); await m.remove(b1, true); P.GAMES.splice(P.GAMES.indexOf(fgame), 1);
  }

  { // Phase 4 block (own scope): clusters
  const { Cluster, sanitizeOptions, pathMatcher } = require('../src/main/services/cluster');
  const { mergeConfig, unifiedDiff, keyGlobs } = require('../src/main/services/clusterMerge');
  const { EventLog: ELog4 } = require('../src/main/services/eventLog');

  // ---- config merge: ini / properties / json / yaml / cfg / text / xml ----
  const mc = (format, parentText, memberText, protect = []) => mergeConfig({ format, parentText, memberText, protect });
  assert(keyGlobs(['rcon.*', 'Port'])(['RCON.password']) && keyGlobs(['rcon.*'])(['rcon.password']) && !keyGlobs(['rcon.*'])(['rcons']) && keyGlobs(['Server?ame'])(['servername']), 'key globs are case-insensitive with * and ?');
  const ini = mc('ini', '[Server]\nName=Parent\nPort=7777\nRCONPassword=parentpw\nMaxPlayers=70\n[Rates]\nXP=2.0\nCustom=1 ; NGSM:ignore\nMissing=1\n', '[Server]\nName=Member\nPort=7778\nRCONPassword=memberpw\nMaxPlayers=10\n[Rates]\nXP=1.0\nCustom=99 ; NGSM:ignore\n[Extra]\nPort=1234\n', ['Port', 'RCON*']);
  eq(ini.text, '[Server]\nName=Parent\nPort=7778\nRCONPassword=memberpw\nMaxPlayers=70\n[Rates]\nXP=2.0\nCustom=99 ; NGSM:ignore\nMissing=1\n[Extra]\nPort=1234\n', 'ini: protected keys and NGSM:ignore lines keep the member value, member-only protected key survives');
  assert(ini.warnings.some((w) => /kept member-only line: Extra\.Port/.test(w)), 'ini: member-only key reported');
  eq(mc('ini', '[A]\nx=1\n[B]\ny=2\n', '[A]\nx=1\nPort=5\n[B]\ny=3\n', ['port']).text, '[A]\nx=1\nPort=5\n[B]\ny=2\n', 'ini: member-only key is inserted into its own section');
  assert(mc('ini', '[S]\r\nPort=1\r\nName=P\r\n', '[S]\r\nPort=2\r\nName=M\r\n', ['port']).text === '[S]\r\nPort=2\r\nName=P\r\n', 'CRLF of the member is kept');
  const miss = mc('ini', '[S]\nPort=7777\nName=P\n', null, ['Port']);
  eq(miss.text, '[S]\nPort=7777\nName=P\n'); assert(miss.warnings.some((w) => /protected key not present in member: S\.Port/.test(w)), 'missing member file: parent value used + warning');
  eq(mc('properties', 'server-port=25565\nrcon.password=\nrcon.port=1\nmotd=Parent\nlevel-name=world # NGSM:ignore\n# comment\n', 'server-port=25570\nrcon.password=secret\nrcon.port=2\nmotd=Member\nlevel-name=mine # NGSM:ignore\n', ['server-port', 'rcon.*']).text,
    'server-port=25570\nrcon.password=secret\nrcon.port=2\nmotd=Parent\nlevel-name=mine # NGSM:ignore\n# comment\n', 'properties');
  const js = mc('json', JSON.stringify({ network: { port: 1, host: 'x' }, rcon: { password: 'p', port: 5 }, name: 'P', list: [1] }), JSON.stringify({ network: { port: 2 }, rcon: { password: 'm', port: 6 }, name: 'M', extra: true }), ['network.port', 'rcon.*']);
  eq(JSON.parse(js.text), { network: { port: 2, host: 'x' }, rcon: { password: 'm', port: 6 }, name: 'P', list: [1] }, 'json: deep key paths'); assert(js.text.startsWith('{\n  "network"'), 'json: 2-space formatting');
  assert(mc('json', '{"a":{"b":1}}', '{}', ['a.b']).warnings.length === 1, 'json: protected key missing in member warns');
  assert.throws(() => mc('json', '{ bad', '{}', []), /not valid JSON/); assert.throws(() => mc('json', '{}', '{ bad', ['a']), /member file is not valid JSON/);
  eq(mc('yaml', 'name: parent\nnetwork:\n  port: 1\n  host: a\nrcon:\n  password: p\n  port: 5\nmotd: hi # NGSM:ignore\nitems:\n  - a\n', 'name: member\nnetwork:\n  port: 2\n  host: b\nrcon:\n  password: m\n  port: 6\nmotd: custom # NGSM:ignore\n', ['network.port', 'rcon']).text,
    'name: parent\nnetwork:\n  port: 2\n  host: a\nrcon:\n  password: m\n  port: 6\nmotd: custom # NGSM:ignore\nitems:\n  - a\n', 'yaml: indented keys, protected block keeps its children');
  eq(mc('cfg', 'hostname "Parent"\nrcon_password "pp"\nsv_cheats 0\n// c\nexec a.cfg\nexec b.cfg\n', 'hostname "Member"\nrcon_password "mm"\nexec x.cfg\nexec y.cfg\n', ['hostname', 'rcon_password']).text,
    'hostname "Member"\nrcon_password "mm"\nsv_cheats 0\n// c\nexec a.cfg\nexec b.cfg\n', 'cfg (key value) with repeated keys');
  eq(mc('text', 'Line A\nPort 1 # NGSM:ignore\nLine C\n', 'Zzz\nPort 2\n').text, 'Line A\nPort 2\nLine C\n', 'text: NGSM:ignore line matched by content'); assert(!mc('text', 'a\nPort 1 // NGSM:ignore\n', 'Port 2\n').warnings.some((w) => /nothing in it/.test(w)));
  assert(mc('text', 'a\nb\n', 'c\n', ['x']).warnings.some((w) => /nothing in it can be protected/.test(w)) && mc('text', 'a\nb\n', 'c\n').text === 'a\nb\n', 'text without markers: whole copy + warning');
  eq(mc('xml', '<c>\n  <port>7777</port> <!-- NGSM:ignore -->\n  <name>P</name>\n</c>\n', '<c>\n  <port>8888</port>\n  <name>M</name>\n</c>\n').text, '<c>\n  <port>8888</port>\n  <name>P</name>\n</c>\n', 'xml: <!-- NGSM:ignore --> keeps the member line');
  for (const mark of ['# NGSM:ignore', '// NGSM:ignore', '; NGSM:ignore', '<!-- NGSM:ignore -->']) eq(mc('properties', `k=1 ${mark}\n`, 'k=2\n').text, 'k=2\n', 'marker style ' + mark);
  const df = unifiedDiff('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nX\nd\ne\nf\ng\nh\ni\n'); assert(/^@@ -1,8 \+1,9 @@/m.test(df.text) && df.text.includes('-c\n+X') && df.added === 2 && df.removed === 1, 'unified diff: ' + JSON.stringify(df.text)); eq(unifiedDiff('x\n', 'x\n').text, '', 'no diff when equal');

  // ---- sanitising / path matching ----
  eq(sanitizeOptions({ protect: ['a', 5, ' b '], preserve: ['saves/'], clearFolders: [{ path: 'logs', pattern: '*.log', olderThanDays: 3 }, { path: 'tmp', recursive: true }], onlyChanged: true }), { protect: ['a', 'b'], preserve: ['saves'], clearFolders: [{ path: 'logs', pattern: '*.log', olderThanDays: 3 }, { path: 'tmp', pattern: '*', recursive: true }], onlyChanged: true }, 'options sanitised');
  assert.throws(() => sanitizeOptions({ clearFolders: [{ path: '../x' }] }), /Invalid path/); assert.throws(() => sanitizeOptions({ preserve: ['C:/win'] }), /Invalid path/);
  const pm = pathMatcher(['saves', 'cfg/*.ini', '*.sav', 'a/b.txt']);
  assert(pm('saves') && pm('saves/x/y.dat') && pm('cfg/server.ini') && pm('deep/world.sav') && pm('a/b.txt') && !pm('cfg/server.cfg') && !pm('other/saves') && !pm('savesX'), 'preserve path matcher (anchored, wildcard by name, covers children)');

  // ---- fake plugin game + servers ----
  const cgDir = path.join(dir, 'clfake-plugin'); fs.mkdirSync(cgDir);
  const cgame = P.toGame({ id: 'clfake', name: 'Cluster Fake', install: { steps: [{ type: 'write', path: 'game.exe', content: 'EXE' }, { type: 'write', path: 'data/base.txt', content: 'base', overwrite: true }] }, run: { exe: 'game.exe', args: [] },
    defaults: { port: '31000', queryPort: '31001', map: 'm', maxPlayers: '4' },
    configs: [{ id: 'ini', name: 'server.ini', path: 'cfg/server.ini', format: 'ini', protect: ['Port', 'RCONPassword'] }, { id: 'props', name: 'server.properties', path: 'server.properties', format: 'properties', protect: ['server-port'] },
      { id: 'json', name: 'settings.json', path: 'cfg/settings.json', format: 'json', protect: ['network.port'] }, { id: 'yaml', name: 'conf.yml', path: 'cfg/conf.yml', format: 'yaml', protect: ['port'] },
      { id: 'cfg', name: 'server.cfg', path: 'cfg/server.cfg', format: 'cfg', protect: ['hostname'] }, { id: 'txt', name: 'motd.txt', path: 'cfg/motd.txt', format: 'text' }],
    cluster: { protectedConfigKeys: ['rcon.*', 'secret'], preserve: ['saves', 'data/keep.dat'], clearFolders: [{ path: 'logs', pattern: '*.log', olderThanDays: 7 }] } }, cgDir, 'user');
  P.GAMES.push(cgame);
  const cput = (id, rel, data) => { const f = path.join(m.filesDir(id), rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
  const crd = (id, rel) => fs.readFileSync(path.join(m.filesDir(id), rel), 'utf8');
  const cex = (id, rel) => fs.existsSync(path.join(m.filesDir(id), rel));
  const p1 = m.create('clfake', 'Alpha').id; const p2 = m.create('clfake', 'Beta').id; const p3 = m.create('clfake', 'Gamma').id; const px = m.create('csgo', 'Other game').id;
  for (const id of [p1, p2, p3]) await m.install(id);
  const celog = new ELog4(m, P, m.settings, dir); celog.start();
  const cl = new Cluster(m, P, m.settings, dir); cl.start(); assert(m._cluster === cl, 'registered as mgr._cluster');
  const cevs = []; for (const n of ['created', 'deleted', 'update-started', 'update-finished', 'update-failed', 'config-synced', 'cleared']) m.events.on('cluster:' + n, (p) => cevs.push([n, p]));

  // ---- create validation ----
  assert.throws(() => cl.create({ name: 'x', memberIds: [p1] }), /at least 2/, 'single member rejected');
  assert.throws(() => cl.create({ name: 'x', memberIds: [p1, p1] }), /at least 2/, 'duplicate ids count once');
  assert.throws(() => cl.create({ name: 'x', memberIds: [p1, px] }), /same game/, 'mixed games rejected');
  assert.throws(() => cl.create({ name: 'x', memberIds: [p1, '999'] }), /does not exist/);
  assert.throws(() => cl.create({ name: 'x', memberIds: [p1, p2], parentId: p3 }), /parent .* member/, 'parent must be a member');
  eq(cl.list(), [], 'nothing was stored by failed creates');
  const cv = cl.create({ name: 'Main', memberIds: [p1, p2, p3], parentId: p1 });
  eq([cv.id, cv.game, cv.parentId, cv.memberIds, cv.gameName, cv.members.map((x) => x.name), cv.members.map((x) => x.isParent)], ['1', 'clfake', p1, [p1, p2, p3], 'Cluster Fake', ['Alpha', 'Beta', 'Gamma'], [true, false, false]], 'cluster created');
  assert(cv.preserve.includes('cfg/server.ini') && cv.preserve.includes('saves') && cv.preserve.includes('configs/wgsm.json'), 'effective preserve list shows config paths, plugin preserve and wgsm.json'); eq(cv.protectedKeys, ['rcon.*', 'secret']);
  assert.throws(() => cl.create({ name: 'again', memberIds: [p2, p3] }), /already in the cluster "Main"/, 'a server can be in only one cluster');
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'clusters.json'), 'utf8')); eq([disk.version, disk.clusters.length, disk.clusters[0].memberIds], [1, 1, [p1, p2, p3]], 'clusters.json written'); assert(!fs.existsSync(path.join(dir, 'clusters.json.tmp')), 'atomic write leaves no temp file');
  eq(new Cluster(m, P, m.settings, dir).list().map((x) => x.name), ['Main'], 'a fresh instance reads the file');
  assert.throws(() => cl.save('1', { memberIds: [p1, px] }), /same game/); assert.throws(() => cl.save('1', { parentId: px }), /parent/);
  eq(cl.save('1', { name: 'Main cluster' }).name, 'Main cluster', 'rename'); eq(cl.setParent('1', p2).parentId, p2, 'set parent'); eq(cl.setParent('1', p1).parentId, p1);
  assert.throws(() => cl.save('1', { options: { clearFolders: [{ path: '../outside' }] } }), /Invalid path/, 'path escape rejected when saving rules');
  eq(cl.save('1', { options: { protect: ['mykey'] } }).protectedKeys, ['rcon.*', 'secret', 'mykey']); cl.save('1', { options: { protect: [] } });
  assert.throws(() => cl.get('77'), /not found/); assert.throws(() => cl.updatePlan('77'), /not found/);

  // ---- config sync through the service ----
  const IN = (port, name) => `[Server]\nName=${name}\nPort=${port}\nRCONPassword=${name}pw\nMaxPlayers=${name === 'Alpha' ? 70 : 10}\n`;
  cput(p1, 'cfg/server.ini', IN(7777, 'Alpha')); cput(p2, 'cfg/server.ini', IN(7778, 'Beta')); // p3 has no file yet
  cput(p1, 'server.properties', 'server-port=25565\nrcon.password=\nmotd=Alpha\n'); cput(p2, 'server.properties', 'server-port=25566\nrcon.password=betapw\nmotd=Beta\n'); cput(p3, 'server.properties', 'server-port=25567\nrcon.password=gammapw\nmotd=Gamma\n');
  cput(p1, 'cfg/settings.json', JSON.stringify({ network: { port: 1 }, rcon: { password: 'a' }, name: 'A' })); cput(p2, 'cfg/settings.json', JSON.stringify({ network: { port: 2 }, rcon: { password: 'b' }, name: 'B' }));
  cput(p1, 'cfg/conf.yml', 'name: A\nport: 1\nsecret: s1\n'); cput(p2, 'cfg/conf.yml', 'name: B\nport: 2\nsecret: s2\n');
  cput(p1, 'cfg/server.cfg', 'hostname "Alpha"\nsv_cheats 1\n'); cput(p2, 'cfg/server.cfg', 'hostname "Beta"\nsv_cheats 0\n');
  cput(p1, 'cfg/motd.txt', 'Welcome\n'); cput(p2, 'cfg/motd.txt', 'Old\n');
  const before2 = crd(p2, 'cfg/server.ini');
  const plan = cl.configPlan('1', { configIds: ['ini', 'props', 'json', 'yaml', 'cfg', 'txt'] });
  eq(plan.members.map((x) => x.id), [p2, p3], 'plan covers the members, not the parent'); eq(crd(p2, 'cfg/server.ini'), before2, 'config plan writes nothing'); assert(!cex(p3, 'cfg/server.ini'), 'plan creates no file');
  const pf = (mid, cid) => plan.members.find((x) => x.id === mid).files.find((x) => x.configId === cid);
  assert(pf(p2, 'ini').status === 'changed' && /^-MaxPlayers=10$/m.test(pf(p2, 'ini').diff) && /^\+MaxPlayers=70$/m.test(pf(p2, 'ini').diff) && !/Port=7777/.test(pf(p2, 'ini').diff), 'diff shows the change but not the protected port');
  assert(pf(p3, 'ini').status === 'new' && pf(p3, 'ini').warnings.some((w) => /protected key not present in member/.test(w)), 'missing member file = new, with warning'); assert(pf(p2, 'txt').warnings.some((w) => /nothing in it can be protected/.test(w)), 'text warning surfaced');
  assert.throws(() => cl.configPlan('1', { configIds: [] }), /at least one/); assert.throws(() => cl.configPlan('1', { configIds: ['nope'] }), /Unknown config/);
  fs.rmSync(path.join(m.filesDir(p1), 'cfg/motd.txt')); assert.throws(() => cl.configPlan('1', { configIds: ['txt'] }), /parent server has no/); cput(p1, 'cfg/motd.txt', 'Welcome\n');
  const ap = cl.configApply('1', { configIds: ['ini', 'props', 'json', 'yaml', 'cfg', 'txt'] });
  assert(ap.errors === 0 && ap.written === 12, 'applied: ' + JSON.stringify([ap.written, ap.errors]));
  eq(crd(p2, 'cfg/server.ini'), '[Server]\nName=Alpha\nPort=7778\nRCONPassword=Betapw\nMaxPlayers=70\n', 'ini: unique port and rcon kept on the member'); eq(crd(p2, 'cfg/server.ini.bak'), before2, '.bak of the previous member file');
  eq(crd(p3, 'cfg/server.ini'), IN(7777, 'Alpha'), 'new member file created from the parent'); assert(!cex(p3, 'cfg/server.ini.bak'));
  eq(crd(p2, 'server.properties'), 'server-port=25566\nrcon.password=betapw\nmotd=Alpha\n', 'properties: port + cluster-wide rcon.* kept'); eq(crd(p3, 'server.properties'), 'server-port=25567\nrcon.password=gammapw\nmotd=Alpha\n');
  eq(JSON.parse(crd(p2, 'cfg/settings.json')), { network: { port: 2 }, rcon: { password: 'b' }, name: 'A' }, 'json: network.port + rcon.* kept'); eq(crd(p2, 'cfg/conf.yml'), 'name: A\nport: 2\nsecret: s2\n', 'yaml: port and cluster-wide secret kept');
  eq(crd(p2, 'cfg/server.cfg'), 'hostname "Beta"\nsv_cheats 1\n', 'cfg'); eq(crd(p2, 'cfg/motd.txt'), 'Welcome\n', 'text: whole copy');
  eq(cl.configApply('1', { configIds: ['ini', 'props'] }).written, 0, 'applying twice changes nothing'); assert(cevs.some(([n, p]) => n === 'config-synced' && p.detail.written === 12), 'config-synced event');
  const ref = celog.query({ event: 'cluster:config-sync' }); assert(ref.length === 12 && ref.every((r) => /Cluster "Main cluster"/.test(r.message)), 'config syncs are logged');
  assert(celog.query({ event: 'server:config' }).length >= 12, 'each written member config also emits server:config');
  cput(p2, 'cfg/settings.json', '{ broken'); const bad = cl.configApply('1', { configIds: ['json'], memberIds: [p2] }); assert(bad.errors === 1 && /not valid JSON/.test(bad.members[0].files[0].error) && crd(p2, 'cfg/settings.json') === '{ broken', 'a broken member file is reported and left alone');
  eq(cl.configPlan('1', { configIds: ['ini'], memberIds: [p3] }).members.map((x) => x.id), [p3], 'memberIds subset');

  // ---- cluster update: distribution ----
  cput(p1, 'data/base.txt', 'v2'); cput(p1, 'data/new.bin', 'NEW'); cput(p1, 'data/keep.dat', 'PARENT-KEEP'); cput(p1, 'saves/world.sav', 'PARENT-SAVE'); cput(p1, 'configs/wgsm.json', 'PARENT-WGSM'); cput(p1, 'cfg/server.ini.bak', 'PARENT-BAK');
  for (const id of [p2, p3]) { cput(id, 'data/keep.dat', `KEEP-${id}`); cput(id, 'saves/world.sav', `SAVE-${id}`); cput(id, 'configs/wgsm.json', `WGSM-${id}`); }
  const cfgBefore = { [p2]: crd(p2, 'cfg/server.ini'), [p3]: crd(p3, 'cfg/server.ini') }; const wgsmBefore = fs.readFileSync(m.cfgFile(p2), 'utf8');
  const outside = path.join(dir, 'outside-target'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUT');
  let junction = true; try { fs.symlinkSync(outside, path.join(m.filesDir(p1), 'linkdir'), 'junction'); } catch { junction = false; }
  const up = cl.updatePlan('1', { onlyChanged: false });
  eq(up.members.map((x) => x.id), [p2, p3]); assert(up.members.every((x) => x.files >= 3 && x.bytes > 0 && x.skippedPreserved >= 4 && !x.error) && up.preserve.includes('saves') && up.files === up.members[0].files * 2, 'update plan: counts, sizes, preserve list');
  assert(['saves', 'data/keep.dat', 'cfg/server.ini', 'configs/wgsm.json'].every((x) => up.members[0].preservedPaths.includes(x)), 'configs, plugin preserve and wgsm.json are in the preserved paths'); eq(crd(p2, 'data/base.txt'), 'base', 'plan writes nothing');
  if (junction) assert(up.members[0].skippedLinks === 1, 'plan counts links as skipped');
  const prog = []; cl.onProgress = (x) => prog.push(x);
  const r1 = await cl.update('1', { skipParentUpdate: true });
  assert(r1.ok && r1.members.length === 2 && r1.members.every((x) => x.ok && x.files > 0 && x.failed === 0), 'update ok: ' + JSON.stringify(r1.members));
  for (const id of [p2, p3]) {
    eq([crd(id, 'data/base.txt'), crd(id, 'data/new.bin'), crd(id, 'game.exe')], ['v2', 'NEW', 'EXE'], 'game files distributed to ' + id);
    eq([crd(id, 'data/keep.dat'), crd(id, 'saves/world.sav'), crd(id, 'configs/wgsm.json')], [`KEEP-${id}`, `SAVE-${id}`, `WGSM-${id}`], 'preserve paths + wgsm.json untouched on ' + id);
    eq(crd(id, 'cfg/server.ini'), cfgBefore[id], 'plugin config files untouched on ' + id); assert(!cex(id, 'cfg/server.ini.bak') || crd(id, 'cfg/server.ini.bak') !== 'PARENT-BAK', 'config .bak untouched'); assert(!cex(id, 'linkdir'), 'links are not followed or copied');
  }
  eq(fs.readFileSync(m.cfgFile(p2), 'utf8'), wgsmBefore, 'configs/wgsm.json of the member untouched'); eq(fs.readdirSync(outside), ['secret.txt'], 'nothing written outside');
  assert(prog.length >= 3 && prog[prog.length - 1].phase === 'done' && prog[prog.length - 1].percent === 100 && prog.some((x) => x.phase === 'member' && x.memberId === p3 && x.memberName === 'Gamma') && prog.every((x, i) => !i || x.percent >= prog[i - 1].percent), 'progress events: monotonic, per member, ends at 100');
  assert(!fs.readdirSync(path.join(m.filesDir(p2), 'data')).some((f) => f.endsWith('.ngsm-tmp')), 'no temp files left');
  // onlyChanged
  const oc0 = cl.updatePlan('1', { onlyChanged: true }); assert(oc0.members.every((x) => x.files === 0 && x.skippedIdentical > 0), 'onlyChanged plan: everything identical after a copy');
  const r2 = await cl.update('1', { skipParentUpdate: true, onlyChanged: true }); assert(r2.ok && r2.members.every((x) => x.files === 0 && x.skippedIdentical > 0), 'onlyChanged copies nothing');
  cput(p1, 'data/base.txt', 'v3-longer'); const r3 = await cl.update('1', { skipParentUpdate: true, onlyChanged: true }); assert(r3.members.every((x) => x.files === 1) && crd(p3, 'data/base.txt') === 'v3-longer', 'onlyChanged copies just the changed file');
  eq((await cl.update('1', { skipParentUpdate: true, onlyChanged: false })).members.map((x) => x.files > 1), [true, true], 'without onlyChanged everything is copied again');
  cl.save('1', { options: { onlyChanged: true } }); assert(cl.updatePlan('1').onlyChanged === true && cl.updatePlan('1', { onlyChanged: false }).onlyChanged === false, 'onlyChanged cluster default'); cl.save('1', { options: { onlyChanged: false } });
  // user preserve rule
  cl.save('1', { options: { preserve: ['data/new.bin'] } }); cput(p1, 'data/new.bin', 'NEW2'); await cl.update('1', { skipParentUpdate: true }); eq(crd(p2, 'data/new.bin'), 'NEW', 'cluster preserve rule honoured'); cl.save('1', { options: { preserve: [] } });
  // parent update goes through mgr.update (validate option) and emits server:updated
  const upd = []; m.events.on('server:updated', (p) => upd.push(p)); await cl.update('1', { validate: true }); assert(upd.length === 1 && upd[0].id === p1 && upd[0].detail.validate === true && upd[0].detail.cluster === '1', 'parent updated via mgr.update(validate)');
  eq(crd(p2, 'data/base.txt'), 'base', 'files were distributed after the parent update (steps rewrote base.txt)');
  assert(cevs.filter(([n]) => n === 'update-started').length >= 5 && cevs.some(([n, p]) => n === 'update-finished' && p.detail.ok === true), 'cluster:update-started / finished events');
  assert(celog.query({ event: 'cluster:update-started' }).length >= 5 && celog.query({ event: 'cluster:update-finished' })[0].level === 'info', 'update logged');
  // failures: one member failing does not stop the others
  const evBefore = cevs.length; m.rt(p2).busy = 'Installing'; cput(p1, 'data/base.txt', 'v9');
  const rf = await cl.update('1', { skipParentUpdate: true }); m.rt(p2).busy = null;
  assert(rf.ok === false && rf.members[0].id === p2 && rf.members[0].ok === false && /Busy: Installing/.test(rf.members[0].error) && rf.members[1].ok === true && crd(p3, 'data/base.txt') === 'v9' && crd(p2, 'data/base.txt') === 'base', 'busy member fails, the next one is still updated');
  assert(celog.query({ event: 'cluster:update-member-failed' }).length === 1 && cevs.slice(evBefore).some(([n, p]) => n === 'update-finished' && p.detail.ok === false), 'member failure logged, run finished');
  if (junction) { fs.symlinkSync(outside, path.join(m.filesDir(p3), 'data', 'linked'), 'junction'); cput(p1, 'data/linked/x.txt', 'X'); const rj = await cl.update('1', { skipParentUpdate: true, memberIds: [p3] }); assert(!rj.ok && rj.members[0].failed === 1 && /link/.test(rj.members[0].failures[0]) && rj.members[0].files > 0 && fs.readdirSync(outside).join() === 'secret.txt', 'a link inside a member is not followed (that file fails, the rest is copied)'); }
  const fmember = path.join(m.filesDir(p3), 'data', 'base.txt'); fs.rmSync(fmember); fs.mkdirSync(fmember); cput(p1, 'data/base.txt', 'v10'); const rd2 = await cl.update('1', { skipParentUpdate: true, memberIds: [p3] }); assert(!rd2.ok && rd2.members[0].failed >= 1 && rd2.members[0].failures.some((f) => /folder/.test(f)), 'a file that cannot be written is reported per member'); fs.rmSync(fmember, { recursive: true });
  // running members are stopped before and restarted after the copy
  { const calls = []; const real = { isRunning: m.isRunning, stop: m.stop, start: m.start }; let running = true;
    cput(p3, 'data/base.txt', 'old3');
    m.isRunning = (id) => (String(id) === p3 ? running : real.isRunning.call(m, id)); m.stop = async (id) => { if (String(id) === p3) { calls.push(['stop', crd(p3, 'data/base.txt')]); running = false; return; } return real.stop.call(m, id); }; m.start = async (id) => { if (String(id) === p3) { calls.push(['start', crd(p3, 'data/base.txt')]); running = true; return; } return real.start.call(m, id); };
    cput(p1, 'data/base.txt', 'v11'); const rr = await cl.update('1', { skipParentUpdate: true, memberIds: [p3] }); m.isRunning = real.isRunning; m.stop = real.stop; m.start = real.start;
    eq(calls, [['stop', 'old3'], ['start', 'v11']], 'stop happens before the copy, start after'); assert(rr.members[0].wasRunning && rr.members[0].restarted, 'member restarted because it was running'); }
  eq(cl.updatePlan('1', { memberIds: ['999'] }).members, [], 'ids that are not members are ignored');
  // busy cluster
  { const pend = cl.update('1', { skipParentUpdate: true }); await assert.rejects(cl.update('1', { skipParentUpdate: true }), /already busy/, 'one operation per cluster at a time'); assert.throws(() => cl.save('1', { name: 'busy' }), /busy/); assert.throws(() => cl.delete('1'), /busy/); await pend; }

  // ---- clear folders ----
  const ago = (days) => new Date(Date.now() - days * 86400000);
  for (const id of [p1, p2, p3]) { for (const [f, d] of [['logs/old.log', 10], ['logs/new.log', 1], ['logs/old.txt', 30], ['logs/sub/deep.log', 30]]) { const fp = cput(id, f, 'x'.repeat(100)); fs.utimesSync(fp, ago(d), ago(d)); } }
  const cp = cl.clearPlan('1'); eq([cp.members.map((x) => x.id), cp.files, cp.bytes], [[p1, p2, p3], 3, 300], 'clear plan: only old *.log files, parent included'); eq(cp.members[0].sample, ['logs/old.log']); assert(cp.members[0].rules[0].exists && cp.members[0].rules[0].files === 1);
  assert(cex(p1, 'logs/old.log'), 'plan deletes nothing');
  const cr = cl.clear('1'); eq([cr.files, cr.bytes, cr.locked], [3, 300, 0], 'cleared'); for (const id of [p1, p2, p3]) { assert(!cex(id, 'logs/old.log') && cex(id, 'logs/new.log') && cex(id, 'logs/old.txt') && cex(id, 'logs/sub/deep.log') && cex(id, 'logs'), 'only matching old files in the folder are deleted (pattern, age, no sub-folders, folder kept) on ' + id); }
  assert(celog.query({ event: 'cluster:clear' }).length === 3 && cevs.some(([n, p]) => n === 'cleared' && p.detail.files === 3), 'clear is logged and emitted');
  cl.save('1', { options: { clearFolders: [{ path: 'logs', pattern: 'old.*', olderThanDays: 20, recursive: true }] } });
  const cp2 = cl.clearPlan('1', { memberIds: [p2] }); eq([cp2.files, cp2.members.length], [1, 1], 'cluster rules are merged with the plugin rules for a member subset (old.txt, 30 days)');
  assert.throws(() => cl.save('1', { options: { clearFolders: [{ path: 'logs/../../x' }] } }), /Invalid path/);
  cl.save('1', { options: { clearFolders: [] } });
  // escape through a plugin rule that bypassed validation + links
  cgame.cluster.clearFolders.push({ path: '..', pattern: '*' }, { path: 'cfg/../../outside-target', pattern: '*' }, { path: 'C:/Windows', pattern: '*' }, { path: 'data/linked', pattern: '*' });
  const ce = cl.clearPlan('1'); assert(ce.members.every((x) => x.errors.length >= 3 && x.rules.filter((r) => r.error).length >= 3), 'escaping rules are rejected: ' + JSON.stringify(ce.members[0].errors));
  cl.clear('1'); eq(fs.readdirSync(outside), ['secret.txt'], 'nothing outside the server folder is deleted, links not followed'); cgame.cluster.clearFolders.length = 1;
  const savedRules = cgame.cluster.clearFolders.splice(0); assert.throws(() => cl.clearPlan('1'), /No folders to clear/); cgame.cluster.clearFolders.push(...savedRules);

  // ---- IPC table ----
  const apc = buildApi({ mgr: m, collector: { state: () => ({}) }, publicGames: () => [], shell: {}, dialog: {}, app: {}, nativeTheme: {}, getWin: () => null, currentBg: () => '#000', beforeRelaunch() {}, cluster: cl });
  for (const k of ['clusters', 'clusterCreate', 'clusterSave', 'clusterDelete', 'clusterUpdatePlan', 'clusterUpdate', 'clusterConfigPlan', 'clusterConfigApply', 'clusterClearPlan', 'clusterClear']) assert.strictEqual(typeof apc[k], 'function', 'api.' + k);
  eq(apc.clusters().map((x) => x.id), ['1']); assert((await apc.clusterUpdate('1', { skipParentUpdate: true })).ok); assert.throws(() => buildApi({ mgr: m, collector: {}, publicGames: () => [], shell: {}, dialog: {}, app: {}, nativeTheme: {}, getWin: () => null, currentBg: () => '#000', beforeRelaunch() {} }).clusters(), /Service not available/);

  // ---- member removal cleanup ----
  await m.remove(p3, true); eq(cl.get('1').memberIds, [p1, p2], 'a removed member leaves the cluster'); assert(celog.query({ event: 'cluster:member-removed' }).length === 1 && fs.existsSync(m.filesDir(p1)), 'logged, other servers untouched');
  const p4 = m.create('clfake', 'Delta').id; await m.install(p4); cl.addMember('1', p4); eq(cl.get('1').memberIds, [p1, p2, p4], 'addMember'); eq(cl.removeMember('1', p4).memberIds, [p1, p2], 'removeMember'); await m.remove(p4, true);
  await m.remove(p1, true); assert(cl.list().length === 0, 'removing a member that leaves one server dissolves the cluster'); assert(cex(p2, 'game.exe') && m.getConfig(p2), 'the remaining server is untouched'); assert(celog.query({ event: 'cluster:dissolved' }).length === 1 && cevs.some(([n]) => n === 'deleted'), 'dissolve logged and emitted');
  eq(JSON.parse(fs.readFileSync(path.join(dir, 'clusters.json'), 'utf8')).clusters, [], 'clusters.json updated');
  // parent removal promotes another member; delete never deletes servers
  const q1 = m.create('clfake', 'Q1').id; const q2 = m.create('clfake', 'Q2').id; const q3 = m.create('clfake', 'Q3').id; const qc = cl.create({ name: 'Q', memberIds: [q1, q2, q3], parentId: q1 });
  await m.remove(q1, true); eq([cl.get(qc.id).parentId, cl.get(qc.id).memberIds], [q2, [q2, q3]], 'deleting the parent promotes the first remaining member');
  cl.delete(qc.id); eq(cl.list(), [], 'cluster deleted'); assert(m.getConfig(q2) && m.getConfig(q3), 'delete keeps the servers'); assert.throws(() => cl.delete(qc.id), /not found/);
  // corrupt file is set aside
  cl.stop(); fs.writeFileSync(path.join(dir, 'clusters.json'), '{ nope'); eq(new Cluster(m, P, m.settings, dir).list(), [], 'corrupt clusters.json starts empty'); assert(fs.readdirSync(dir).some((f) => /^clusters\.json\.corrupt-/.test(f)), 'corrupt file kept aside');
  for (const id of [p2, q2, q3, px]) await m.remove(id, true);
  celog.stop(); P.GAMES.splice(P.GAMES.indexOf(cgame), 1);
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
  for (const v of ['servers', 'table', 'dashboard', 'plugins', 'settings', 'discord', 'logs', 'backups', 'clusters']) assert(html.includes('data-view="' + v + '"'), 'nav entry for view ' + v);
  for (const id of ['leftPanel', 'rightPanel', 'bottomPanel', 'metrics', 'setStats', 'tgLeft', 'tgRight', 'tgBottom', 'tgNav', 'vPlugins', 'vSettings', 'vDiscord', 'vLogs', 'dcWebhook', 'dcTest', 'dcEvents', 'dcEditor', 'dcPreview', 'lgTable', 'vBackups', 'bvTable', 'bvServer', 'dlgBkNew', 'bnForm', 'vClusters', 'clList', 'clDetail', 'clNew', 'dlgClNew', 'cnForm', 'cnServers']) assert(html.includes('id="' + id + '"'), 'element #' + id);
  for (const k of ['website', 'discord', 'patreon', 'paypal', 'buymeacoffee']) assert(html.includes('data-link="' + k + '"'), 'footer link ' + k);
  const boot = fs.readFileSync(path.join(RD, 'theme-boot.js'), 'utf8');
  assert(/nodegsm\.ui/.test(boot) && /leftCollapsed/.test(boot), 'theme-boot applies the panel layout before first paint');

  // bundled plugins that ship cluster rules
  for (const id of ['mc', 'arkse', 'rust']) { const g = P.byId(id); assert(g.cluster.preserve.length && g.cluster.clearFolders.length && g.cluster.protectedConfigKeys.length, 'bundled ' + id + ' declares cluster rules'); }
  assert(P.byId('mc').configs[0].protect.includes('server-port') && P.byId('arkse').configs[0].protect.includes('ServerAdminPassword'), 'configs[].protect shipped for mc and arkse');
  assert(P.validate({ id: 'cl1', name: 'N', install: { type: 'manual' }, run: { exe: 'a.exe' }, cluster: { clearFolders: [{ path: 'logs', recursive: 'yes' }] } }, null).errors.some((x) => /recursive/.test(x)), 'clearFolders.recursive must be boolean');
  console.log('smoke test passed');
  m.logTail.shutdown(); fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
