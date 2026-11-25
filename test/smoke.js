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
  fs.writeFileSync(path.join(mdir, 'fake.js'), "let n=0;console.log('fps=60');process.stdin.on('data',d=>{const t=String(d);if(/quit/.test(t))process.exit(0);if(/stats/.test(t))console.log('fps='+(60+(++n)));if(/tps/.test(t))console.log(String.fromCharCode(27)+'[32mTPS: '+String.fromCharCode(167)+'a*19,5');});setInterval(()=>{},1000);");
  const sw = P.byId('sw');
  sw.logs = [{ id: 'l', name: 'L', path: 'x.log' }];
  sw.metrics = [{ id: 'fps', name: 'Server FPS', unit: 'fps', source: 'console', pattern: 'fps[:= ]+([0-9.]+)', command: 'stats', intervalSec: 2 }, { id: 'tps', name: 'Server TPS', unit: 'TPS', kind: 'tick', source: 'console', command: 'tps', pattern: 'TPS: *([^ ]+)', intervalSec: 2, tickTarget: 20, warnBelow: 18, badBelow: 15 }, { id: 'ents', name: 'Entities', source: 'log:l', pattern: 'entities (\\d+)' }];
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
  { const tk = snap.servers.find((r) => r.id === a1);
    assert(tk.metrics['m:tps'] && tk.metrics['m:tps'].value === 19.5 && tk.metrics['m:tps'].kind === 'tick' && tk.metrics['m:tps'].cls === 'good', 'tick metric: console command polled, ANSI + section colour codes and decimal comma parsed, classified: ' + JSON.stringify(tk.metrics));
    assert(tk.tick && tk.tick.value === 19.5 && tk.tick.unit === 'TPS' && tk.tick.name === 'Server TPS' && tk.tick.target === 20, 'row.tick summarises the tick metric'); assert(!tk.metrics.latency, 'a game with a tick metric gets no latency estimate');
    assert(snap.defs.some((d) => d.id === 'm:tps' && d.kind === 'tick' && d.higherIsBetter === true) && snap.defs.some((d) => d.id === 'm:ents' && !d.kind) && !tk.metrics['m:fps'].kind && !tk.metrics['m:fps'].cls, 'kind / cls only for tick metrics (existing metrics unchanged)'); assert(col.history[col.history.length - 1].s[a1].k === 19.5, 'history point has the tick value'); }
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
    consoles: [{ id: 'game', name: 'Game', type: 'process' }, { id: 'lg', name: 'Log', type: 'log', source: 'l' }, { id: 'r', name: 'RCON', type: 'rcon', source: 'rcon:{rcon.port}:{rcon.password}' }],
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

  // =====================================================================================================
  // ---- Phase 5: structured config editor, files auto-clear, injected consoles (RCON), update / validate ----
  // =====================================================================================================
  {
    const CE = require('../src/main/configEdit');
    const net = require('net'); const util = require('util');
    const { RconClient, packet } = require('../src/main/rcon');
    const { Consoles, parseRconSource } = require('../src/main/services/consoles');
    const { AutoClear } = require('../src/main/services/autoClear');
    const { EventLog: EL5 } = require('../src/main/services/eventLog');
    const { buildApi } = require('../src/main/api');
    const { SteamCMD } = require('../src/main/steamcmd');
    const lines = (t) => t.split('\n');
    const ent = (r, p) => r.entries.find((e) => e.path === p);
    const setv = (fmt, text, p, v) => CE.edit(fmt, text, [{ op: 'set', id: CE.parse(fmt, text).entries.find((e) => e.path === p).id, value: v }]).text;

    // ---- structured parse / serialize: comments and unknown lines survive, only the edited line changes ----
    const INI = '; header comment\n[Server]\nName = My Server ; not a comment for the parser\nPort=7777\n\n# note\n[Rules]\nPvP=true\nweird line without equals\n';
    const pi = CE.parse('ini', INI);
    assert(pi.ok && pi.entries.length === 3 && ent(pi, 'Server.Port').value === '7777' && ent(pi, 'Rules.PvP').value === 'true', 'ini parse');
    eq(CE.edit('ini', INI, pi.entries.map((e) => ({ op: 'set', id: e.id, value: e.value })).slice(0, 1)).text, INI, 'ini: setting the same value is a no-op (round trip)');
    const i2 = setv('ini', INI, 'Server.Port', '7778'); eq(lines(i2).filter((l, i) => l !== lines(INI)[i]), ['Port=7778'], 'ini: only the edited line changed');
    const i3 = CE.edit('ini', INI, [{ op: 'add', path: 'Slots', section: 'Server', value: '16' }]).text;
    eq(lines(i3).slice(2, 6), ['Name = My Server ; not a comment for the parser', 'Port=7777', 'Slots=16', ''], 'ini: key added at the end of its section'); assert(i3.includes('# note') && i3.includes('weird line without equals'), 'ini: comments and unknown lines kept');
    assert(CE.edit('ini', INI, [{ op: 'add', path: 'X', section: 'NewSec', value: '1' }]).text.endsWith('weird line without equals\n\n[NewSec]\nX=1\n'), 'ini: new section appended');
    assert(!CE.edit('ini', INI, [{ op: 'remove', id: ent(pi, 'Server.Port').id }]).text.includes('Port=7777') && CE.edit('ini', INI, [{ op: 'remove', id: ent(pi, 'Server.Port').id }]).text.includes('# note'), 'ini: remove deletes only the line');
    assert.throws(() => CE.edit('ini', INI, [{ op: 'add', path: 'Port', section: 'Server', value: '1' }]), /already exists/, 'ini: duplicate key refused'); assert.throws(() => CE.edit('ini', INI, [{ op: 'add', path: 'a=b', value: '1' }]), /Invalid key/); assert.throws(() => CE.edit('ini', INI, [{ op: 'add', path: 'k', value: 'a\nb' }]), /line breaks/, 'values cannot inject lines');
    assert.strictEqual(CE.edit('ini', '[A]\r\nk=1\r\n', [{ op: 'add', path: 'z', section: 'A', value: '2' }]).text, '[A]\r\nk=1\r\nz=2\r\n', 'CRLF files stay CRLF'); assert(CE.edit('ini', '\uFEFF[A]\nk=1\n', [{ op: 'add', path: 'z', section: 'A', value: '2' }]).text.startsWith('\uFEFF'), 'BOM kept');

    const PR = '#Minecraft server properties\n#Sat Nov 01\nserver-port=25565\nmotd=A Minecraft Server\nrcon.password=\nenable-rcon=false\n';
    const pp = CE.parse('properties', PR);
    eq(pp.entries.map((e) => e.path), ['server-port', 'motd', 'rcon.password', 'enable-rcon'], 'properties parse keeps dotted keys');
    eq(CE.get('properties', PR, 'server-port'), '25565', 'get by key'); eq(CE.get('properties', PR, 'RCON.PASSWORD'), '', 'get is case-insensitive'); eq(CE.get('properties', PR, 'nope'), undefined);
    const p2s = setv('properties', PR, 'enable-rcon', 'true'); eq(lines(p2s).filter((l, i) => l !== lines(PR)[i]), ['enable-rcon=true'], 'properties: one line changed'); assert(p2s.startsWith('#Minecraft server properties\n#Sat Nov 01\n'), 'properties: comments kept');
    assert(CE.edit('properties', PR, [{ op: 'add', path: 'rcon.port', value: '25575' }]).text.endsWith('enable-rcon=false\nrcon.port=25575\n'), 'properties: add appends'); assert.throws(() => CE.edit('properties', PR, [{ op: 'add', path: 'a b', value: '1' }]), /Invalid key/);

    const CF = '// server config\nhostname "My Server"\nrcon_password "s3cr3t"\nsv_cheats 0 // trailing\nmp_autoteambalance\n';
    const pc = CE.parse('cfg', CF);
    eq(pc.entries.map((e) => `${e.key}=${e.value}`), ['hostname="My Server"', 'rcon_password="s3cr3t"', 'sv_cheats=0 // trailing', 'mp_autoteambalance='], 'cfg parse (key value)');
    eq(CE.get('cfg', CF, 'rcon_password'), 's3cr3t', 'get unquotes cfg values'); eq(setv('cfg', CF, 'hostname', '"Other"'), CF.replace('"My Server"', '"Other"'), 'cfg: set keeps the key and the rest of the file');

    const YM = '# top\nserver:\n  port: 8080   # the port\n  name: "My Server"\n  motd: |\n    multi\n    line\nlimits:\n  players: 20\nitems:\n  - a\n  - b\nflag: true\n';
    const py = CE.parse('yaml', YM);
    eq(py.entries.map((e) => `${e.path}=${e.value}`), ['server.port=8080', 'server.name="My Server"', 'limits.players=20', 'flag=true'], 'yaml-simple parse (nested paths, block scalars and lists skipped)');
    const y2 = setv('yaml', YM, 'server.port', '9090'); eq(lines(y2).filter((l, i) => l !== lines(YM)[i]), ['  port: 9090   # the port'], 'yaml: value replaced, trailing comment and indentation kept');
    const y3 = CE.edit('yaml', YM, [{ op: 'add', path: 'limits.spectators', value: '4' }]).text; assert(y3.includes('limits:\n  players: 20\n  spectators: 4\nitems:'), 'yaml: add inside an existing mapping'); assert(CE.edit('yaml', YM, [{ op: 'add', path: 'new.deep.key', value: 'v' }]).text.endsWith('flag: true\nnew:\n  deep:\n    key: v\n'), 'yaml: add creates the missing parents');
    assert(y3.includes('    multi\n    line\n') && y3.includes('  - a\n  - b\n'), 'yaml: block scalars and lists untouched'); assert.strictEqual(CE.parse('yaml', 'a:\n\tb: 1\n').ok, false, 'yaml with tab indentation is raw only');

    const JS = '{\n    "network": { "port": 1, "tags": ["a", "b"] },\n    "name": "x",\n    "on": true\n}\n';
    const pj = CE.parse('json', JS); eq(pj.entries.map((e) => `${e.path}=${e.value}:${e.type}`), ['network.port=1:number', 'network.tags=["a","b"]:json', 'name=x:string', 'on=true:boolean'], 'json parse: flat + nested paths with types');
    const j2 = CE.edit('json', JS, [{ op: 'set', id: ent(pj, 'network.port').id, value: '2' }, { op: 'set', id: ent(pj, 'on').id, value: 'false' }, { op: 'add', path: 'a.b.c', value: '7' }]).text;
    eq(JSON.parse(j2), { network: { port: 2, tags: ['a', 'b'] }, name: 'x', on: false, a: { b: { c: 7 } } }, 'json: typed set + nested add'); assert(j2.startsWith('{\n    "network"') && j2.endsWith('}\n'), 'json: indentation (4) and trailing newline kept');
    eq(JSON.parse(CE.edit('json', JS, [{ op: 'set', id: ent(pj, 'network.tags').id, value: '["z"]' }]).text).network.tags, ['z'], 'json: list value typed as JSON'); assert.strictEqual(JSON.parse(CE.edit('json', JS, [{ op: 'set', id: ent(pj, 'network.port').id, value: 'abc' }]).text).network.port, 'abc', 'json: a non-number typed into a number falls back to text');
    eq(JSON.parse(CE.edit('json', JS, [{ op: 'remove', id: ent(pj, 'name').id }]).text), { network: { port: 1, tags: ['a', 'b'] }, on: true }, 'json: remove'); assert.throws(() => CE.edit('json', JS, [{ op: 'add', path: '__proto__.x', value: '1' }]), /Invalid key path/, 'json: prototype keys refused'); assert.throws(() => CE.edit('json', JS, [{ op: 'add', path: 'name', value: '1' }]), /already exists/);
    for (const [fmt, txt] of [['json', '{ nope'], ['json', '[1,2]'], ['text', 'a'], ['xml', '<a/>'], ['yaml', 'a:\n\tb: 1']]) assert.strictEqual(CE.parse(fmt, txt).ok, false, `${fmt} that cannot be parsed falls back to raw`);
    assert.throws(() => CE.edit('text', 'a', []), /raw/); assert.throws(() => CE.edit('ini', 'a=1', [{ op: 'bogus' }]), /Unknown operation/);
    assert.strictEqual(CE.parse('ini', '').ok && CE.parse('ini', '').entries.length, 0, 'an empty ini file is editable (no entries)'); eq(CE.edit('properties', '', [{ op: 'add', path: 'a', value: '1' }]).text, 'a=1', 'add into an empty file');
    // the editor result is what configWrite stores (existing .bak + event stay)
    const wdir = m.create('mc', 'CfgEdit'); m.writeConfig(wdir.id, 'server-properties', PR); m.writeConfig(wdir.id, 'server-properties', setv('properties', PR, 'enable-rcon', 'true'));
    assert(fs.existsSync(path.join(m.filesDir(wdir.id), 'server.properties.bak')) && m.readConfig(wdir.id, 'server-properties').text.includes('enable-rcon=true'), 'structured save goes through configWrite (.bak kept)'); await m.remove(wdir.id, true);

    // ---- auto-clear rule sanitising (strict) ----
    const AC = S.sanitizeAutoClear;
    eq(AC([{ path: 'logs\\old/', pattern: ' *.log ', olderThanDays: '7', intervalMin: 30 }])[0], { path: 'logs/old', pattern: '*.log', olderThanDays: 7, intervalMin: 30, enabled: true, recursive: false, onlyWhenStopped: false, lastRun: 0 }, 'rule normalised');
    for (const bad of ['../x', 'a/../../x', '/abs', 'C:/Windows', 'C:\\Windows', '', '.', '..', 'a/b:stream', 'a\0b', 'a/*/b', null, 5]) assert.throws(() => AC([{ path: bad }]), /Invalid path/, 'rejected path: ' + JSON.stringify(bad));
    for (const [r, re] of [[{ path: 'a', pattern: 'x/y' }, /file names/], [{ path: 'a', pattern: 'x\\y' }, /file names/], [{ path: 'a', olderThanDays: -1 }, /days/], [{ path: 'a', olderThanDays: 99999 }, /days/], [{ path: 'a', intervalMin: 0 }, /minutes/], [{ path: 'a', intervalMin: 'x' }, /minutes/]]) assert.throws(() => AC([r]), re);
    assert.throws(() => AC(Array.from({ length: 51 }, () => ({ path: 'a' }))), /At most 50/, 'rule count capped'); assert.throws(() => AC('x'), /list/); eq(AC([{ path: 'ok' }, { path: '../bad' }], false).map((r) => r.path), ['ok'], 'non-strict (hand-edited files) drops bad rules');
    assert.throws(() => m.saveConfig('1', { autoClear: [{ path: '../x' }] }), /Invalid path/, 'saveConfig refuses escaping rules');

    // ---- auto-clear service ----
    const acDir = path.join(dir, 'p5-plugin'); fs.mkdirSync(acDir, { recursive: true });
    const pgame = P.toGame({ id: 'p5fake', name: 'P5 Fake', install: { steps: [{ type: 'steamcmd', appId: 4242 }, { type: 'write', path: 'game.exe', content: 'EXE' }] }, run: { exe: 'game.exe', args: [] },
      defaults: { port: '32000', queryPort: '32001', map: 'm', maxPlayers: '4' },
      configs: [{ id: 'props', name: 'server.properties', path: 'server.properties', format: 'properties' }, { id: 'cfg', name: 'server.cfg', path: 'cfg/server.cfg', format: 'cfg' }],
      logs: [{ id: 'lg', name: 'Log', path: 'logs/latest.log' }],
      consoles: [{ id: 'game', name: 'Game console', type: 'process' }, { id: 'rc', name: 'RCON', type: 'rcon', source: 'rcon:{props:rcon.port}:{props:rcon.password}' }, { id: 'rc2', name: 'RCON (setting)', type: 'rcon', source: 'rcon:{port}:{cfg:rcon_password}' }, { id: 'rc3', name: 'RCON (search)', type: 'rcon', source: 'rcon:{rcon.port}:S3cretRcon' }, { id: 'lgc', name: 'Log', type: 'log', source: 'lg' }, { id: 'bad', name: 'Missing key', type: 'rcon', source: 'rcon:25575:{props:no.such.key}' }],
      update: { validateArgs: { steamcmd: 'validate -custom' } },
      files: { autoClear: [{ path: 'logs', pattern: '*.log', olderThanDays: 7, intervalMin: 60, default: true }, { path: 'tmp', pattern: '*', olderThanDays: 0, intervalMin: 5, default: false }] } }, acDir, 'user');
    P.GAMES.push(pgame);
    const a1 = m.create('p5fake', 'AC One').id; let a2;
    const elog5 = new EL5(m, P, m.settings, dir); elog5.start();
    const ac = new AutoClear(m, P, m.settings, dir); ac.start(); assert(m._autoClear === ac, 'registered as mgr._autoClear');
    const acEvents = []; m.events.on('server:autoclear', (p) => acEvents.push(p));
    const fd = (id, rel) => path.join(m.filesDir(id), rel);
    const put = (id, rel, ageDays, data = 'x') => { const f = fd(id, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); const t = new Date(Date.now() - ageDays * 86400000); fs.utimesSync(f, t, t); return f; };
    const T0 = Date.now();

    // seeding from the plugin
    const l1 = ac.list(a1);
    eq(l1.map((r) => [r.path, r.pattern, r.olderThanDays, r.intervalMin, r.enabled, r.fromPlugin]), [['logs', '*.log', 7, 60, true, true], ['tmp', '*', 0, 5, false, true]], 'plugin files.autoClear seeded: default true = enabled, default false = disabled');
    eq(m.getConfig(a1).autoClearSeeded.length, 2, 'seeded keys remembered in wgsm.json'); assert(JSON.parse(fs.readFileSync(m.cfgFile(a1), 'utf8')).autoClear.length === 2, 'rules stored in wgsm.json');
    assert(l1[0].lastRun >= T0 && l1[0].nextRun > T0, 'a seeded rule starts its interval when seeded (no surprise deletion on upgrade)');
    // user edits survive plugin changes; deleted seeded rules do not come back; new plugin rules are added
    ac.save(a1, [{ ...l1[0], olderThanDays: 3, enabled: true }]);
    pgame.autoClear[0].olderThanDays = 30; pgame.autoClear.push({ path: 'crashes', pattern: '*.dmp', olderThanDays: 14, intervalMin: 1440, default: true });
    const l1b = ac.list(a1); eq(l1b.map((r) => [r.path, r.olderThanDays]), [['logs', 3], ['crashes', 14]], 'user edit kept, deleted seeded rule stays deleted, a new plugin rule appears'); pgame.autoClear.pop(); pgame.autoClear[0].olderThanDays = 7;
    ac.save(a1, [{ ...l1b[0] }]); // back to one rule

    // dry run / run / pattern / age / folders untouched
    const old1 = put(a1, 'logs/old.log', 10); const old2 = put(a1, 'logs/old2.log', 8, 'xxxx'); const young = put(a1, 'logs/young.log', 1); const other = put(a1, 'logs/old.txt', 30); const deep = put(a1, 'logs/sub/deep.log', 30);
    const dr = ac.run(a1, 0, true);
    eq([dr.dryRun, dr.matched, dr.deleted, dr.results[0].bytes, dr.results[0].sample.sort()], [true, 2, 0, 5, ['logs/old.log', 'logs/old2.log']], 'dry run reports files and bytes (age 3 d, pattern, non-recursive)'); assert(fs.existsSync(old1) && fs.existsSync(old2), 'dry run deletes nothing');
    const rr = ac.run(a1, 0, false);
    eq([rr.deleted, rr.freed, rr.locked], [2, 5, 0], 'run deletes the old matching files'); assert(!fs.existsSync(old1) && !fs.existsSync(old2) && fs.existsSync(young) && fs.existsSync(other) && fs.existsSync(deep) && fs.existsSync(fd(a1, 'logs/sub')), 'young file, other pattern, sub-folder content and folders are kept');
    assert(ac.list(a1)[0].lastRun >= T0, 'lastRun persisted'); const ev = elog5.query({ event: 'autoclear:run' }); assert(ev.length >= 1 && /2 files deleted from logs/.test(ev[0].message) && ev[0].serverId === a1, 'run logged to the NGSM event log'); assert(acEvents.length === 1 && acEvents[0].detail.deleted === 2 && acEvents[0].id === a1, 'server:autoclear event emitted');
    ac.save(a1, [{ ...ac.list(a1)[0], recursive: true }]); eq(ac.run(a1, 0, true).matched, 1, 'recursive rule reaches sub-folders'); assert.throws(() => ac.run(a1, 5), /Rule not found/); assert.throws(() => ac.run('99', 0), /Server not found/);

    // interval + scheduler
    ac.save(a1, [{ path: 'logs', pattern: '*.log', olderThanDays: 3, intervalMin: 60, enabled: true, recursive: false, onlyWhenStopped: false, lastRun: 0 }]);
    const t1 = Date.now(); put(a1, 'logs/t1.log', 20); put(a1, 'logs/t2.log', 20);
    eq(ac.tick(t1 + 30 * 60000).length, 0, 'not due before intervalMin (counted from the last run / seeding)'); const ticks = ac.tick(t1 + 61 * 60000); eq([ticks.length, ticks[0].result.deleted], [1, 2], 'the scheduler runs a due rule');
    put(a1, 'logs/t3.log', 20);
    eq(ac.tick(t1 + 122 * 60000).map((x) => x.result.deleted), [1], 'due again after the interval'); put(a1, 'logs/t4.log', 20); eq(ac.tick(t1 + 123 * 60000).length, 0, 'interval counted from the last run');
    // lastRun persists across service instances (restart of the app)
    const ac2 = new AutoClear(m, P, m.settings, dir); eq(ac2.tick(t1 + 124 * 60000).length, 0, 'a new service instance honours the persisted lastRun'); m._autoClear = ac;
    // disabled, only-when-stopped, busy
    ac.save(a1, [{ ...ac.list(a1)[0], enabled: false, lastRun: 0 }]); eq(ac.tick(t1 + 999 * 60000).length, 0, 'disabled rule never runs by itself'); eq(ac.run(a1).deleted, 0, 'run without an index only runs enabled rules');
    eq(ac.run(a1, 0).deleted, 1, 'an explicit Run now works on a disabled rule (t4.log)');
    put(a1, 'logs/t5.log', 20); ac.save(a1, [{ ...ac.list(a1)[0], enabled: true, onlyWhenStopped: true, lastRun: 0 }]);
    const realRunning = m.isRunning; const mine = (r) => r.filter((x) => x.id === a1); m.isRunning = () => true; eq(mine(ac.tick(t1 + 2000 * 60000)).length, 0, 'onlyWhenStopped waits while the server runs'); m.isRunning = realRunning;
    const rtA = m.rt(a1); rtA.busy = 'Updating'; eq(mine(ac.tick(t1 + 2000 * 60000)).length, 0, 'busy servers (install / update / backup) are skipped'); rtA.busy = null;
    eq(mine(ac.tick(t1 + 2000 * 60000)).length, 1, 'runs once the server is stopped and idle'); assert(!fs.existsSync(fd(a1, 'logs/t5.log')));
    // per-server isolation
    a2 = m.create('p5fake', 'AC Two').id; put(a2, 'logs/x.log', 40); eq(ac.list(a2).length, 2, 'second server seeded separately'); assert(fs.existsSync(fd(a2, 'logs/x.log')), 'other servers are not touched by a run on this one');

    // path escape, links and hand-edited rules
    const outside = path.join(dir, 'p5-outside'); fs.mkdirSync(outside, { recursive: true }); fs.writeFileSync(path.join(outside, 'secret.log'), 's'); const oldT = new Date(Date.now() - 90 * 86400000); fs.utimesSync(path.join(outside, 'secret.log'), oldT, oldT);
    const cfgRaw = JSON.parse(fs.readFileSync(m.cfgFile(a1), 'utf8')); cfgRaw.autoClear = [{ path: '../p5-outside', pattern: '*' }, { path: 'a/../../p5-outside', pattern: '*' }, { path: path.dirname(outside), pattern: '*' }, { path: 'C:/Windows', pattern: '*' }]; fs.writeFileSync(m.cfgFile(a1), JSON.stringify(cfgRaw));
    eq(ac.list(a1).length, 0, 'hand-edited rules that escape the folder are dropped on read'); eq(ac.run(a1).deleted, 0); eq(mine(ac.tick(Date.now() + 1e10)).length, 0); assert(fs.existsSync(path.join(outside, 'secret.log')), 'files outside the server folder are never deleted');
    let linked = true; try { fs.symlinkSync(outside, fd(a1, 'logs/link'), 'junction'); } catch { linked = false; }
    ac.save(a1, [{ path: 'logs', pattern: '*', olderThanDays: 0, recursive: true, intervalMin: 5 }, ...(linked ? [{ path: 'logs/link', pattern: '*', intervalMin: 5 }] : [])]);
    if (linked) { const rl = ac.run(a1, undefined, false); assert(fs.existsSync(path.join(outside, 'secret.log')), 'a link inside the server folder is not followed (recursive rule)'); { const lr = ac.run(a1, 1, true).results[0]; assert(lr.errors.length === 1 && /link/.test(lr.errors[0]), 'a rule whose folder is a link reports it and matches nothing'); } }
    eq(ac.run(a1, 0, true).results[0].exists, true); eq(ac.save(a1, [{ path: 'no/such/folder' }]).length, 1); eq(ac.run(a1, 0).results[0].exists, false, 'a missing folder is not an error');
    const ipc = buildApi({ mgr: m, collector: {}, shell: {}, dialog: {}, app: {}, nativeTheme: {}, getWin: () => null, currentBg: () => '', autoClear: ac });
    eq(ipc.autoClearList(a1).length, 1, 'autoClearList IPC'); assert.throws(() => ipc.autoClearSave(a1, [{ path: '../x' }]), /Invalid path/, 'autoClearSave IPC validates'); eq(ipc.autoClearRun(a1, 0, true).dryRun, true, 'autoClearRun IPC (dry run)');
    ac.stop(); await m.remove(a2, true);

    // ---- RCON client against a local fake server (never anything else) ----
    const fakeRcon = (mode) => new Promise((resolve) => {
      const seen = []; const socks = new Set();
      const srv = net.createServer((sock) => {
        socks.add(sock); let buf = Buffer.alloc(0);
        sock.on('close', () => socks.delete(sock)); sock.on('error', () => {});
        sock.on('data', (d) => {
          buf = Buffer.concat([buf, d]);
          while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
            const size = buf.readInt32LE(0); const id = buf.readInt32LE(4); const type = buf.readInt32LE(8); const body = buf.slice(12, 4 + size - 2).toString(); buf = buf.slice(4 + size);
            seen.push({ id, type, body });
            if (mode === 'silent') continue;
            if (type === 3) { if (mode !== 'minecraft') sock.write(packet(id, 0, '')); sock.write(packet(body === 'S3cretRcon' ? id : -1, 2, '')); }
            else if (type === 2) {
              if (body === 'echo hi') sock.write(packet(id, 0, 'hi there'));
              else if (body === 'big') { sock.write(packet(id, 0, 'A'.repeat(4000))); sock.write(packet(id, 0, 'B'.repeat(10))); }
              else if (body === 'tps') sock.write(packet(id, 0, 'TPS from last 1m, 5m, 15m: ' + String.fromCharCode(167) + 'a*19.5' + String.fromCharCode(167) + 'r, 20.0, 20.0'));
              else if (body === 'drop') { sock.destroy(); }
              else sock.write(packet(id, 0, `unknown: ${body}`));
            } else if (type === 0) { if (mode === 'minecraft') sock.write(packet(id, 0, 'Unknown request 0')); else if (mode !== 'nomarker') { sock.write(packet(id, 0, '')); sock.write(packet(id, 0, '\x00\x01\x00\x00')); } }
          }
        });
      });
      srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, seen, close: () => { for (const s of socks) s.destroy(); srv.close(); } }));
    });
    const fr = await fakeRcon('source'); const R5 = (o) => new RconClient({ host: '127.0.0.1', port: fr.port, password: 'S3cretRcon', connectTimeoutMs: 1500, commandTimeoutMs: 2500, idleMs: 50, ...o });
    const rc = R5({}); await rc.connect(); assert(rc.connected, 'auth ok');
    eq(await rc.send('echo hi'), 'hi there', 'command response'); eq(await rc.send('other'), 'unknown: other', 'second command on the same connection');
    const big = await rc.send('big'); eq([big.length, big.startsWith('AAAA'), big.endsWith('BBBBBBBBBB')], [4010, true, true], 'multi-packet response joined');
    eq(await Promise.all([rc.send('echo hi'), rc.send('other'), rc.send('echo hi')]), ['hi there', 'unknown: other', 'hi there'], 'concurrent sends are queued (tick polling and the console share one connection)');
    const bad = R5({ password: 'wrong-pw-123' }); await assert.rejects(bad.connect(), (e) => /authentication failed/.test(e.message) && !/wrong-pw-123/.test(e.message), 'wrong password rejected, password not in the error'); assert(!bad.connected);
    assert(!/S3cretRcon/.test(util.inspect(rc)) && !/S3cretRcon/.test(JSON.stringify(rc)) && !/S3cretRcon/.test(String(rc)), 'the password never shows in inspect / JSON / toString');
    await assert.rejects(rc.send('x'.repeat(4097)), /too long/, 'payload over 4096 bytes refused locally'); await assert.rejects(rc.send('é'.repeat(2049)), /too long/, 'limit counts bytes, not characters'); eq(await rc.send('echo hi'), 'hi there', 'still usable after a refused command');
    assert(fr.seen.every((p) => p.body.length <= 4096), 'nothing larger than 4096 bytes was ever sent');
    await assert.rejects(rc.send('drop'), /closed|timed out|failed/, 'server drops the connection mid-command'); eq(await rc.send('echo hi'), 'hi there', 'reconnects on demand after a dropped connection (re-authenticates)');
    assert.throws(() => new RconClient({ port: 0, password: 'x' }), /port/); assert.throws(() => new RconClient({ port: 70000, password: 'x' }), /port/);
    rc.close(); fr.close();
    const frm = await fakeRcon('minecraft'); const mc5 = new RconClient({ host: '127.0.0.1', port: frm.port, password: 'S3cretRcon', idleMs: 50 }); eq(await mc5.send('echo hi'), 'hi there', 'Minecraft style (no empty packet before the auth reply, marker answered with "Unknown request 0")'); mc5.close(); frm.close();
    const frn = await fakeRcon('nomarker'); const nm5 = new RconClient({ host: '127.0.0.1', port: frn.port, password: 'S3cretRcon', idleMs: 50 }); eq(await nm5.send('echo hi'), 'hi there', 'server that never answers the end marker: idle fallback ends the response'); nm5.close(); frn.close();
    const frs = await fakeRcon('silent'); const sl = new RconClient({ host: '127.0.0.1', port: frs.port, password: 'S3cretRcon', connectTimeoutMs: 300, commandTimeoutMs: 300 }); const tt = Date.now(); await assert.rejects(sl.connect(), /timed out/, 'a server that never answers times out'); assert(Date.now() - tt < 2000); sl.close(); frs.close();
    await assert.rejects(new RconClient({ host: '127.0.0.1', port: 1, password: 'x', connectTimeoutMs: 500 }).connect(), /failed|timed out/, 'refused connection reports a clean error');

    // ---- consoles: source format, IPC, rcon / log / main routing ----
    eq(parseRconSource('rcon:25575:pw:with:colons'), { port: '25575', password: 'pw:with:colons' }, 'source: literal port, password may contain ":"'); eq(parseRconSource('rcon:{props:rcon.port}:{props:rcon.password}'), { port: '{props:rcon.port}', password: '{props:rcon.password}' });
    for (const badSrc of ['', 'tcp:1:2', 'rcon:', 'rcon:abc:pw', 'rcon:123456789:pw']) assert.throws(() => parseRconSource(badSrc), /Invalid RCON source/, 'bad source: ' + badSrc);
    assert(P.validate({ id: 'rcbad', name: 'N', install: { type: 'manual' }, run: { exe: 'a.exe' }, consoles: [{ id: 'r', name: 'R', type: 'rcon', source: 'just-a-string' }] }, null).errors.some((x) => /rcon:<port>/.test(x)), 'plugin validation rejects a malformed rcon source'); assert(P.validate({ id: 'rcbad', name: 'N', install: { type: 'manual' }, run: { exe: 'a.exe' }, consoles: [{ id: 'main', name: 'R', type: 'rcon', source: 'rcon:1:x' }] }, null).errors.some((x) => /reserved/.test(x)), 'console id "main" is reserved');
    const cs = new Consoles(m, P, m.settings, dir); cs.start(); assert(m._consoles === cs);
    const c1 = m.create('p5fake', 'Con One').id; const fr2 = await fakeRcon('source');
    m.writeConfig(c1, 'props', `rcon.port=${fr2.port}\nrcon.password=S3cretRcon\n`); m.writeConfig(c1, 'cfg', 'rcon_password "S3cretRcon"\n'); m.saveConfig(c1, { port: String(fr2.port) });
    const api5 = buildApi({ mgr: m, collector: {}, shell: {}, dialog: {}, app: {}, nativeTheme: {}, getWin: () => null, currentBg: () => '', consoles: cs, autoClear: ac });
    eq(api5.consolesList(c1).map((c) => [c.id, c.type, c.readOnly]), [['main', 'process', false], ['rc', 'rcon', false], ['rc2', 'rcon', false], ['rc3', 'rcon', false], ['lgc', 'log', true], ['bad', 'rcon', false]], 'consolesList: game console first, then the declared ones');
    assert(!JSON.stringify(api5.consolesList(c1)).includes('S3cretRcon') && !JSON.stringify(api5.consolesList(c1)).includes('source'), 'consolesList never exposes sources / passwords');
    const cg1 = m.create('csgo', 'plain').id; const cg2 = m.create('hl2dm', 'nocon').id; eq(api5.consolesList(cg1).length, 3, 'a game with consoles[] lists them'); eq(api5.consolesList(cg2).map((c) => c.id), ['main'], 'a game without consoles[] only has the game console (UI unchanged)'); await m.remove(cg1, true); await m.remove(cg2, true);
    const outs = []; m.on('consoleOut', (o) => outs.push(o));
    await assert.rejects(api5.consoleCommand(c1, 'rc', 'echo hi'), /not running/, 'rcon needs a running server');
    const sent = []; const rt1 = m.rt(c1); rt1.proc = { pid: 1, stdin: { writable: true, write: (t) => sent.push(t) } }; rt1.status = 'Started';
    eq(await api5.consoleCommand(c1, 'main', 'say hello'), { output: '' }, 'main console command goes to stdin'); eq(sent, ['say hello\n']); eq(await api5.consoleCommand(c1, undefined, 'x'), { output: '' }, 'no console id = main (old API shape)');
    eq((await api5.consoleCommand(c1, 'rc', 'echo hi')).output, 'hi there', 'rcon command via {config:key} source'); assert(outs.some((o) => o.consoleId === 'rc' && o.id === c1 && o.lines[0] === '> echo hi' && o.lines[1] === 'hi there'), 'rcon output pushed as consoleOut with consoleId');
    eq((await api5.consoleCommand(c1, 'rc2', 'echo hi')).output, 'hi there', 'rcon command via {setting} + {config:key} source');
    eq((await api5.consoleCommand(c1, 'rc3', 'echo hi')).output, 'hi there', 'rcon command via a bare {key} (searched in the config files) and a literal password');
    await assert.rejects(api5.consoleCommand(c1, 'bad', 'x'), (e) => /no\.such\.key/.test(e.message) && !/S3cretRcon/.test(e.message), 'missing key: message names the key, not any S3cretRcon');
    await assert.rejects(api5.consoleCommand(c1, 'lgc', 'x'), /read-only/, 'log consoles are read-only'); await assert.rejects(api5.consoleCommand(c1, 'nope', 'x'), /Unknown console/); await assert.rejects(api5.consoleCommand(c1, 'rc', '   '), /Empty/); await assert.rejects(api5.consoleCommand(c1, 'rc', 'x'.repeat(5000)), /too long/);
    eq(fr2.seen.filter((p) => p.type === 3).length, 3, 'one RCON connection is reused per console (rc, rc2, rc3) - reconnect only on demand');
    m.writeConfig(c1, 'props', `rcon.port=${fr2.port}\nrcon.password=changed\n`); await assert.rejects(api5.consoleCommand(c1, 'rc', 'echo hi'), /authentication failed/, 'a changed password is picked up (reconnects with the new one)'); m.writeConfig(c1, 'props', `rcon.port=${fr2.port}\nrcon.password=S3cretRcon\n`);
    eq((await api5.consoleCommand(c1, 'rc', 'echo hi')).output, 'hi there', 'recovers after the password is fixed');
    assert(!JSON.stringify(elog5.query({ limit: 1000 })).includes('S3cretRcon') && !JSON.stringify(outs).includes('S3cretRcon'), 'the RCON password is not in the event log or console output');
    assert(elog5.query({ event: 'server:command' }).some((e) => /echo hi/.test(e.message)), 'rcon commands are logged like console commands');
    // log console: lines stream as consoleOut with the console id
    fs.mkdirSync(path.dirname(fd(c1, 'logs/latest.log')), { recursive: true }); fs.writeFileSync(fd(c1, 'logs/latest.log'), 'l1\nl2\n');
    const st = api5.consoleStart(c1, 'lgc'); eq(st.lines, ['l1', 'l2'], 'log console returns the initial lines'); outs.length = 0; fs.appendFileSync(fd(c1, 'logs/latest.log'), 'l3\n'); await sleep(1500);
    eq(outs.filter((o) => o.consoleId === 'lgc').flatMap((o) => o.lines), ['l3'], 'log console streams new lines with consoleId'); api5.consoleStop(c1, 'lgc'); outs.length = 0; fs.appendFileSync(fd(c1, 'logs/latest.log'), 'l4\n'); await sleep(1300); eq(outs.length, 0, 'stopped log console is silent'); assert.throws(() => api5.consoleStart(c1, 'rc'), /Not a log console/);
    // ---- Phase 7: server tick metric (rcon source, latency fallback, header aggregate) ----
    {
      const TK = require('../src/renderer/tick'); const dgram5 = require('dgram'); const Q = require('../src/main/query');
      // fake A2S server (answers the info request after 40 ms so the round trip is measurable)
      const a2sFake = await new Promise((resolve) => {
        const s = dgram5.createSocket('udp4');
        s.on('message', (msg, rinfo) => {
          const info = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]), Buffer.from('Fake\0map1\0folder\0game\0'), Buffer.from([0, 0, 3, 8, 0, 100, 0x6c, 0x77, 0, 0])]);
          setTimeout(() => { try { s.send(info, rinfo.port, rinfo.address); } catch { /* closed */ } }, 40);
        });
        s.bind(0, '127.0.0.1', () => resolve({ port: s.address().port, close: () => s.close() }));
      });
      const qa = await Q.query('a2s', '127.0.0.1', a2sFake.port, 1500);
      assert(qa && qa.players === 3 && qa.maxPlayers === 8 && qa.ping >= 30 && qa.ping < 1000, 'a2s query reports its round trip (ms): ' + JSON.stringify(qa));
      // latency fallback: the game has no tick metric -> metric "latency" (ms), labelled Latency, never "tick"
      pgame.query = 'a2s'; pgame.metrics = [];
      m.saveConfig(c1, { queryPort: String(a2sFake.port), ip: '' });
      await m.pollAll(); assert(m.rt(c1).latency && m.rt(c1).latency.ms >= 30, 'pollAll stores the query round trip');
      const col7 = new MetricsCollector(m, { intervalMs: 1e9, readProcs: async () => [] });
      let sn7 = await col7.tick(); let row7 = sn7.servers.find((r) => r.id === c1);
      assert(row7.metrics.latency && row7.metrics.latency.unit === 'ms' && row7.metrics.latency.kind === 'latency' && row7.metrics.latency.value === m.rt(c1).latency.ms, 'latency exposed as metric id "latency" (ms)');
      assert(row7.tick === null && sn7.defs.some((d) => d.id === 'latency' && d.name === 'Latency' && d.unit === 'ms'), 'latency is not a tick (row.tick stays empty) and has its own column definition');
      eq(TK.aggregateTick(sn7.servers).text, 'n/a', 'header tick stat is n/a when no running server has a tick metric'); assert(col7.history[col7.history.length - 1].s[c1].l === row7.metrics.latency.value, 'history carries latency');
      m.rt(c1).latency.t -= 120000; sn7 = await col7.tick(); assert(!sn7.servers.find((r) => r.id === c1).metrics.latency, 'a stale latency sample is dropped');
      // tick metric through RCON (silent: not in the console output or the event log), first matching line wins
      const tickDef = { id: 'tps', name: 'Server TPS', unit: 'TPS', kind: 'tick', source: 'rcon:tps', pattern: 'TPS from last[^:]*: *[^0-9]*([0-9.]+)', tickTarget: 20, warnBelow: 18, badBelow: 15, rconConsole: 'rc' };
      pgame.metrics = [tickDef]; outs.length = 0; const seen0 = fr2.seen.length;
      assert(await col7.pollRcon(c1, tickDef), 'rcon poll found a value'); assert(fr2.seen.slice(seen0).some((p) => p.type === 2 && p.body === 'tps'), 'the command went through RCON');
      sn7 = await col7.tick(); row7 = sn7.servers.find((r) => r.id === c1);
      assert(row7.metrics['m:tps'].value === 19.5 && row7.metrics['m:tps'].cls === 'good' && row7.tick.value === 19.5 && row7.tick.id === 'm:tps' && !row7.metrics.latency, 'rcon tick metric (section colour codes stripped), classified, no latency now');
      eq(TK.aggregateTick(sn7.servers).text, '19.5 TPS', 'header tick stat shows the tick value');
      assert(outs.length === 0 && !elog5.query({ limit: 1000 }).some((e) => /tps/.test(e.message)), 'tick polling does not write to the console output or the NGSM log');
      const inline = { ...tickDef, id: 'tps2', rconConsole: undefined, rconSource: 'rcon:' + fr2.port + ':S3cretRcon' }; pgame.metrics = [tickDef, inline];
      assert(await col7.pollRcon(c1, inline) && col7.custom.get(c1 + ':tps2').value === 19.5, 'inline rcon:<port>:<password> source works without a console');
      m.writeConfig(c1, 'props', 'rcon.port=' + fr2.port + '\nrcon.password=changed\n'); col7.custom.clear();
      eq(await col7.pollRcon(c1, tickDef), false, 'a failing RCON poll just yields no value'); const perr = col7.pollErrors.get(c1 + ':tps');
      assert(/authentication failed/.test(perr) && !/S3cretRcon|changed/.test(perr), 'poll error names the problem, not the password: ' + perr); m.writeConfig(c1, 'props', 'rcon.port=' + fr2.port + '\nrcon.password=S3cretRcon\n');
      eq(await col7.pollRcon(c1, tickDef), true, 'recovers once the password is right'); assert(!col7.pollErrors.has(c1 + ':tps'));
      // timers start with the server and stop with it
      col7.syncSources({ id: c1, status: 'Started' }); assert(col7.cmdTimers.has(c1 + ':tps') && col7.cmdTimers.has(c1 + ':tps2'), 'rcon metrics get a poll timer'); col7.syncSources({ id: c1, status: 'Stopped' }); assert(col7.cmdTimers.size === 0 && !col7.custom.has(c1 + ':tps'), 'timers and values dropped when the server stops');
      eq(await col7.pollRcon(c1, { ...tickDef, rconConsole: 'nope' }), false, 'unknown rcon console: no value, no crash');
      col7.stop(); pgame.metrics = []; pgame.query = null; a2sFake.close();
      // pure helpers
      const SS = String.fromCharCode(167); const ESC = String.fromCharCode(27);
      eq([TK.parseTickNumber('TPS: ' + SS + 'a*20.0'), TK.parseTickNumber(ESC + '[32m19.8' + ESC + '[0m'), TK.parseTickNumber('1,234.5 ms'), TK.parseTickNumber('20,0'), TK.parseTickNumber('12.3ms'), TK.parseTickNumber('1.234.567'), TK.parseTickNumber('no number'), TK.parseTickNumber('')].map((x) => (Number.isNaN(x) ? 'NaN' : x)), [20, 19.8, 1234.5, 20, 12.3, 1234567, 'NaN', 'NaN'], 'tick number parsing: colour codes, ANSI, commas, units');
      eq(TK.stripColours(String.fromCharCode(194, 167) + 'a20' + SS + 'r'), '20', 'mis-decoded section sign stripped too');
      eq([TK.classify(14, tickDef), TK.classify(17, tickDef), TK.classify(19.9, tickDef)], ['bad', 'warn', 'good'], 'thresholds: higher is better');
      eq([TK.classify(30, { higherIsBetter: false, warnAbove: 40, badAbove: 50 }), TK.classify(45, { higherIsBetter: false, warnAbove: 40, badAbove: 50 }), TK.classify(60, { higherIsBetter: false, warnAbove: 40, badAbove: 50 })], ['good', 'warn', 'bad'], 'thresholds: lower is better');
      eq([TK.classify(20, { tickTarget: 20 }), TK.classify(17, { tickTarget: 20 }), TK.classify(10, { tickTarget: 20 }), TK.classify(5, {}), TK.classify(null, tickDef), TK.classify(NaN, tickDef)], ['good', 'warn', 'bad', '', '', ''], 'tickTarget defaults (90% / 75%); no thresholds = no colour');
      eq([TK.classify(40, { higherIsBetter: false, tickTarget: 50 }), TK.classify(60, { higherIsBetter: false, tickTarget: 50 }), TK.classify(120, { higherIsBetter: false, tickTarget: 50 })], ['good', 'warn', 'bad'], 'tickTarget defaults for times');
      const rowsA = [{ name: 'A', pid: 1, tick: { value: 19, unit: 'TPS', cls: 'warn', name: 'TPS' } }, { name: 'B', pid: 2, tick: { value: 20, unit: 'TPS', cls: 'good', name: 'TPS' } }, { name: 'C', pid: 0, status: 'Stopped', tick: { value: 5, unit: 'TPS', cls: 'bad' } }, { name: 'D', pid: 3, tick: null }];
      let ag = TK.aggregateTick(rowsA); eq([ag.text, ag.cls, ag.count], ['19 TPS min', 'warn', 2], 'header aggregate: worst (min) of the running servers with a tick metric; stopped / no-tick ones ignored'); assert(/A: 19 TPS/.test(ag.title) && /B: 20 TPS/.test(ag.title) && !/C:/.test(ag.title), 'tooltip lists the server names');
      eq(TK.aggregateTick(rowsA, 'avg').text, '19.5 TPS avg', 'avg mode'); eq(TK.aggregateTick([{ name: 'S', pid: 1, tick: { value: 20, unit: 'TPS', cls: 'good' } }]).text, '20 TPS', 'single server: no min suffix');
      ag = TK.aggregateTick([{ name: 'M', pid: 1, tick: { value: 30, unit: 'ms', higherIsBetter: false, cls: 'good' } }, { name: 'N', pid: 2, tick: { value: 55, unit: 'ms', higherIsBetter: false, cls: 'bad' } }]); eq([ag.text, ag.cls], ['55 ms max', 'bad'], 'lower-is-better metrics: the worst is the max');
      eq(TK.aggregateTick([]).text, 'n/a'); eq(TK.aggregateTick(undefined).text, 'n/a');
      // plugin validation of the new fields
      const tb = { ...mbase, consoles: [{ id: 'rc', name: 'R', type: 'rcon', source: 'rcon:25575:pw' }] }; const te = (x) => P.validate({ ...tb, metrics: [{ id: 't', name: 'T', pattern: '([0-9.]+)', source: 'console', command: 'tps', ...x }] }, null);
      eq(te({ kind: 'tick', tickTarget: 20, higherIsBetter: true, warnBelow: 18, badBelow: 15, patternFlags: 'i' }).errors, [], 'valid tick metric'); eq(te({ kind: 'tick', source: 'rcon:tps', command: undefined, higherIsBetter: false, warnAbove: 40, badAbove: 50 }).errors, [], 'valid rcon tick metric (uses the first rcon console)');
      eq(te({ kind: 'tick', source: 'rcon:tps', rconConsole: 'rc' }).errors, []); eq(te({ kind: 'tick', source: 'rcon:tps', rconSource: 'rcon:{port}:{cfg:pw}' }).errors, []);
      for (const [bad, re] of [[{ kind: 'fps' }, /kind/], [{ kind: 'tick', tickTarget: 0 }, /tickTarget/], [{ kind: 'tick', tickTarget: 'x' }, /tickTarget/], [{ kind: 'tick', higherIsBetter: 'yes' }, /higherIsBetter/], [{ kind: 'tick', warnBelow: 'a' }, /warnBelow/], [{ kind: 'tick', warnBelow: 10, badBelow: 15 }, /badBelow/], [{ kind: 'tick', higherIsBetter: false, warnAbove: 50, badAbove: 40 }, /badAbove/], [{ tickTarget: 20 }, /only applies/], [{ patternFlags: 'zz' }, /patternFlags/], [{ source: 'rcon:' }, /needs a command/], [{ source: 'rcon:tps', rconConsole: 'zz' }, /rconConsole/], [{ source: 'rcon:tps', rconSource: 'nope' }, /rconSource/], [{ source: 'rcon:' + 'x'.repeat(5000) }, /too long/]]) assert(te(bad).errors.some((x) => re.test(x)), 'rejected: ' + JSON.stringify(bad) + ' -> ' + te(bad).errors);
      assert(P.validate({ ...mbase, metrics: [{ id: 't', name: 'T', pattern: '([0-9.]+)', source: 'rcon:tps' }] }, null).errors.some((x) => /needs a console of type "rcon"/.test(x)), 'rcon source without any rcon console is rejected'); assert(te({ kind: 'tick', warnAbove: 4 }).warnings.some((x) => /warnAbove/.test(x)), 'warning: wrong-direction thresholds');
      eq(S.sanitize({ dashboardChart: 'tick' }), { dashboardChart: 'tick' }, 'tick chart accepted'); eq(S.sanitize({ dashboardChart: 'latency' }), { dashboardChart: 'latency' });
      for (const id of ['mc', 'csgo', 'rust']) assert(P.byId(id).metrics.some((x) => x.kind === 'tick'), 'bundled ' + id + ' declares a tick metric'); assert(P.byId('mc').metrics.some((x) => x.id === 'mspt' && x.higherIsBetter === false && /^rcon:/.test(x.source)), 'mc: vanilla /tick query metric in ms');
      const html7 = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8'); assert(html7.includes('<script src="tick.js"></script>') && html7.indexOf('tick.js') < html7.indexOf('app.js') && html7.includes('value="tick"') && html7.includes('value="latency"'), 'tick.js loaded before app.js; chart options');
    }
    // removing a server closes its connections
    rt1.proc = null; rt1.status = 'Stopped'; cs.stop(); fr2.close(); await m.remove(c1, true);

    // ---- update vs validate ----
    eq(SteamCMD.validateTokens(undefined), ['validate'], 'default validate args'); eq(SteamCMD.validateTokens('validate -x1'), ['validate', '-x1'], 'plugin validate args'); eq(SteamCMD.validateTokens('validate +quit'), ['validate'], 'steamcmd +commands refused'); eq(SteamCMD.validateTokens('a;b'), ['validate'], 'odd characters refused');
    eq(m.steam.buildArgs('D:/x', '1', { validate: true, validateArgs: 'validate -custom' }), ['+force_install_dir', 'D:/x', '+login', 'anonymous', '+app_update', '1', 'validate', '-custom', '+quit'], 'steamcmd args: validateArgs applied');
    eq(m.steam.buildArgs('D:/x', '1', { validate: false, validateArgs: 'validate -custom' }), ['+force_install_dir', 'D:/x', '+login', 'anonymous', '+app_update', '1', '+quit'], 'Update (no validate) ignores validateArgs');
    const u1 = m.create('p5fake', 'Upd').id; const calls = []; const realInstall = m.steam.install; m.steam.install = async (d, appId, o) => { calls.push({ appId: String(appId), validate: o.validate, validateArgs: o.validateArgs }); return 0; };
    const seenSt = []; const onSt = (v) => seenSt.push([v.id, v.status, v.pending]); m.on('status', onSt); const updEv = []; m.events.on('server:updated', (p) => updEv.push(p.detail));
    await m.update(u1, false); await m.update(u1, true);
    eq(calls, [{ appId: '4242', validate: false, validateArgs: 'validate -custom' }, { appId: '4242', validate: true, validateArgs: 'validate -custom' }], 'update(id, false) = no validate, update(id, true) = validate with the plugin validateArgs');
    assert(seenSt.some((x) => x[1] === 'Updating' && x[2] === 'Updating') && seenSt.some((x) => x[1] === 'Validating' && x[2] === 'Validating'), 'busy / status text tells Update and Validate apart'); eq(updEv.map((d) => d.validate), [false, true], 'server:updated carries the validate flag'); eq(m.view(u1).status, 'Stopped');
    calls.length = 0; const br = await m.bulk('validate', [u1]); eq([br[0].ok, calls.length, calls[0].validate], [true, 1, true], 'bulk validate'); await assert.rejects(m.bulk('nope', [u1]), /Unknown action/); const ba = await m.bulk('update', [u1]); eq([ba[0].ok, calls[1].validate], [true, false], 'bulk update stays a plain update');
    const apiU = buildApi({ mgr: m, collector: {}, shell: {}, dialog: {}, app: {}, nativeTheme: {}, getWin: () => null, currentBg: () => '' }); calls.length = 0; await apiU.update(u1, true); eq(calls[0].validate, true, 'IPC update(id, validate)');
    m.off('status', onSt); m.steam.install = realInstall; await m.remove(u1, true);
    for (const sid of [a1]) await m.remove(sid, true);
    elog5.stop(); P.GAMES.splice(P.GAMES.indexOf(pgame), 1);
    // bundled plugins that ship consoles / auto-clear
    const mcg = P.byId('mc'); assert(mcg.consoles.some((x) => x.type === 'rcon' && /^rcon:/.test(x.source)) && mcg.consoles.some((x) => x.type === 'log' && mcg.logs.some((l) => l.id === x.source)) && mcg.autoClear.length >= 1, 'bundled mc declares consoles (rcon + latest.log) and files.autoClear'); assert(P.byId('csgo').consoles.some((x) => x.type === 'rcon'), 'bundled csgo declares an rcon console');
    const html5 = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
    for (const id of ['vConfigs', 'cfServer', 'cfBody', 'dlgAutoClear', 'acForm', 'acPath', 'acPattern', 'acDays', 'acEvery', 'tbValidate']) assert(html5.includes('id="' + id + '"'), 'element #' + id); assert(html5.includes('data-view="configs"'), 'nav entry Configs');
    for (const f of ['consolesView.js', 'configsView.js', 'autoClearView.js']) assert(html5.includes(`<script src="${f}">`) && fs.existsSync(path.join(__dirname, '..', 'src', 'renderer', f)), 'script ' + f);
  }

  // ---- Phase 6: Discord bot (slash commands). No network, no real discord.js login ----
  {
    const DC = require('../src/main/services/discordCommands');
    const { DiscordBot, buildCommands } = require('../src/main/services/discordBot');
    const { EventEmitter } = require('events');
    const { buildApi: buildApi6 } = require('../src/main/api');
    const S6 = require('../src/main/settings');
    const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDe.abcdefghijklmnopqrstuvwxyz0';

    // registration payload
    const reg = DC.registrationJson();
    eq(reg.map((c) => c.name), ['check', 'list', 'start', 'stop', 'restart', 'update', 'send', 'backup', 'stats'], 'command set');
    for (const c of reg) {
      assert(/^[a-z0-9_-]{1,32}$/.test(c.name) && c.name === c.name.toLowerCase(), 'command name rules: ' + c.name); assert(c.description.length >= 1 && c.description.length <= 100, 'description <= 100: ' + c.name);
      assert((c.options || []).length <= 25 && !('mutating' in c), 'payload has no internal flags');
      let seenOptional = false;
      for (const o of c.options || []) { assert(/^[a-z0-9_-]{1,32}$/.test(o.name) && o.description.length <= 100 && [3, 5].includes(o.type), 'option ' + c.name + '.' + o.name); assert(!(seenOptional && o.required), 'required options come first'); if (!o.required) seenOptional = true; }
    }
    assert(JSON.stringify(reg).length < 8000, 'payload is small');
    eq(reg.find((c) => c.name === 'send').options.find((o) => o.name === 'command').max_length, 500, '/send length cap in the payload'); assert(reg.filter((c) => c.options).every((c) => c.options[0].name === 'serverid' && c.options[0].autocomplete), 'serverid autocompletes');
    eq(reg.find((c) => c.name === 'update').options.map((o) => [o.name, o.type, !!o.required]), [['serverid', 3, true], ['validate', 5, false]], '/update [validate:boolean]');
    const D6 = require('discord.js'); const built = buildCommands(D6).map((b) => b.toJSON());
    const shape = (c) => [c.name, c.description, (c.options || []).map((o) => [o.name, o.type, !!o.required, !!o.autocomplete, o.max_length || 0, o.min_length || 0])];
    eq(built.map(shape), reg.map(shape), 'SlashCommandBuilder output matches the plain definitions'); assert(built.every((b) => b.dm_permission === false), 'guild only');

    // fake server manager + interactions
    const logs6 = []; const calls6 = []; let t6 = 1000000;
    const fcfg = { 1: { id: '1', name: 'Alpha', game: 'mc', discordAllowedUserIds: [] }, 2: { id: '2', name: 'Beta Server', game: 'csgo', discordAllowedUserIds: ['222'] }, 3: { id: '3', name: 'Gamma', game: 'rust' } };
    const st6 = { running: { 1: true }, pending: { 3: 'Updating' }, fail: null };
    const fmgr = {
      events: new EventEmitter(), eventLog: { log: (e) => logs6.push(e) },
      settings: { discord: { ...S6.DEFAULTS.discord, botToken: TOKEN, allowedUserIds: ['111', '222'], adminRoleIds: ['900'], allowRawCommands: false } },
      getConfig: (id) => fcfg[id] || null, list: () => Object.keys(fcfg).map((i) => fmgr.view(i)), isRunning: (id) => !!st6.running[id],
      view: (id) => ({ ...fcfg[id], gameName: 'Game' + id, status: st6.running[id] ? 'Started' : 'Stopped', pending: st6.pending[id] || null, players: st6.running[id] ? 3 : null, maxPlayers: 20 }),
      start: async (id) => { if (st6.fail) throw new Error(st6.fail); calls6.push(['start', id]); st6.running[id] = true; }, stop: async (id) => { calls6.push(['stop', id]); delete st6.running[id]; },
      restart: async (id) => { calls6.push(['restart', id]); }, update: async (id, v) => { calls6.push(['update', id, !!v]); }, backup: async (id) => { calls6.push(['backup', id]); return 'backup-2026.zip'; },
      sendCommand: (id, text) => { calls6.push(['send', id, text]); },
    };
    const coll = { state: () => ({ snapshot: { system: { cpuPercent: 12.4, memUsed: 8 * 2 ** 30, memTotal: 16 * 2 ** 30, disk: { drive: 'C:', used: 100 * 2 ** 30, total: 500 * 2 ** 30 } }, servers: [
      { id: '1', name: 'Alpha', pid: 10, cpu: 3.2, mem: 2 ** 30, players: 3, maxPlayers: 20, tick: { value: 19.87, unit: 'TPS' }, metrics: {} }, { id: '2', name: 'Beta Server', pid: 0, cpu: null, mem: null }] } }) };
    const mk = (extra = {}) => DC.createHandlers({ mgr: fmgr, getSettings: () => fmgr.settings, getCollector: () => coll, version: '1.2.3', now: () => t6, bootTime: t6 - 3 * 3600000, ...extra });
    let H = mk();
    const fi = (cmd, user, opts = {}, member) => {
      const o = { replies: [], edits: [], follow: [], deleted: 0, deferred: false, choices: null };
      return Object.assign(o, { commandName: cmd, user: { id: user, tag: 'u' + user + '#0' }, member: member === undefined ? { roles: { cache: new Map() } } : member,
        options: { getString: (n) => (opts[n] === undefined ? null : opts[n]), getBoolean: (n) => (opts[n] === undefined ? null : opts[n]), getFocused: () => opts.focused },
        reply: async (b) => { o.replies.push(b); }, deferReply: async () => { o.deferred = true; }, editReply: async (b) => { o.edits.push(b); }, followUp: async (b) => { o.follow.push(b); }, deleteReply: async () => { o.deleted++; }, respond: async (l) => { o.choices = l; } });
    };
    const go = async (cmd, user, opts, member) => { const i = fi(cmd, user, opts, member); i.res = await H.handle(i); return i; };
    const eph = (b) => !!(b.flags & 64); const txt = (b) => JSON.stringify(b);
    const lastLog = () => logs6[logs6.length - 1];

    // authorisation matrix (default deny)
    let r = await go('list', '999'); assert(r.replies.length === 1 && eph(r.replies[0]) && /not authorised/.test(txt(r.replies[0])), 'unknown user: ephemeral denial'); eq(calls6, [], 'nothing ran');
    eq([lastLog().event, lastLog().detail.userId, lastLog().detail.command, lastLog().detail.result, lastLog().level], ['discord:command', '999', 'list', 'denied: not authorised', 'warn'], 'denied attempt is logged with who / what / result'); assert(/u999#0/.test(lastLog().message) && lastLog().detail.userTag === 'u999#0', 'tag is logged');
    r = await go('start', '999', { serverid: '2' }); assert(eph(r.replies[0]) && calls6.length === 0 && !r.deferred, 'denied mutating command does nothing');
    r = await go('list', '111'); assert(r.replies.length === 1 && !eph(r.replies[0]) && /Alpha/.test(txt(r.replies[0])) && /Beta Server/.test(txt(r.replies[0])) && /3\/20 players/.test(txt(r.replies[0])), '/list for an allowed user'); eq(lastLog().detail.result, 'ok');
    const saved6 = fmgr.settings.discord; fmgr.settings.discord = { ...saved6, allowedUserIds: [], adminRoleIds: [] };
    r = await go('list', '111'); assert(eph(r.replies[0]), 'empty allowlist and no admin role: nobody is allowed'); r = await go('list', '900'); assert(eph(r.replies[0]), 'a user id equal to a role id is not a role');
    fmgr.settings.discord = { ...saved6, allowedUserIds: [], adminRoleIds: ['900'] };
    const roleMember = (roles) => ({ roles: { cache: roles } });
    for (const [label, mem] of [['Map', roleMember(new Map([['900', {}]]))], ['Set', roleMember(new Set(['900']))], ['array cache', roleMember(['900'])], ['raw id array', { roles: ['5', '900'] }]]) { r = await go('list', '555', {}, mem); assert(!eph(r.replies[0]), 'admin role (' + label + ') is allowed'); }
    r = await go('list', '555', {}, roleMember(new Map([['901', {}]]))); assert(eph(r.replies[0]), 'other role: denied'); r = await go('list', '555', {}, null); assert(eph(r.replies[0]), 'no member (DM): denied');
    fmgr.settings.discord = { ...saved6, allowedUserIds: ['111'], adminRoleIds: [] }; r = await go('list', '555', {}, roleMember(new Map([['900', {}]]))); assert(eph(r.replies[0]), 'no admin roles configured: a role grants nothing');
    fmgr.settings.discord = saved6;
    H = mk();   // fresh rate limiter (the matrix above used up user 555 / 111)

    // per-server restriction (wgsm.json discordAllowedUserIds)
    r = await go('start', '111', { serverid: '2' }); assert(eph(r.replies[0]) && /not authorised to control this server/.test(txt(r.replies[0])) && calls6.length === 0, 'per-server list excludes user 111'); eq(lastLog().detail.result, 'denied: server restricted'); eq(lastLog().detail.serverId, '2');
    r = await go('start', '222', { serverid: '2' }); assert(r.deferred && r.edits.length === 1 && /Server started/.test(txt(r.edits[0])) && !r.edits[0].flags, 'listed user may start the restricted server'); eq(calls6, [['start', '2']]); calls6.length = 0; delete st6.running[2];
    r = await go('start', '555', { serverid: '2' }, roleMember(new Map([['900', {}]]))); assert(r.deferred, 'admin role overrides the per-server list'); calls6.length = 0; delete st6.running[2];
    H = mk();

    // commands
    r = await go('check', '111'); const ck = r.replies[0].embeds[0]; assert(ck.fields.some((f) => f.name === 'Version' && f.value === '1.2.3') && ck.fields.some((f) => f.name === 'Uptime' && f.value === '3h 0m') && ck.fields.some((f) => f.name === 'Servers' && f.value === '1 running / 3 total') && ck.fields.some((f) => f.name === 'CPU' && f.value === '12%') && ck.fields.some((f) => f.name === 'RAM' && /8\.0 GB \/ 16\.0 GB/.test(f.value)), '/check: ' + txt(ck));
    r = await go('start', '111', { serverid: '404' }); assert(eph(r.replies[0]) && /No server with id/.test(txt(r.replies[0])), 'unknown server id'); assert(/^refused/.test(lastLog().detail.result));
    r = await go('start', '111', { serverid: '1' }); assert(eph(r.replies[0]) && /already running/.test(txt(r.replies[0])) && calls6.length === 0, 'start: already running');
    r = await go('stop', '111', { serverid: '1' }); assert(r.deferred && /Server stopped/.test(txt(r.edits[0])) && !r.replies.length, '/stop defers, then edits with an embed'); eq(calls6, [['stop', '1']]); eq([lastLog().serverId, lastLog().detail.result], ['1', 'ok']);
    r = await go('stop', '111', { serverid: '1' }); assert(eph(r.replies[0]) && /not running/.test(txt(r.replies[0])), 'stop: not running'); calls6.length = 0;
    H = mk();
    r = await go('restart', '111', { serverid: '1' }); assert(eph(r.replies[0]) && /not running/.test(txt(r.replies[0])), 'restart needs a running server'); st6.running[1] = true;
    H = mk();
    r = await go('restart', '111', { serverid: '1' }); assert(r.deferred && /Server restarted/.test(txt(r.edits[0])), '/restart'); eq(calls6, [['restart', '1']]); calls6.length = 0;
    r = await go('update', '111', { serverid: '1' }); eq(calls6, [['update', '1', false]], 'update without validate'); assert(/Server updated/.test(txt(r.edits[0])) && /started again/.test(txt(r.edits[0]))); calls6.length = 0;
    r = await go('update', '111', { serverid: '1', validate: true }); eq(calls6, [['update', '1', true]], 'update with validate:true'); assert(/validated and updated/.test(txt(r.edits[0]))); calls6.length = 0;
    H = mk();
    r = await go('backup', '111', { serverid: '1' }); assert(/Backup created/.test(txt(r.edits[0])) && /backup-2026\.zip/.test(txt(r.edits[0]))); eq(calls6, [['backup', '1']]); calls6.length = 0;
    for (const c of ['start', 'stop', 'restart', 'update']) { r = await go(c, '111', { serverid: '3' }); assert(eph(r.replies[0]) && /busy \(Updating\)/.test(txt(r.replies[0])) && !r.deferred, c + ': busy server is refused'); }
    H = mk(); r = await go('backup', '111', { serverid: '3' }); assert(eph(r.replies[0]) && /busy/.test(txt(r.replies[0])), 'backup: busy server is refused'); eq(calls6, [], 'busy: nothing ran');
    // a failing operation: the public placeholder is removed and the error follows privately, without the token
    st6.fail = 'spawn failed (token ' + TOKEN + ') at C:\\x'; st6.running[1] = false; r = await go('start', '111', { serverid: '1' }); st6.fail = null; st6.running[1] = true;
    assert(r.deferred && r.deleted === 1 && r.follow.length === 1 && eph(r.follow[0]) && /The command failed/.test(txt(r.follow[0])), 'failed operation: ephemeral error after the deferred reply'); assert(!txt(r.follow[0]).includes(TOKEN) && !JSON.stringify(logs6).includes(TOKEN), 'the token never reaches Discord or the log'); assert(/^error/.test(lastLog().detail.result) && lastLog().level === 'error');
    H = mk();
    r = await go('nope', '111'); assert(eph(r.replies[0]) && /Unknown command/.test(txt(r.replies[0])));
    // allowed_mentions: names can never ping
    r = await go('list', '111'); eq(r.replies[0].allowedMentions, { parse: [] }, 'mentions disabled');
    r = await go('stats', '111'); const sb = r.replies[0].embeds[0]; assert(/12%/.test(txt(sb)) && /Alpha/.test(sb.description) && /CPU 3%/.test(sb.description) && /19\.9 TPS/.test(sb.description) && /3\/20/.test(sb.description) && !/Beta/.test(sb.description) && /C:/.test(txt(sb)), '/stats: system + running servers only: ' + txt(sb));
    const c0 = coll.state; coll.state = () => ({ snapshot: null }); r = await go('stats', '111'); assert(/No metrics/.test(txt(r.replies[0])), '/stats before the first sample'); coll.state = c0;

    // /send is gated by allowRawCommands
    H = mk(); r = await go('send', '111', { serverid: '1', command: 'say hi' }); assert(eph(r.replies[0]) && /switched off/.test(txt(r.replies[0])) && calls6.length === 0, '/send off by default'); assert(/^refused/.test(lastLog().detail.result));
    fmgr.settings.discord = { ...saved6, allowRawCommands: true };
    r = await go('send', '111', { serverid: '1', command: 'say hunter2' }); eq(calls6, [['send', '1', 'say hunter2']], '/send writes to the console when enabled'); assert(eph(r.replies[0]) && !txt(r.replies[0]).includes('hunter2') && /11-character/.test(txt(r.replies[0])), 'reply is ephemeral and does not echo the command'); assert(!JSON.stringify(lastLog()).includes('hunter2') && lastLog().detail.length === 11, 'the log has the length, not the text'); calls6.length = 0;
    r = await go('send', '111', { serverid: '1', command: 'x'.repeat(501) }); assert(/too long/.test(txt(r.replies[0])) && !calls6.length, 'length cap 500'); r = await go('send', '111', { serverid: '1', command: 'x'.repeat(500) }); eq(calls6.length, 1, '500 is allowed'); calls6.length = 0;
    H = mk();
    r = await go('send', '111', { serverid: '1', command: 'say a\nstop' }); assert(/single line/.test(txt(r.replies[0])) && !calls6.length, 'no multi-line injection');
    r = await go('send', '111', { serverid: '1', command: '   ' }); assert(/empty/.test(txt(r.replies[0]))); st6.running[1] = false; r = await go('send', '111', { serverid: '1', command: 'say' }); assert(/not running/.test(txt(r.replies[0]))); st6.running[1] = true;
    r = await go('send', '999', { serverid: '1', command: 'say' }); assert(/not authorised/.test(txt(r.replies[0])) && !calls6.length, 'denied user cannot /send even when enabled'); fmgr.settings.discord = saved6;

    // autocomplete
    let ai = fi('start', '111', { focused: { name: 'serverid', value: 'bet' } }); await H.autocomplete(ai); eq(ai.choices, [], 'user 111 is not on the per-server list of server 2: it is hidden');
    ai = fi('start', '222', { focused: { name: 'serverid', value: 'bet' } }); await H.autocomplete(ai); eq(ai.choices, [{ name: '2 \u2014 Beta Server', value: '2' }], 'autocomplete: "id \u2014 name" matched by name');
    ai = fi('start', '222', { focused: { name: 'serverid', value: '' } }); await H.autocomplete(ai); eq(ai.choices.map((c) => c.value), ['1', '2', '3'], 'autocomplete: everything for an empty query (222 may see server 2)');
    ai = fi('start', '111', { focused: { name: 'serverid', value: '' } }); await H.autocomplete(ai); eq(ai.choices.map((c) => c.value), ['1', '3'], 'autocomplete hides servers restricted to other users');
    ai = fi('start', '111', { focused: { name: 'serverid', value: '3' } }); await H.autocomplete(ai); eq(ai.choices.map((c) => c.value), ['3'], 'matched by id');
    ai = fi('start', '999', { focused: { name: 'serverid', value: '' } }); await H.autocomplete(ai); eq(ai.choices, [], 'unauthorised users get no server names');
    ai = fi('send', '111', { focused: { name: 'command', value: 'x' } }); await H.autocomplete(ai); eq(ai.choices, [], 'other options do not autocomplete');
    for (let k = 4; k <= 40; k++) fcfg[k] = { id: String(k), name: 'Bulk ' + k }; ai = fi('start', '111', { focused: { name: 'serverid', value: 'bulk' } }); await H.autocomplete(ai); eq(ai.choices.length, 25, 'at most 25 choices'); assert(ai.choices.every((c) => c.name.length <= 100)); for (let k = 4; k <= 40; k++) delete fcfg[k];

    // rate limit: 5 commands / 10 s per user
    H = mk(); logs6.length = 0; const rr = []; for (let k = 0; k < 8; k++) rr.push(await go('list', '111'));
    eq(rr.map((x) => (eph(x.replies[0]) ? 'limited' : 'ok')), ['ok', 'ok', 'ok', 'ok', 'ok', 'limited', 'limited', 'limited'], 'sixth command within 10 s is refused'); assert(/Slow down/.test(txt(rr[5].replies[0])));
    eq(logs6.filter((e) => e.detail.result === 'rate limited').length, 1, 'rate limiting is logged once per burst, not for every spam'); r = await go('list', '222'); assert(!eph(r.replies[0]), 'limit is per user');
    t6 += 10001; r = await go('list', '111'); assert(!eph(r.replies[0]), 'window slides'); H = mk();

    // event log entries + bus event
    const seen6 = []; fmgr.events.on('discord:command', (e) => seen6.push(e)); logs6.length = 0; await go('list', '111'); await go('stop', '999', { serverid: '1' });
    eq(logs6.map((e) => [e.event, e.detail.command, e.detail.userId, e.detail.result]), [['discord:command', 'list', '111', 'ok'], ['discord:command', 'stop', '999', 'denied: not authorised']], 'one NGSM log entry per attempt'); eq(seen6.length, 2, 'discord:command is emitted on the bus');
    // with the real event log
    const el6 = new (require('../src/main/services/eventLog').EventLog)(m, P, m.settings, dir); el6.start(); const real = DC.createHandlers({ mgr: Object.assign(Object.create(fmgr), { eventLog: el6, events: m.events }), getSettings: () => fmgr.settings, now: () => Date.now() });
    const ri = fi('list', '111'); await real.handle(ri); const qr = el6.query({ event: 'discord:command' }); assert(qr.length === 1 && qr[0].detail.userTag === 'u111#0' && qr[0].message.includes('/list'), 'real EventLog.query finds the entry'); el6.stop();

    // token redaction helpers
    assert(!DC.redact('login failed for ' + TOKEN + ' / Authorization: Bot ' + TOKEN).includes('MTIzNDU2'), 'redact removes tokens'); assert(!DC.redact('x abc.def.ghi', 'abc.def.ghi').includes('abc.def.ghi'), 'redact removes the exact configured value even when it is not token-shaped');
    assert(DC.tokenFormatOk(TOKEN) && !DC.tokenFormatOk('nope') && !DC.tokenFormatOk('') && !DC.tokenFormatOk(null), 'token format check');

    // settings: sanitising + masking over the IPC table
    const sd = S6.sanitize({ discord: { botEnabled: 'yes', botToken: '  Bot ' + TOKEN + ' ' } }).discord; eq([sd.botEnabled, sd.botToken], [false, TOKEN], 'botEnabled must be a real true; "Bot " prefix and spaces stripped'); eq(S6.sanitize({ discord: { botEnabled: true } }).discord.botEnabled, true); eq(S6.DEFAULTS.discord.botEnabled, false, 'bot is off by default'); eq(S6.DEFAULTS.discord.allowRawCommands, false);
    eq(S6.sanitizeServerDiscord({ discordAllowedUserIds: ['123', 'x', 123, '123'] }).discordAllowedUserIds, ['123'], 'per-server allow list sanitised'); eq(Object.keys(S6.sanitizeServerDiscord({ discordMessage: 'a' })), ['discordMessage'], 'only present keys');
    const botCalls = []; const fbot = { apply: async () => { botCalls.push('apply'); }, restart: async () => ({ state: 'off' }), status: () => ({ state: 'off', user: '', error: '', guilds: 0 }) };
    const ap6 = buildApi6({ mgr: m, collector: { state: () => ({}) }, publicGames: () => [], shell: {}, dialog: {}, app: { setLoginItemSettings() {} }, nativeTheme: {}, getWin: () => null, currentBg: () => '#000', beforeRelaunch() {}, discordBot: fbot });
    m.settings = S6.read(dir); m.saveSettings({ discord: { botToken: TOKEN, applicationId: '123456789012345678' } });
    let pub = ap6.settings(); assert(pub.discord.botToken === undefined && pub.discord.botTokenSet === true && !JSON.stringify(pub).includes(TOKEN) && pub.discord.applicationId === '123456789012345678', 'settings IPC masks the token: botTokenSet flag only');
    pub = ap6.saveSettings({ discord: { botToken: '', allowedUserIds: ['111111111111111111'] } }); assert(m.settings.discord.botToken === TOKEN && pub.discord.botTokenSet === true && !JSON.stringify(pub).includes(TOKEN), 'blank token keeps the saved one; the result is masked'); assert(botCalls.length === 1, 'saving settings asks the bot to apply them');
    pub = ap6.saveSettings({ discord: { botTokenSet: false, webhookUrl: '' } }); assert(m.settings.discord.botToken === TOKEN, 'client-sent botTokenSet is ignored and sibling keys are kept');
    pub = ap6.saveSettings({ discord: { botToken: 'Z'.repeat(40) + '.abcd.' + 'Y'.repeat(30) } }); assert(m.settings.discord.botToken.startsWith('Z') && !JSON.stringify(pub).includes('ZZZZZ'), 'a new token replaces the old one');
    pub = ap6.saveSettings({ discord: { clearBotToken: true } }); assert(m.settings.discord.botToken === '' && pub.discord.botTokenSet === false && !('clearBotToken' in m.settings.discord), 'clearBotToken removes it');
    eq(ap6.discordBotTest(TOKEN), { ok: true }); assert(ap6.discordBotTest('bad').ok === false && ap6.discordBotTest().ok === false && /No bot token/.test(ap6.discordBotTest().error), 'discordBotTest checks the format only'); eq(ap6.discordBotStatus().state, 'off'); eq(ap6.discordBotCommands().length, 9, 'command preview for the UI');
    m.saveSettings({ discord: { botToken: '', applicationId: '' } });
    assert.throws(() => buildApi6({ mgr: m, collector: {}, publicGames: () => [], shell: {}, dialog: {}, app: {}, nativeTheme: {}, getWin: () => null, currentBg: () => '', beforeRelaunch() {} }).discordBotStatus(), /Service not available/);

    // client wiring against a fake discord.js (never connects)
    class FakeClient extends EventEmitter {
      constructor(o) { super(); this.opts = o; FakeClient.all.push(this); this.user = { tag: 'NodeGSM#0001' }; this.guilds = { cache: { size: 2 } }; this.destroyed = false; this.reg = null;
        this.application = { id: '777', commands: { set: async (p, g) => { if (FakeClient.regFail) throw new Error('Missing Access ' + TOKEN); this.reg = { p, g }; } } }; }
      async login(tok) { this.tok = tok; if (FakeClient.loginFail) throw new Error('An invalid token was provided: ' + tok); setImmediate(() => this.emit('clientReady')); return tok; }
      async destroy() { this.destroyed = true; }
    }
    FakeClient.all = [];
    const FD = { Client: FakeClient, GatewayIntentBits: { Guilds: 1 }, Events: { ClientReady: 'clientReady', ShardDisconnect: 'shardDisconnect', ShardResume: 'shardResume', InteractionCreate: 'interactionCreate' }, SlashCommandBuilder: D6.SlashCommandBuilder };
    let loads = 0; const stl = []; const bmgr = Object.assign(Object.create(fmgr), { settings: { discord: { ...S6.DEFAULTS.discord, allowedUserIds: ['111'] } } });
    const bot = new DiscordBot(bmgr, P, bmgr.settings, dir, { loadDiscord: () => { loads++; return FD; } }); bot.onStatus = (s) => stl.push(s.state); bot.collector = coll;
    await bot.start(); eq(bot.status().state, 'off', 'disabled: stays off'); eq([loads, FakeClient.all.length], [0, 0], 'discord.js is not even loaded while the bot is off');
    bmgr.settings.discord = { ...bmgr.settings.discord, botEnabled: true, botToken: '' }; await bot.apply(); assert(bot.status().state === 'error' && /No bot token/.test(bot.status().error) && loads === 0, 'enabled without a token: error, no client');
    bmgr.settings.discord = { ...bmgr.settings.discord, botToken: 'garbage' }; await bot.apply(); assert(bot.status().state === 'error' && /does not look valid/.test(bot.status().error), 'malformed token: error without a network call');
    bmgr.settings.discord = { ...bmgr.settings.discord, botToken: TOKEN, applicationId: '777', guildId: '888' }; await bot.apply(); await sleep(30);
    const cl6 = FakeClient.all[0]; eq([bot.status().state, bot.status().user, bot.status().guilds, bot.status().registered], ['online', 'NodeGSM#0001', 2, true], 'login -> online'); eq(cl6.opts.intents, [1], 'Guilds intent only'); eq([cl6.tok, cl6.reg.g, cl6.reg.p.length], [TOKEN, '888', 9], 'guild commands registered with the built payload'); assert(stl.includes('connecting') && stl[stl.length - 1] === 'online', 'status pushed to the UI: ' + stl);
    assert(!JSON.stringify(bot.status()).includes(TOKEN), 'status never contains the token');
    await bot.apply(); eq(FakeClient.all.length, 1, 'unchanged settings do not reconnect'); bmgr.settings.discord.allowedUserIds = ['1']; await bot.apply(); eq(FakeClient.all.length, 1, 'changing the allowlist needs no reconnect (read live)');
    bmgr.settings.discord = { ...bmgr.settings.discord, guildId: '' }; await bot.apply(); await sleep(30); eq([FakeClient.all.length, cl6.destroyed, FakeClient.all[1].reg.g], [2, true, undefined], 'guild change: reconnect, old client destroyed, global registration');
    // interactions reach the handlers
    const cl7 = FakeClient.all[1]; bmgr.settings.discord.allowedUserIds = ['111']; const ii = fi('list', '111'); ii.isAutocomplete = () => false; ii.isChatInputCommand = () => true; cl7.emit('interactionCreate', ii); await sleep(20); assert(ii.replies.length === 1 && !eph(ii.replies[0]), 'chat input interaction handled');
    const ia = fi('start', '111', { focused: { name: 'serverid', value: 'alp' } }); ia.isAutocomplete = () => true; ia.isChatInputCommand = () => false; cl7.emit('interactionCreate', ia); await sleep(20); eq(ia.choices.map((c) => c.value), ['1'], 'autocomplete interaction handled');
    // login / registration failures are reported without the token
    FakeClient.loginFail = true; await bot.restart(); assert(bot.status().state === 'error' && /invalid token/.test(bot.status().error) && !bot.status().error.includes(TOKEN) && !JSON.stringify(stl).includes(TOKEN), 'login failure: error state, token redacted'); FakeClient.loginFail = false;
    FakeClient.regFail = true; await bot.restart(); await sleep(30); assert(bot.status().state === 'online' && bot.status().registered === false && /Registering the slash commands failed/.test(bot.status().error) && !bot.status().error.includes(TOKEN), 'registration failure is visible'); FakeClient.regFail = false;
    await bot.restart(); await sleep(30); eq([bot.status().state, bot.status().registered, bot.status().error], ['online', true, ''], 'restart recovers');
    bmgr.settings.discord = { ...bmgr.settings.discord, botEnabled: false }; const beforeOff = FakeClient.all.at(-1); await bot.apply(); eq(bot.status().state, 'off', 'switching the bot off disconnects'); assert(beforeOff.destroyed, 'client destroyed');
    bmgr.settings.discord = { ...bmgr.settings.discord, botEnabled: true }; await bot.apply(); await sleep(30); const lastC = FakeClient.all.at(-1); await bot.stop(); assert(lastC.destroyed && bot.status().state === 'off', 'stop() (before-quit) destroys the client'); await bot.apply(); eq(bot.status().state, 'off', 'apply after stop does nothing');
    assert(new DiscordBot(bmgr, P, bmgr.settings, dir).status().state === 'off', 'construction does not load discord.js');

    // renderer / package wiring
    const html6 = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
    for (const id of ['dcBotOn', 'dcBotToken', 'dcBotApp', 'dcBotGuild', 'dcBotUsers', 'dcBotRoles', 'dcBotRaw', 'dcBotBadge', 'dcBotCopy', 'dcBotSave', 'dcBotReconnect', 'dcBotCmds', 'dcBotWarn']) assert(html6.includes('id="' + id + '"'), 'element #' + id);
    assert(/type="password" id="dcBotToken"/.test(html6), 'token field is a password field'); assert(!/<script>[^<]/.test(html6), 'no inline scripts (CSP)');
    const dv6 = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'discordView.js'), 'utf8'); assert(/applications\.commands%20bot&permissions=0/.test(dv6) && /discordBotRestart/.test(dv6) && !/\.botToken/.test(dv6.replace(/d\.botToken|patch\.botToken/g, '')), 'invite link built locally; the view never reads a token back');
    const pj6 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')); assert(/^\^?14\./.test(pj6.dependencies['discord.js']), 'discord.js 14.x is a runtime dependency');
  }

  // ---- logo / icons ----
  {
    const R = path.join(__dirname, '..'); const zl = require('zlib');
    const pngInfo = (rel) => { const b = fs.readFileSync(path.join(R, rel)); assert(b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), rel + ' PNG signature'); assert.strictEqual(b.readUInt32BE(8), 13, rel + ' IHDR length'); assert.strictEqual(b.subarray(12, 16).toString(), 'IHDR', rel + ' IHDR'); assert.strictEqual(b.subarray(b.length - 8, b.length - 4).toString(), 'IEND', rel + ' IEND'); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), buf: b }; };
    const sizes = { 'assets/icon.png': 256, 'assets/icon-32.png': 32, 'assets/icon-16.png': 16, 'website/assets/logo.png': 256, 'website/assets/favicon.png': 64 };
    for (const [rel, sz] of Object.entries(sizes)) { const i = pngInfo(rel); eq([i.w, i.h], [sz, sz], rel + ' size'); }
    // IDAT inflates to the expected number of bytes (valid zlib stream)
    { const b = pngInfo('assets/icon.png').buf; let o = 8; const idat = []; while (o < b.length) { const len = b.readUInt32BE(o); if (b.subarray(o + 4, o + 8).toString() === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len)); o += 12 + len; } assert.strictEqual(zl.inflateSync(Buffer.concat(idat)).length, (256 * 4 + 1) * 256, 'icon.png pixel data'); }
    const ico = fs.readFileSync(path.join(R, 'build', 'icon.ico'));
    eq([ico.readUInt16LE(0), ico.readUInt16LE(2)], [0, 1], 'ICO header'); const n = ico.readUInt16LE(4); eq(n, 6, 'ICO has 6 images');
    const got = []; for (let i = 0; i < n; i++) { const o = 6 + i * 16; const w = ico[o] || 256; const size = ico.readUInt32LE(o + 8), off = ico.readUInt32LE(o + 12); assert(off + size <= ico.length, 'ICO entry in range'); assert(ico.subarray(off, off + 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'ICO entry is a PNG'); got.push(w); }
    eq(got, [16, 32, 48, 64, 128, 256], 'ICO sizes');
    for (const f of ['logo.svg', 'logo-wordmark.svg', 'icon.svg']) { const svg = fs.readFileSync(path.join(R, 'assets', f), 'utf8'); assert(/^<svg[^>]+viewBox=/.test(svg) && svg.trim().endsWith('</svg>') && !/<script/i.test(svg), 'assets/' + f + ' is a plain SVG'); }
    const pj8 = JSON.parse(fs.readFileSync(path.join(R, 'package.json'), 'utf8')); assert(pj8.build.win.icon && fs.existsSync(path.join(R, pj8.build.win.icon)), 'package.json build.win.icon exists'); assert(pj8.scripts.icons, 'npm run icons');
    const html8 = fs.readFileSync(path.join(R, 'src', 'renderer', 'index.html'), 'utf8'); assert(/<div class="brand"><svg class="logo"/.test(html8) && html8.includes('assets/icon-32.png'), 'app header shows the logo');
    for (const p of ['index', 'features', 'plugins', 'download']) assert(fs.readFileSync(path.join(R, 'website', p + '.html'), 'utf8').includes('assets/favicon.png'), 'website/' + p + '.html favicon');
    assert(fs.readFileSync(path.join(R, 'website', 'layout.js'), 'utf8').includes('assets/logo.png'), 'website header uses the logo');
    const mj = fs.readFileSync(path.join(R, 'src', 'main', 'main.js'), 'utf8'); assert(/icon-16.png/.test(mj) && /icon.png/.test(mj) && /icon: path.join/.test(mj), 'tray + window icon wiring');
    { const { buildApi } = require('../src/main/api'); const names = Object.keys(buildApi({ mgr: { settings: {} }, collector: {}, shell: {}, dialog: {}, app: {}, nativeTheme: {}, getWin() {}, currentBg() {} })); const doc = fs.readFileSync(path.join(R, 'docs', 'TECH-api.md'), 'utf8'); const missing = names.filter((n) => !new RegExp('`' + n + '`').test(doc)); eq(missing, [], 'every IPC channel is documented in docs/TECH-api.md'); for (const ch of ['status', 'console', 'consoleOut', 'logLines', 'removed', 'metrics', 'cluster:progress', 'discordBot']) assert(doc.includes('| `' + ch + '` |'), 'push event ' + ch + ' documented'); for (const f of fs.readdirSync(path.join(R, 'docs'))) if (f !== 'README.md') assert(fs.readFileSync(path.join(R, 'docs', 'README.md'), 'utf8').includes('(' + f + ')'), 'docs/README.md links ' + f); for (const f of fs.readdirSync(path.join(R, 'docs'))) if (f !== 'README.md') assert(fs.readFileSync(path.join(R, 'README.md'), 'utf8').includes('docs/' + f), 'README.md links docs/' + f); }
    const B = require('../scripts/build-icons'); const px = B.render(16); assert.strictEqual(px.length, 16 * 16 * 4); assert(px[3] === 0 && px[(8 * 16 + 8) * 4 + 3] === 255 && px[(2 * 16 + 8) * 4 + 3] === 255, 'tile has rounded transparent corners and an opaque body'); assert(B.render(256, { tile: false })[3] === 0, 'mark-only render is transparent in the corner');
  }

  // ---- Phase 8: platform layer, plugin platforms, headless web server ----
  {
    const PL = require('../src/main/platform'); const { SteamCMD } = require('../src/main/steamcmd'); const { treeTotals } = require('../src/main/metrics');
    const R = path.join(__dirname, '..');
    // /proc parsing (injected fake proc files)
    const st1 = '1000 (my (weird) game) S 1 1000 1000 0 -1 4194304 100 0 0 0 150 50 0 0 20 0 7 0 12345 1000000 2500 18446744073709551615';
    const p1 = PL.parseProcStat(st1); eq([p1.pid, p1.comm, p1.state, p1.ppid, p1.utime, p1.stime, p1.threads, p1.rssPages], [1000, 'my (weird) game', 'S', 1, 150, 50, 7, 2500], 'stat with parentheses / spaces in the name');
    assert.strictEqual(PL.parseProcStat('garbage'), null); eq(PL.parseProcStatus('Name:\tx\nVmRSS:\t   4096 kB\nThreads:\t9\n'), { vmRssKb: 4096, threads: 9 });
    const files = { '/proc/1000/stat': st1, '/proc/1000/status': 'VmRSS:\t4096 kB\nThreads:\t7\n', '/proc/1001/stat': '1001 (child) R 1000 1000 1000 0 -1 0 0 0 0 0 100 100 0 0 20 0 2 0 99 1 100', '/proc/1001/status': 'VmRSS:\t1024 kB\nThreads:\t2\n', '/proc/1002/stat': '1002 (other) S 1 1 1 0 -1 0 0 0 0 0 5 5 0 0 20 0 1 0 99 1 10' };
    const rows = PL.readProcessesLinux({ readdir: () => ['1000', '1001', '1002', 'self', 'cpuinfo'], readFile: (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; }, clkTck: 100, pageSize: 4096 });
    eq(rows.find((r) => r.pid === 1000), { pid: 1000, ppid: 1, mem: 4096 * 1024, cpuTime: 2e7, threads: 7 }, 'cpuTime is in 100 ns units like Windows');
    eq(rows.find((r) => r.pid === 1002).mem, 10 * 4096, 'RSS pages used when /status is missing');
    eq(treeTotals(rows, 1000), { mem: 4096 * 1024 + 1024 * 1024, cpuTime: 2e7 + 2e7, threads: 9, procs: 2 }, 'child processes are summed through ppid');
    // process-tree kill, affinity, data dir, steamcmd, firewall
    const sig = []; PL.killTree(4242, { force: false }, { platform: 'linux', kill: (p, s2) => sig.push([p, s2]) }); PL.killTree(4242, { force: true }, { platform: 'linux', kill: (p, s2) => sig.push([p, s2]) });
    eq(sig, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']], 'POSIX kills the process group: TERM then KILL');
    const sig2 = []; PL.killTree(7, {}, { platform: 'linux', kill: (p) => { sig2.push(p); if (p < 0) throw new Error('ESRCH'); } }); eq(sig2, [-7, 7], 'falls back to the single pid');
    const wk = []; PL.killTree(9, { force: true }, { platform: 'win32', spawnSync: (c, a, b) => { wk.push([c, ...a]); return { status: 0 }; } }); eq(wk, [['taskkill', '/PID', '9', '/T', '/F']], 'Windows keeps taskkill /T /F');
    eq(PL.spawnOptions('linux'), { detached: true }); eq(PL.spawnOptions('win32'), { windowsHide: true });
    eq(PL.affinityCommand(5, '1100', 'linux'), { cmd: 'taskset', args: ['-a', '-p', 'c', '5'] }); assert(/ProcessorAffinity = 12/.test(PL.affinityCommand(5, '1100', 'win32').args[2])); assert.strictEqual(PL.affinityCommand(5, 'x', 'linux'), null);
    assert.strictEqual(PL.defaultDataDir({ platform: 'linux', env: {}, home: '/home/u' }), path.join('/home/u', '.local', 'share', 'NodeGSM')); assert.strictEqual(PL.defaultDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/x' }, home: '/h' }), path.join('/x', 'NodeGSM')); assert.strictEqual(PL.defaultDataDir({ platform: 'linux', env: { NODEGSM_DATA: '/d' } }), '/d');
    assert.strictEqual(PL.defaultDataDir({ platform: 'win32', env: {}, appData: 'C:\\A', exists: () => true }), path.join('C:\\A', 'node-wgsm2026', 'WGSM'), 'legacy Windows data folder still wins'); assert.strictEqual(PL.defaultDataDir({ platform: 'win32', env: {}, appData: 'C:\\A', exists: () => false }), path.join('C:\\A', 'NodeGSM'));
    const si = PL.steamcmdInfo('/d', 'linux'); assert(/steamcmd_linux\.tar\.gz$/.test(si.url) && /steamcmd\.sh$/.test(si.exe) && si.kind === 'tar'); assert(/steamcmd\.zip$/.test(PL.steamcmdInfo('C:\\d', 'win32').url));
    eq(PL.tarArgs('/x/steamcmd_linux.tar.gz', '/dest'), ['-xzf', '/x/steamcmd_linux.tar.gz', '-C', '/dest']); eq(PL.tarArgs('/x/a.tar', '/d')[0], '-xf');
    const sl = new SteamCMD('/d', 'linux'); assert(/steamcmd\.sh$/.test(sl.exe));
    eq(sl.buildArgs('/srv/g', '740', { validate: true }), ['+force_install_dir', '/srv/g', '+login', 'anonymous', '+app_update', '740', 'validate', '+quit'], 'same arguments on Linux');
    eq(sl.buildArgs('/srv/g', '740', { validate: false, forcePlatform: 'windows' }).slice(0, 2), ['+@sSteamCmdForcePlatformType', 'windows'], 'platform override goes first'); assert(!sl.buildArgs('/g', '1', { forcePlatform: 'linux' }).includes('+@sSteamCmdForcePlatformType'), 'no override when it equals the host');
    eq(new SteamCMD('C:\\d', 'win32').buildArgs('D:/x', '90', { validate: true }), ['+force_install_dir', 'D:/x', '+login', 'anonymous', '+app_update', '90', 'validate', '+quit'], 'Windows arguments unchanged');
    const fwl = PL.firewall({ name: 'n', port: '27015', queryPort: '27015' }, '1', true, 'linux'); assert(!fwl.ok && fwl.unsupported && /ufw allow 27015/.test(fwl.message), 'firewall hint on Linux, nothing executed');
    // plugin platforms
    const pbase = { id: 'plat1', name: 'N', install: { type: 'manual' }, run: { exe: 'a.exe' } };
    assert(P.validate({ ...pbase, platforms: ['windows', 'linux'] }).errors.length === 0); assert(P.validate({ ...pbase, platforms: ['beos'] }).errors.some((x) => /platforms/.test(x))); assert(P.validate({ ...pbase, platforms: [] }).errors.length > 0);
    assert(P.validate({ ...pbase, run: { exe: 'a.exe', linux: { exe: '../x' } } }).errors.some((x) => /run\.linux\.exe/.test(x))); assert(P.validate({ ...pbase, run: { exe: 'a.exe', linux: { args: 'no' } } }).errors.some((x) => /run\.linux\.args/.test(x)));
    assert(P.validate({ ...pbase, install: { type: 'manual', linux: { steps: [{ type: 'steamcmd', appId: 'x' }] } } }).errors.some((x) => /install\.linux\.steps\[0\]\.appId/.test(x))); assert(P.validate({ ...pbase, install: { steps: [{ type: 'steamcmd', appId: '1', platform: 'beos' }] } }).errors.some((x) => /platform/.test(x)));
    assert(P.validate({ ...pbase, platforms: ['linux', 'windows'], run: { exe: 'a.exe', linux: { exe: 'a', command: 'java', env: { A: 'b' } } }, install: { steps: [{ type: 'steamcmd', appId: '1' }], linux: { steps: [{ type: 'steamcmd', appId: '2', platform: 'linux' }] } } }).errors.length === 0, 'valid linux fields');
    const csgoM = JSON.parse(fs.readFileSync(path.join(R, 'plugins', 'csgo', 'plugin.json'), 'utf8'));
    const gl = P.toGame(csgoM, path.join(R, 'plugins', 'csgo'), 'bundled', 'linux'); const gw = P.toGame(csgoM, path.join(R, 'plugins', 'csgo'), 'bundled', 'windows');
    eq([gl.exe, gw.exe, gl.supported, gl.stdin], ['srcds_run', 'srcds.exe', true, false], 'run.linux overrides exe, keeps args / stdin'); const acfg = { port: '1', param: '', map: 'm', maxPlayers: '2', gslt: '', ip: '' }; eq(gl.args(acfg, { serverFiles: 'x' }), gw.args(acfg, { serverFiles: 'x' }));
    const rl = P.toGame(JSON.parse(fs.readFileSync(path.join(R, 'plugins', 'rust', 'plugin.json'), 'utf8')), path.join(R, 'plugins', 'rust'), 'bundled', 'linux'); assert(rl.exe === 'RustDedicated' && /x86_64/.test(rl.env.LD_LIBRARY_PATH));
    const winOnly = P.toGame(JSON.parse(fs.readFileSync(path.join(R, 'plugins', 'cs', 'plugin.json'), 'utf8')), path.join(R, 'plugins', 'cs'), 'bundled', 'linux'); eq([winOnly.supported, winOnly.platforms], [false, ['windows']], 'plugins without platforms are Windows only');
    const lins = P.toGame({ ...pbase, install: { steps: [{ type: 'steamcmd', appId: '1' }], linux: { steps: [{ type: 'steamcmd', appId: '2' }] } } }, path.join(R, 'plugins', 'csgo'), 'bundled', 'linux'); assert.strictEqual(lins.appId, '2', 'install.linux replaces the install steps on Linux');
    const linOnly = P.toGame({ ...pbase, id: 'linonly', platforms: ['linux'] }, path.join(R, 'plugins', 'csgo'), 'bundled', 'windows'); P.GAMES.push(linOnly);
    assert.throws(() => m.create('linonly', 'x'), /not available on this platform/, 'unsupported game refused on the wrong platform'); assert.throws(() => m.importServer('linonly', 'x', dir), /not available on this platform/); P.GAMES.splice(P.GAMES.indexOf(linOnly), 1);
    const reg = JSON.parse(fs.readFileSync(path.join(R, 'plugins', 'registry.json'), 'utf8')); eq(reg.plugins.filter((x) => x.platforms.includes('linux')).map((x) => x.id).sort(), ['csgo', 'mc', 'palworld', 'rust'], 'registry lists the declared Linux plugins'); assert(reg.plugins.every((x) => Array.isArray(x.platforms)));
    assert(P.detail('csgo').platforms.includes('linux') && typeof P.detail('csgo').supported === 'boolean');
    // electron must never load in the headless path
    const cp = require('child_process');
    const probe = `const M=require('module');const o=M._resolveFilename;M._resolveFilename=function(r,...a){if(r==='electron'||r.startsWith('electron/'))throw new Error('ELECTRON_BLOCKED');return o.call(this,r,...a)};require(${JSON.stringify(path.join(R, 'src', 'main', 'core.js'))});require(${JSON.stringify(path.join(R, 'src', 'server', 'headless.js'))});console.log('loaded')`;
    const pr = cp.spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' }); assert(pr.status === 0 && /loaded/.test(pr.stdout), 'core.js + headless.js load with electron unresolvable: ' + pr.stderr);
    for (const f of fs.readdirSync(path.join(R, 'src', 'main'), { recursive: true })) if (/\.js$/.test(f) && !/^(main|preload)\.js$/.test(f)) assert(!/require\(['"]electron['"]\)/.test(fs.readFileSync(path.join(R, 'src', 'main', f), 'utf8')), f + ' must not require electron');

    // ---- the headless server ----
    const { startServer, resolveStatic } = require('../src/server/headless'); const WS = require('ws');
    const rq = (port, method, p, { headers = {}, body } = {}) => new Promise((res, rej) => { const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (x) => { let d = ''; x.on('data', (c) => { d += c; }); x.on('end', () => res({ status: x.statusCode, headers: x.headers, text: d, json: () => JSON.parse(d) })); }); r.on('error', rej); if (body !== undefined) r.write(body); r.end(); });
    const TOKEN = 'test-token-0123456789';
    const hdir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodegsm-web-'));
    await assert.rejects(startServer({ dataDir: hdir, host: '0.0.0.0', port: 0, auth: false, startCore: false }), /without authentication/, 'non-loopback bind without auth refused');
    await assert.rejects(startServer({ dataDir: hdir, host: '192.168.1.5', port: 0, auth: false, startCore: false }), /loopback/);
    const AUTH = require('../src/server/auth'); const t1 = AUTH.loadToken(path.join(hdir, 'tk'), {}); assert(t1.source === 'generated' && t1.token.length >= 30); const t2 = AUTH.loadToken(path.join(hdir, 'tk'), {}); eq([t2.source, t2.token], ['file', t1.token]); if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(hdir, 'tk', 'web-token')).mode & 0o777, 0o600); assert.strictEqual(AUTH.loadToken(hdir, { NODEGSM_TOKEN: 'abcdefghijkl' }).source, 'env'); assert.throws(() => AUTH.loadToken(hdir, { NODEGSM_TOKEN: 'short' }));
    assert(AUTH.safeEqual('a', 'a') && !AUTH.safeEqual('a', 'b') && !AUTH.safeEqual('a', 'aa'));
    const S = await startServer({ dataDir: hdir, port: 0, token: TOKEN, maxFailures: 50, maxBody: 2048 }); const port = S.port; const origin = `http://127.0.0.1:${port}`;
    const J = { 'Content-Type': 'application/json' };
    let r = await rq(port, 'GET', '/healthz'); eq([r.status, r.json()], [200, { ok: true }], '/healthz is open and returns only {ok:true}');
    r = await rq(port, 'POST', '/api/list', { headers: J, body: '{"args":[]}' }); assert.strictEqual(r.status, 401, 'unauthenticated API call');
    r = await rq(port, 'GET', '/'); assert(r.status === 302 && r.headers.location === '/login.html', 'index redirects to the login page'); assert.strictEqual((await rq(port, 'GET', '/app.js')).status, 401, 'app files need a login');
    r = await rq(port, 'GET', '/login.html'); assert(r.status === 200 && /connect-src 'self'/.test(r.headers['content-security-policy']) && !/<script>/.test(r.text) && /login\.js/.test(r.text), 'login page: CSP header, no inline script');
    assert.strictEqual((await rq(port, 'GET', '/login.js')).status, 200);
    const idx = fs.readFileSync(path.join(R, 'src', 'renderer', 'index.html'), 'utf8'); assert(!/<script>/.test(idx) && idx.indexOf('transport-web.js') < idx.indexOf('app.js') && !/onclick=/.test(idx), 'index.html: no inline scripts, transport before app');
    const login = (t, h = {}) => rq(port, 'POST', '/login', { headers: { ...J, Origin: origin, ...h }, body: JSON.stringify({ token: t }) });
    r = await login('wrong-token-xxxxx'); assert.strictEqual(r.status, 401);
    r = await rq(port, 'POST', '/login', { headers: J, body: JSON.stringify({ token: TOKEN }) }); assert.strictEqual(r.status, 403, 'login without Origin rejected');
    r = await login(TOKEN, { Origin: 'http://evil.example' }); assert.strictEqual(r.status, 403, 'cross-origin login rejected');
    r = await rq(port, 'POST', '/login', { headers: { 'Content-Type': 'text/plain', Origin: origin }, body: TOKEN }); assert.strictEqual(r.status, 415, 'JSON content type only');
    r = await login(TOKEN); assert.strictEqual(r.status, 200); const sc = r.headers['set-cookie'][0]; assert(/HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && !/Secure/.test(sc) && /Path=\//.test(sc), 'session cookie flags');
    const cookie = sc.split(';')[0]; assert(!sc.includes(TOKEN), 'the token is never put in the cookie');
    assert(/Secure/.test((await login(TOKEN, { 'X-Forwarded-Proto': 'https' })).headers['set-cookie'][0]), 'Secure behind an https proxy');
    const withCookie = { ...J, Cookie: cookie, Origin: origin };
    r = await rq(port, 'POST', '/api/list', { headers: withCookie, body: '{"args":[]}' }); assert(r.status === 200 && r.json().ok && Array.isArray(r.json().data), 'API round trip with the session cookie');
    r = await rq(port, 'POST', '/api/games', { headers: withCookie, body: '{}' }); assert(r.json().data.length >= 46 && r.json().data.some((x) => x.id === 'csgo' && x.platforms.includes('linux') && typeof x.supported === 'boolean'), 'games over HTTP with platforms');
    r = await rq(port, 'POST', '/api/settings', { headers: withCookie, body: '{"args":[]}' }); assert(r.json().ok && r.json().data.theme && !('botToken' in r.json().data.discord), 'settings never carry the bot token');
    r = await rq(port, 'POST', '/api/saveSettings', { headers: withCookie, body: JSON.stringify({ args: [{ theme: 'light' }] }) }); assert(r.json().ok && r.json().data.theme === 'light', 'saveSettings works headless (no Electron members)');
    r = await rq(port, 'POST', '/api/platformInfo', { headers: withCookie, body: '{"args":[]}' }); const pinfo = r.json().data; assert(pinfo.mode === 'web' && pinfo.platform === PL.current() && pinfo.features.pickFolder === false && pinfo.features.backupDownload === true, 'platformInfo in web mode');
    r = await rq(port, 'POST', '/api/pickFolder', { headers: withCookie, body: '{"args":[]}' }); assert(r.json().ok === false && /web mode/.test(r.json().error), 'pickFolder -> unsupported error'); assert(/restart/i.test((await rq(port, 'POST', '/api/relaunch', { headers: withCookie, body: '{}' })).json().error), 'relaunch -> restart hint');
    r = await rq(port, 'POST', '/api/get', { headers: withCookie, body: '{"args":["999"]}' }); assert.strictEqual(r.json().data, null, 'null results survive JSON');
    r = await rq(port, 'POST', '/api/nope', { headers: withCookie, body: '{}' }); assert.strictEqual(r.status, 404); assert.strictEqual((await rq(port, 'POST', '/api/constructor', { headers: withCookie, body: '{}' })).status, 404, 'prototype names are not channels'); assert.strictEqual((await rq(port, 'POST', '/api/__proto__', { headers: withCookie, body: '{}' })).status, 404);
    r = await rq(port, 'POST', '/api/list', { headers: { ...withCookie, Origin: 'http://evil.example' }, body: '{}' }); assert.strictEqual(r.status, 403, 'cross-origin POST rejected');
    r = await rq(port, 'POST', '/api/list', { headers: { ...J, Cookie: cookie }, body: '{}' }); assert.strictEqual(r.status, 403, 'POST without Origin rejected for cookie sessions');
    r = await rq(port, 'POST', '/api/list', { headers: { 'Content-Type': 'text/plain', Cookie: cookie, Origin: origin }, body: '{}' }); assert.strictEqual(r.status, 415);
    r = await rq(port, 'POST', '/api/list', { headers: withCookie, body: '{not json' }); assert.strictEqual(r.status, 400); r = await rq(port, 'POST', '/api/list', { headers: withCookie, body: '{"args":5}' }); assert.strictEqual(r.status, 400); assert.strictEqual((await rq(port, 'GET', '/api/list', { headers: withCookie })).status, 405);
    r = await rq(port, 'POST', '/api/list', { headers: withCookie, body: JSON.stringify({ args: ['x'.repeat(5000)] }) }); assert.strictEqual(r.status, 413, 'request body limit');
    r = await rq(port, 'POST', '/api/list', { headers: { ...J, Authorization: 'Bearer ' + TOKEN }, body: '{"args":[]}' }); assert(r.status === 200 && r.json().ok, 'bearer token accepted (no Origin needed)');
    assert.strictEqual((await rq(port, 'POST', '/api/list', { headers: { ...J, Authorization: 'Bearer nope-nope-nope' }, body: '{}' })).status, 401);
    r = await rq(port, 'GET', '/', { headers: { Cookie: cookie } }); assert(r.status === 200 && /<title>NodeGSM/.test(r.text) && /connect-src/.test(r.headers['content-security-policy']) && r.headers['x-frame-options'] === 'DENY', 'index served after login');
    assert.strictEqual((await rq(port, 'GET', '/assets/logo.svg')).status, 200, 'logo is public (login page)');
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%5Cpackage.json', '/assets/../package.json', '/assets/%2e%2e/package.json', '/.git/config', '/app.js%00.png', '/%00', '/main.js/../../main/main.js', '//etc/passwd', '/index.html/../../../package.json', '/..%2fpackage.json']) { r = await rq(port, 'GET', p, { headers: { Cookie: cookie } }); assert(r.status === 404 || r.status === 400, 'traversal rejected: ' + p + ' -> ' + r.status); assert(!/"name": "nodegsm"/.test(r.text)); }
    assert.strictEqual(resolveStatic('/../package.json'), null); assert.strictEqual(resolveStatic('/assets/../src/main/main.js'), null); assert(resolveStatic('/app.js') && resolveStatic('/assets/logo.svg')); assert.strictEqual(resolveStatic('/secret.txt'), null);
    // backup download: authenticated and confined
    fs.mkdirSync(path.join(hdir, 'backups', '1'), { recursive: true }); fs.writeFileSync(path.join(hdir, 'backups', '1', 'x.zip'), 'ZIPDATA'); fs.writeFileSync(path.join(hdir, 'outside.zip'), 'SECRET');
    assert.strictEqual((await rq(port, 'GET', '/download/backup?folder=1&file=x.zip')).status, 401, 'download needs auth');
    r = await rq(port, 'GET', '/download/backup?folder=1&file=x.zip', { headers: { Cookie: cookie } }); assert(r.status === 200 && r.text === 'ZIPDATA' && /attachment; filename="x\.zip"/.test(r.headers['content-disposition']) && r.headers['content-type'] === 'application/zip');
    for (const q of ['folder=..&file=outside.zip', 'folder=1&file=../../outside.zip', 'folder=1&file=..%2f..%2foutside.zip', 'folder=1%2f..&file=x.zip', 'folder=1&file=nothere.zip', 'folder=&file=', 'folder=1&file=x.txt']) { r = await rq(port, 'GET', '/download/backup?' + q, { headers: { Cookie: cookie } }); assert(r.status >= 400 && !/SECRET|ZIPDATA/.test(r.text), 'download confined: ' + q + ' -> ' + r.status); }
    // WebSocket: auth + origin checks, then events from a fake game server
    const wsUrl = `ws://127.0.0.1:${port}/ws`;
    const wsFail = (opts) => new Promise((res) => { const w = new WS(wsUrl, opts); w.on('unexpected-response', (_q, x) => { res(x.statusCode); w.terminate(); }); w.on('open', () => { res(101); w.close(); }); w.on('error', () => {}); });
    assert.strictEqual(await wsFail({ headers: { Origin: origin } }), 401, 'WebSocket needs auth'); assert.strictEqual(await wsFail({ headers: { Cookie: cookie, Origin: 'http://evil.example' } }), 403, 'cross-origin WebSocket rejected');
    const msgs = []; const ws1 = new WS(wsUrl, { headers: { Cookie: cookie, Origin: origin } }); ws1.on('message', (d) => msgs.push(JSON.parse(String(d)))); await new Promise((res, rej) => { ws1.on('open', res); ws1.on('error', rej); });
    const wfake = path.join(hdir, 'fakegame'); fs.mkdirSync(wfake); fs.copyFileSync(process.execPath, path.join(wfake, P.byId('sw').exe));
    const sv = S.core.mgr.importServer('sw', 'WebFake', wfake); S.core.mgr.saveConfig(sv.id, { param: '-e "console.log(\'web-hello\');process.stdin.on(\'data\',d=>{if(/quit/.test(d))process.exit(0)});setInterval(()=>{},1000)"' });
    r = await rq(port, 'POST', '/api/start', { headers: withCookie, body: JSON.stringify({ args: [sv.id] }) }); assert(r.json().ok, 'start through the API: ' + r.text); await sleep(1500);
    assert(msgs.some((x) => x.ch === 'status' && x.payload.id === sv.id && x.payload.status === 'Started'), 'status event over WebSocket'); assert(msgs.some((x) => x.ch === 'console' && x.payload.id === sv.id && /web-hello/.test(x.payload.line)), 'console event over WebSocket');
    assert(msgs.some((x) => x.ch === 'status' && x.payload.pid), 'status carries the pid');
    r = await rq(port, 'POST', '/api/stop', { headers: withCookie, body: JSON.stringify({ args: [sv.id] }) }); await sleep(500); assert(msgs.some((x) => x.ch === 'status' && x.payload.status === 'Stopped'), 'stop event');
    // logout + session expiry
    r = await rq(port, 'POST', '/logout', { headers: withCookie, body: '{}' }); assert.strictEqual(r.status, 200); assert.strictEqual((await rq(port, 'POST', '/api/list', { headers: withCookie, body: '{}' })).status, 401, 'logged-out cookie is dead');
    const sess = new AUTH.Sessions({ ttlMs: 1000, now: () => sess._t }); sess._t = 0; const ck = sess.create(); assert(sess.valid(ck)); sess._t = 999; assert(sess.valid(ck)); sess._t = 1001; assert(!sess.valid(ck), 'sessions expire'); assert(!sess.valid(ck.slice(0, -2) + 'xx') && !sess.valid('abc'));
    ws1.close(); await S.close();
    // rate limit on failed logins
    const S2 = await startServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nodegsm-web2-')), port: 0, token: TOKEN, maxFailures: 3, startCore: false }); const o2 = `http://127.0.0.1:${S2.port}`;
    const l2 = (t) => rq(S2.port, 'POST', '/login', { headers: { ...J, Origin: o2 }, body: JSON.stringify({ token: t }) });
    assert.strictEqual((await l2('bad-token-aaaaa')).status, 401); assert.strictEqual((await l2('bad-token-bbbbb')).status, 401); r = await l2('bad-token-ccccc'); assert(r.status === 429 && +r.headers['retry-after'] > 0, 'locked after repeated failures');
    assert.strictEqual((await l2(TOKEN)).status, 429, 'even the right token is refused while locked'); assert.strictEqual((await rq(S2.port, 'POST', '/api/list', { headers: { ...J, Authorization: 'Bearer ' + TOKEN }, body: '{}' })).status, 429, 'bearer is locked too');
    assert.strictEqual((await rq(S2.port, 'GET', '/healthz')).status, 200, 'healthz stays open'); await S2.close();
    // auth disabled is loopback only and still enforces same-origin
    const S3 = await startServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nodegsm-web3-')), port: 0, auth: false, startCore: false });
    assert.strictEqual((await rq(S3.port, 'POST', '/api/list', { headers: { ...J, Origin: 'http://evil.example' }, body: '{}' })).status, 403, 'no-auth mode still rejects cross-origin posts'); assert.strictEqual((await rq(S3.port, 'POST', '/api/list', { headers: { ...J, Origin: `http://127.0.0.1:${S3.port}` }, body: '{}' })).status, 200); await S3.close();
    const ha = require('../src/server/headless').parseArgs(['--port', '9000', '--host', '127.0.0.1', '--https'], {}); eq([ha.port, ha.https, ha.auth], [9000, true, true]); assert.throws(() => require('../src/server/headless').parseArgs(['--bogus'], {}));
    // files and docs exist
    for (const f of ['Dockerfile', '.dockerignore', 'docker-compose.example.yml', 'deploy/nodegsm.service', 'deploy/nginx.conf.example', 'docs/GUIDE-web-linux.md', 'src/renderer/transport-web.js', 'src/renderer/login.html', 'src/renderer/login.js']) assert(fs.existsSync(path.join(R, f)), f + ' exists');
    const df = fs.readFileSync(path.join(R, 'Dockerfile'), 'utf8'); assert(/node:20-slim/.test(df) && /USER /.test(df) && /VOLUME/.test(df) && /8730/.test(df) && /healthz/.test(df), 'Dockerfile basics');
    const pj9 = JSON.parse(fs.readFileSync(path.join(R, 'package.json'), 'utf8')); assert(pj9.scripts.serve && pj9.scripts['serve:dev'] && pj9.bin.nodegsm && /^\d+\.\d+\.\d+$/.test(pj9.dependencies.ws), 'package.json: serve scripts, bin and a pinned ws');
    fs.rmSync(hdir, { recursive: true, force: true });
  }

  console.log('smoke test passed');
  m.logTail.shutdown(); fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
