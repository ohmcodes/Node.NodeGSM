'use strict';
// Captures the screenshots used by README.md, FEATURES.md and the website landing page.
//   1. node src/server/headless.js --no-auth --port 8742 --data <throw-away folder>
//   2. node scripts/seed-demo.js http://127.0.0.1:8742 <same folder>      (demo servers, backups, cluster, log lines)
//   3. npx electron scripts/screenshots.js [8742 | http://127.0.0.1:8742] [docs/screenshots] [light|dark]
// The page is the real renderer talking to a real headless core, so the images show the actual app (no mock-ups).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const URL = /^\d+$/.test(process.argv[2] || '') ? 'http://127.0.0.1:' + process.argv[2] : (process.argv[2] || 'http://127.0.0.1:8742');
const OUT = path.resolve(process.argv[3] || path.join(__dirname, '..', 'docs', 'screenshots'));
const THEME = process.argv[4] || 'dark';
const W = 1440; const H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ width: W, height: H, useContentSize: true, show: false, backgroundColor: THEME === 'dark' ? '#0f1115' : '#ffffff', webPreferences: { contextIsolation: true, offscreen: false, zoomFactor: 1 } });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  let n = 0; const done = [];
  const shot = async (name, prep, wait = 900) => {
    if (prep) await js(prep);
    await sleep(wait);
    const img = await win.webContents.capturePage();
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    done.push(name); n++;
    console.log(`${String(n).padStart(2)}  ${name}.png  ${img.getSize().width}x${img.getSize().height}`);
  };
  const view = (v) => `setView(${JSON.stringify(v)})`;
  const heading = (text) => `(()=>{const h=[...document.querySelectorAll('#vSettings h4,#vDiscord h4')].find(x=>x.textContent.trim().startsWith(${JSON.stringify(text)}));if(h){h.scrollIntoView({block:'start'});}return !!h;})()`;
  /** collapse (true) or show (false) the right / bottom panels for one screenshot (DOM only, nothing is saved) */
  const panels = (right, bottom) => 'applyShell({ ui: { rightCollapsed: ' + right + ', bottomCollapsed: ' + bottom + ' } })';
  /** setView() saves the view, and the reply re-applies the saved panels, so collapse them a moment later */
  const later = (code) => 'setTimeout(() => { ' + code + '; if (typeof drawChart === "function" && document.body.dataset.view === "dashboard") drawChart(); }, 900)';
  const tab = (t) => `(async()=>{${panels(false, true)};state.tab=${JSON.stringify(t)};renderDetail();})()`;

  await win.loadURL(URL);
  await sleep(2500);
  await js(`document.documentElement.dataset.theme=${JSON.stringify(THEME)};0`).catch(() => {});

  // ---- Home ----
  await shot('01-server-list', `(async()=>{ ${view('servers')}; await select(${JSON.stringify(process.env.SHOT_SERVER || '1')}); state.tab='console'; renderDetail(); })()`, 1500);
  await shot('02-server-settings', tab('settings'));
  await shot('03-server-automation', tab('automation'));
  await shot('04-server-backups', tab('backups'), 1400);
  await shot('05-server-files', tab('files'), 1200);
  await shot('06-server-config-files', `(async()=>{${panels(false, true)};await select('1');state.tab='configs';renderDetail();setTimeout(()=>{const c=document.querySelector('.cfg-list [data-c]');if(c)c.click();},900);})()`, 2600);
  await shot('07-server-table', view('table') + ';' + later(panels(true, true)), 2200);
  await shot('08-configs', `setView('configs');cfv.sid='1';cfvFill();cfvOpen(true).then(()=>setTimeout(()=>{const c=document.querySelector('#cfBody [data-c]');if(c)c.click();},700))`, 3000);
  await shot('09-logs', view('logs'), 1400);
  await shot('10-backups', view('backups'), 1400);
  await shot('11-clusters', view('clusters'), 1400);

  // ---- System Metrics / Games ----
  await shot('12-system-metrics', view('dashboard') + ';' + later(panels(true, true)) + ';(()=>{const c=document.querySelector("#dChart");if(c&&[...c.options].some(o=>o.value==="cpu")){c.value="cpu";c.onchange&&c.onchange();c.dispatchEvent(new Event("change"));}})()', 3000);
  await js(panels(false, false)).catch(() => {});
  await shot('13-games-plugins', view('plugins') + ';setTimeout(()=>{const e=[...document.querySelectorAll("#vPlugins [data-g], #vPlugins .game, #vPlugins .row, #vPlugins li, #vPlugins div")].filter(x=>x.children.length<6&&/Valheim Dedicated Server/.test(x.textContent)&&x.textContent.length<120).pop();if(e)e.click();},900)', 3200);
  await shot('14-add-server', `(async()=>{ openAdd('valheim'); })()`, 2200);
  await js(`document.querySelectorAll('dialog[open]').forEach(d=>d.close());document.querySelectorAll('.modal,.overlay').forEach(d=>{if(d.classList)d.classList.remove('open','show')});0`).catch(() => {});

  // ---- Settings ----
  await shot('15-settings-appearance', `(async()=>{ ${view('settings')}; })()`, 1400);
  await shot('16-settings-web-access', heading('Web access'), 900);

  // ---- Discord ----
  await shot('17-discord-webhook', view('discord'), 3200);
  await shot('18-discord-embed-editor', heading('Preview'), 1200);
  await shot('19-discord-bot', heading('Bot (slash commands)'), 900);

  // ---- Web sign-in pages (optional): a second, throw-away server WITH authentication ----
  //   node src/server/headless.js --port 8743 --data <another throw-away folder>
  //   then run this script with SHOT_AUTH=8743 SHOT_AUTH_DATA=<that folder>
  if (process.env.SHOT_AUTH && process.env.SHOT_AUTH_DATA) {
    const base = 'http://127.0.0.1:' + process.env.SHOT_AUTH;
    const token = fs.readFileSync(path.join(process.env.SHOT_AUTH_DATA, 'web-token'), 'utf8').trim();
    const pass = require('crypto').randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, 'x') + 'Q7';   // throw-away password for the throw-away server
    const post = (p, body) => js(`fetch(${JSON.stringify(p)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then((r) => r.status)`);
    await win.loadURL(base + '/login.html'); await sleep(1500);
    await shot('20-web-setup', null, 600);
    await post('/setup', { token, username: 'owner', password: pass });
    await post('/logout', {});
    await win.loadURL(base + '/login.html'); await sleep(1500);
    await shot('21-web-login', null, 600);
    await post('/login', { username: 'owner', password: pass });
    await win.loadURL(base + '/account.html'); await sleep(2000);
    await shot('22-web-account', null, 800);
  }

  console.log(`\n${n} screenshots in ${OUT}`);
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
