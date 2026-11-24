'use strict';
// Headless smoke test of the server manager (no Electron, no network).
const fs = require('fs'); const os = require('os'); const path = require('path'); const assert = require('assert');
const { ServerManager } = require('../src/main/serverManager');
const { GAMES, splitArgs } = require('../src/main/games');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgsm-'));
const m = new ServerManager(dir);

assert(GAMES.length >= 40, 'catalog size');
for (const g of GAMES) { assert(g.id && g.name && g.exe, `bad entry ${g.id}`); assert(Array.isArray(g.args({ port: '1', param: 'a "b c"', map: 'x', name: 'n' }, { serverFiles: 'x' })), g.id); }
assert.deepStrictEqual(splitArgs('-a "b c" d'), ['-a', 'b c', 'd']);

// create + persist
const c = m.create('csgo', 'Test CSGO');
assert.strictEqual(c.id, '1'); assert.strictEqual(m.list().length, 1);
const c2 = m.create('csgo', 'Second'); assert.notStrictEqual(c.port, c2.port, 'port de-dup');

// launch args
const l = m.buildLaunch('1');
assert(l.args.includes('-game') && l.args.includes('+map'), 'source args');

// fake server: node script that echoes and exits on "quit"
const fakeDir = path.join(dir, 'fake'); fs.mkdirSync(fakeDir);
const g = GAMES.find((x) => x.id === 'sw'); // generic game, exe server.exe
fs.copyFileSync(process.execPath, path.join(fakeDir, g.exe));
fs.writeFileSync(path.join(fakeDir, 'x.js'), '');
(async () => {
  const s = m.importServer('sw', 'Fake', fakeDir);
  m.saveConfig(s.id, { param: '-e "process.stdin.on(\'data\',d=>{console.log(\'got \'+d);if(/quit/.test(d))process.exit(0)});console.log(\'hello\');setInterval(()=>{},1000)"' });
  await m.start(s.id);
  await new Promise((r) => setTimeout(r, 800));
  assert(m.getConsole(s.id).some((x) => x.includes('hello')), 'console captured');
  m.sendCommand(s.id, 'ping');
  await new Promise((r) => setTimeout(r, 300));
  assert(m.getConsole(s.id).some((x) => x.includes('got ping')), 'stdin works');
  await m.stop(s.id);
  assert.strictEqual(m.view(s.id).status, 'Stopped');
  const b = await m.backup(s.id); assert(m.backupList(s.id).length === 1 && b);
  await m.restore(s.id, b);
  // cron tick should not throw
  m.saveConfig(s.id, { restartCrontab: true, crontabFormat: '* * * * *' }); m.cronTick();
  await m.remove(s.id, true);
  const AdmZip=require('adm-zip');const P=require('../src/main/plugins');const z=new AdmZip();z.addLocalFolder(path.join(__dirname,'..','examples','palworld'),'palworld-plugin');const zf=path.join(dir,'p.zip');z.writeZip(zf);const id=m.installPlugin(zf);assert.strictEqual(id,'palworld');assert(GAMES.find(x=>x.id==='palworld'),'plugin loaded');const pc=m.create('palworld','My Pal');m.saveConfig(pc.id,{ip:'',name:'My Pal',param:'-publiclobby'});const pa=m.buildLaunch(pc.id).args;assert.deepStrictEqual(pa,['-publiclobby','-port=8211','-publicport=8211','-players=32','-servername=My Pal']);fs.mkdirSync(path.join(m.pluginsDir,'bad'));fs.writeFileSync(path.join(m.pluginsDir,'bad','plugin.json'),'{"id":"x"}');assert(m.reloadPlugins().errors.length===1,'bad plugin reported');console.log('smoke test passed');
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
