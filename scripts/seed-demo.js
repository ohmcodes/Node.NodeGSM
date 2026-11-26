'use strict';
// Fills a RUNNING NodeGSM web server (started with --no-auth on loopback and a throw-away --data folder) with demo servers,
// backups, clusters and log lines so that `scripts/screenshots.js` has something to show. Never point it at real data.
//   node src/server/headless.js --no-auth --port 8742 --data <tmp>   then   node scripts/seed-demo.js [http://127.0.0.1:8742]
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:8742';
if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(BASE)) { console.error('Refusing: demo data only goes to a loopback server.'); process.exit(2); }

async function api(name, ...args) {
  const r = await fetch(`${BASE}/api/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ args }) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${name}: ${j.error}`);
  return j.data;
}

const SERVERS = [
  { game: 'mc', name: 'Survival World', port: 25565, maxPlayers: 20 },
  { game: 'mc', name: 'Creative Plots', port: 25566, maxPlayers: 12 },
  { game: 'mc', name: 'Skyblock', port: 25567, maxPlayers: 16 },
  { game: 'valheim', name: 'Viking Hall', port: 2456, maxPlayers: 10 },
  { game: 'rust', name: 'Rust Weekly Wipe', port: 28015, maxPlayers: 100 },
  { game: 'palworld', name: 'Pal Ranch', port: 8211, maxPlayers: 32 },
  { game: 'terraria', name: 'Terraria Co-op', port: 7777, maxPlayers: 8 },
  { game: 'factorio', name: 'Factory Must Grow', port: 34197, maxPlayers: 6 },
];

(async () => {
  const games = (await api('games')).map((g) => g.id);
  const made = [];
  for (const s of SERVERS) {
    if (!games.includes(s.game)) { console.log(`skip ${s.name}: plugin ${s.game} not found`); continue; }
    const v = await api('create', s.game, s.name);
    await api('save', v.id, { port: s.port, maxPlayers: s.maxPlayers });
    made.push({ ...s, id: String(v.id) });
  }
  console.log(`servers: ${made.map((m) => `${m.id}=${m.name}`).join(', ')}`);

  // a few fake files so backups, the Files tab and cluster sync have content
  const settings = await api('settings');
  const dataDir = process.argv[3] || process.env.NODEGSM_DATA;
  if (!dataDir) throw new Error('pass the data folder as the 2nd argument (or NODEGSM_DATA)');
  for (const m of made) {
    const files = path.join(dataDir, 'servers', m.id, 'serverfiles');
    fs.mkdirSync(path.join(files, 'logs'), { recursive: true });
    if (m.game === 'mc') {
      fs.mkdirSync(path.join(files, 'world', 'region'), { recursive: true });
      fs.writeFileSync(path.join(files, 'server.properties'), `motd=${m.name}\nserver-port=${m.port}\nmax-players=${m.maxPlayers}\ndifficulty=normal\nview-distance=10\nwhite-list=false\n`);
      fs.writeFileSync(path.join(files, 'world', 'level.dat'), Buffer.alloc(20000, 7));
      fs.writeFileSync(path.join(files, 'world', 'region', 'r.0.0.mca'), Buffer.alloc(180000, 3));
      fs.writeFileSync(path.join(files, 'logs', 'latest.log'), '[18:02:11] [Server thread/INFO]: Done (4.2s)! For help, type "help"\n');
    } else {
      fs.writeFileSync(path.join(files, 'server.cfg'), `name=${m.name}\nport=${m.port}\n`);
    }
  }

  // backups for the first minecraft server and the Valheim one
  const mc = made.find((m) => m.game === 'mc');
  const vh = made.find((m) => m.game === 'valheim');
  for (const m of [mc, vh].filter(Boolean)) {
    try { await api('backup', m.id, { mode: 'full' }); await api('backup', m.id, { mode: 'full' }); } catch (e) { console.log(`backup ${m.name}: ${e.message}`); }
  }

  // a cluster of the three Minecraft servers
  const mcIds = made.filter((m) => m.game === 'mc').map((m) => m.id);
  if (mcIds.length >= 2) {
    try { await api('clusterCreate', { name: 'Minecraft network', game: 'mc', parentId: mcIds[0], memberIds: mcIds }); } catch (e) { console.log(`cluster: ${e.message}`); }
  }

  // event log lines (JSONL, same format the app writes)
  const logDir = path.join(dataDir, 'logs'); fs.mkdirSync(logDir, { recursive: true });
  const now = Date.now(); const rows = [];
  const add = (minAgo, level, event, m, message, detail) => rows.push({ ts: new Date(now - minAgo * 60000).toISOString(), level, event, serverId: m ? m.id : undefined, serverName: m ? m.name : undefined, message, detail });
  const rust = made.find((m) => m.game === 'rust'); const pal = made.find((m) => m.game === 'palworld');
  add(190, 'info', 'app:start', null, 'NodeGSM started');
  add(180, 'info', 'server:start', mc, 'Server started');
  add(176, 'info', 'game:player-join', mc, 'Steve joined the game');
  add(170, 'info', 'game:player-join', mc, 'Alex joined the game');
  add(120, 'info', 'server:backup', mc, 'Backup created: backup-demo.zip (full)');
  add(95, 'warn', 'server:update-available', vh, 'A new Valheim build is available');
  add(80, 'info', 'server:update', vh, 'Update finished');
  add(60, 'error', 'server:crash', rust, 'Server stopped unexpectedly (exit code 1); restarting (1/3)');
  add(59, 'info', 'server:start', rust, 'Server started (auto-restart)');
  add(40, 'warn', 'pattern:lag', pal, 'Server tick is lagging: 41 ms');
  add(25, 'info', 'cluster:update', mc, 'Cluster "Minecraft network" updated (3 servers)');
  add(10, 'info', 'discord:sent', null, 'Discord alert sent: server started');
  const day = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(path.join(logDir, `ngsm-${day}.log`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // look: dark theme, header info on, a Discord webhook placeholder that never leaves the machine
  await api('saveSettings', { theme: 'dark' });
  console.log('settings theme:', settings.theme, '-> dark');
  console.log('done');
})().catch((e) => { console.error(e.message); process.exit(1); });
