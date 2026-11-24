'use strict';
// Game server catalog, ported from WindowsGSM's GameServer/*.cs
// Each entry describes how to install (SteamCMD appId or custom installer), launch and query a server.

const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';

// ---- Argument builders per engine -------------------------------------------------------------
const sourceArgs = (c, g) => {
  const a = ['-console'];
  if (g.game) a.push('-game', g.game);
  if (has(c.ip)) a.push('-ip', c.ip);
  if (has(c.port)) a.push('-port', c.port);
  if (has(c.maxPlayers)) a.push(g.appId === '740' ? '-maxplayers_override' : '-maxplayers', c.maxPlayers);
  if (has(c.gslt)) a.push('+sv_setsteamaccount', c.gslt);
  return a;
};
const tail = (c, flag = '+map') => {
  const a = [];
  if (has(c.param)) a.push(...splitArgs(c.param));
  if (has(c.map)) a.push(flag, c.map);
  return a;
};

// Split a parameter string honoring double quotes
function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

const ENGINES = {
  source: {
    exe: 'srcds.exe',
    additional: '-nocrashdialog',
    args: (c, g) => [...sourceArgs(c, g), ...tail(c)],
  },
  goldsource: {
    exe: 'hlds.exe',
    additional: '',
    args: (c, g) => {
      const a = sourceArgs(c, g);
      const p = (c.param || '');
      const out = p.includes('-game ') ? a.filter((x, i) => !(x === '-game' || a[i - 1] === '-game')) : a;
      return [...out, ...tail(c)];
    },
  },
  unity: {
    args: (c) => ['-batchmode', '-nographics', '-silent-crashes', ...splitArgs(c.param)],
  },
  generic: {
    args: (c) => splitArgs(c.param),
  },
};

// ---- Catalog ----------------------------------------------------------------------------------
const src = (id, name, icon, appId, game, map, extra = {}) => ({
  id, name, icon, engine: 'source', appId, game, port: '27015', queryPort: '27015',
  map, maxPlayers: '24', additional: '-nocrashdialog', query: 'a2s', gslt: true, ...extra,
});
const gold = (id, name, icon, appId, game, map) => ({
  id, name, icon, engine: 'goldsource', appId, game, port: '27015', queryPort: '27015',
  map, maxPlayers: '24', additional: '', query: 'a2s', ...{ exe: 'hlds.exe' },
});
const unity = (id, name, icon, appId, exe, port, queryPort, map, maxPlayers, additional = '', query = null) => ({
  id, name, icon, engine: 'unity', appId, exe, port, queryPort, map, maxPlayers, additional, query,
});
const gen = (id, name, icon, appId, exe, port, queryPort, map, maxPlayers, additional, argsFn, query = 'a2s') => ({
  id, name, icon, engine: 'generic', appId, exe, port, queryPort, map, maxPlayers, additional, query, args: argsFn,
});

const opt = (s, v, f) => (has(v) ? f(v) : []);

const GAMES = [
  gen('7dtd', '7 Days to Die Dedicated Server', '7dtd', '294420', '7DaysToDieServer.exe', '26900', '26900', 'Navezgane', '8', '',
    (c) => ['-logfile', 'output_log.txt', '-quit', '-batchmode', '-nographics', '-dedicated', '-configfile=serverconfig.xml', ...splitArgs(c.param)], null),
  gen('arkse', 'ARK: Survival Evolved Dedicated Server', 'arkse', '376030', 'ShooterGame\\Binaries\\Win64\\ShooterGameServer.exe', '7777', '27015', 'TheIsland', '16', '',
    (c) => [(c.map || '') + '?listen' + (has(c.name) ? `?SessionName="${c.name}"` : '') + (has(c.ip) ? `?MultiHome=${c.ip}` : '') +
      (has(c.port) ? `?Port=${c.port}` : '') + (has(c.maxPlayers) ? `?MaxPlayers=${c.maxPlayers}` : '') +
      (has(c.queryPort) ? `?QueryPort=${c.queryPort}` : '') + (c.param ? c.param.startsWith('?') ? c.param : ' ' + c.param : ''), '-server', '-log']),
  gen('avorion', 'Avorion Dedicated Server', 'avorion', '565060', 'bin\\AvorionServer.exe', '27000', '27003', 'avorion_galaxy', '10', '--admin avorion_admin',
    (c) => [...opt('', c.map, (m) => ['--galaxy-name', m]), ...opt('', c.name, (n) => ['--server-name', n]), ...opt('', c.ip, (i) => ['--ip', i]),
      ...opt('', c.port, (p) => ['--port', p]), ...opt('', c.queryPort, (p) => ['--query-port', p]), ...opt('', c.maxPlayers, (p) => ['--max-players', p]), ...splitArgs(c.param)], null),
  gen('bt', 'Barotrauma Dedicated Server', 'bt', '1026340', 'DedicatedServer.exe', '27015', '27016', 'Casual', '10', '', (c) => splitArgs(c.param), null),
  gen('bw', 'BlackWake Dedicated Server', 'bw', '423410', 'BlackwakeServer.exe', '25001', '25002', 'Island', '54', '',
    (c) => ['-batchmode', '-nographics', ...splitArgs(c.param)], null),
  gen('ce', 'Conan Exiles Dedicated Server', 'ce', '443030', 'ConanSandbox\\Binaries\\Win64\\ConanSandboxServer-Win64-Shipping.exe', '7777', '27015', 'game.db', '40', '',
    (c) => [...opt('', c.ip, (i) => [`-MultiHome=${i}`]), ...opt('', c.port, (p) => [`-Port=${p}`]), ...opt('', c.queryPort, (p) => [`-QueryPort=${p}`]),
      ...opt('', c.maxPlayers, (p) => [`-MaxPlayers=${p}`]), ...splitArgs(c.param), '-log']),
  src('cs', 'Counter-Strike: 1.6 Dedicated Server', 'cs', '10', 'cstrike', 'de_dust2', { engine: 'goldsource', exe: 'hlds.exe', additional: '', gslt: false }),
  src('cscz', 'Counter-Strike: Condition Zero Dedicated Server', 'cscz', '80', 'czero', 'de_dust2', { engine: 'goldsource', exe: 'hlds.exe', additional: '', gslt: false }),
  src('csgo', 'Counter-Strike: Global Offensive Dedicated Server', 'csgo', '740', 'csgo', 'de_dust2',
    { additional: '-tickrate 64 -usercon +game_type 0 +game_mode 0 +mapgroup mg_active' }),
  src('css', 'Counter-Strike: Source Dedicated Server', 'css', '232330', 'cstrike', 'de_dust2', { additional: '-tickrate 64' }),
  gen('dayz', 'DayZ Dedicated Server', 'dayz', '223350', 'DayZServer_x64.exe', '2302', '27016', 'dayzOffline.chernarusplus', '60',
    '-config=serverDZ.cfg -doLogs -adminLog -netLog',
    (c) => [...opt('', c.ip, (i) => [`-ip=${i}`]), ...opt('', c.port, (p) => [`-port=${p}`]), ...splitArgs(c.param)]),
  src('dmc', 'Deathmatch Classic Dedicated Server', 'dmc', '40', 'dmc', 'dcdm5', { engine: 'goldsource', exe: 'hlds.exe', additional: '', gslt: false }),
  src('dod', 'Day of Defeat Dedicated Server', 'dod', '30', 'dod', 'dod_Anzio', { engine: 'goldsource', exe: 'hlds.exe', additional: '', gslt: false }),
  src('dods', 'Day of Defeat: Source Dedicated Server', 'dods', '232290', 'dod', 'dod_anzio'),
  unity('eco', 'Eco Dedicated Server', 'eco', '739590', 'EcoServer.exe', '3000', '3001', '', '-1'),
  gen('egs', 'Empyrion - Galactic Survival Dedicated Server', 'egs', '530870', 'EmpyrionLauncher.exe', '30000', '30001', 'DediGame', '8', '-dedicated dedicated.yaml',
    (c) => ['-batchmode', ...splitArgs(c.param)], null),
  src('gmod', "Garry's Mod Dedicated Server", 'gmod', '4020', 'garrysmod', 'gm_construct', { additional: '-tickrate 66 +gamemode sandbox +host_workshop_collection' }),
  gen('gta5', 'Grand Theft Auto V Dedicated Server (FiveM)', 'gta5', null, 'server\\FXServer.exe', '30120', '30120', 'fivem-map-skater', '32', '+exec server.cfg',
    (c, ctx) => ['+set', 'citizen_dir', `${ctx.serverFiles}\\citizen`, ...splitArgs(c.param)], 'fivem'),
  src('hl2dm', 'Half-Life 2: Deathmatch Dedicated Server', 'hl2dm', '232370', 'hl2mp', 'dm_runoff', { additional: '+mp_teamplay 1' }),
  src('hlof', 'Half-Life: Opposing Force Dedicated Server', 'hlof', '50', 'gearbox', 'op4_bootcamp', { engine: 'goldsource', exe: 'hlds.exe', additional: '', gslt: false }),
  unity('heat', 'Heat Dedicated Server', 'heat', '996600', 'Heat.exe', '7450', '7450', 'America', '40'),
  src('ins', 'Insurgency Dedicated Server', 'ins', '237410', 'insurgency', 'market skirmish', { additional: '-usercon' }),
  gen('inss', 'Insurgency: Sandstorm Dedicated Server', 'inss', '581330', 'Insurgency\\Binaries\\Win64\\InsurgencyServer-Win64-Shipping.exe', '27102', '27131', 'Oilfield', '28',
    '?Scenario=Scenario_Refinery_Push_Security',
    (c) => [(c.map || '') + (c.param || '') + (has(c.maxPlayers) ? `?MaxPlayers=${c.maxPlayers}` : ''),
      ...opt('', c.port, (p) => [`-Port=${p}`]), ...opt('', c.queryPort, (p) => [`-QueryPort=${p}`]),
      ...opt('', c.ip, (i) => [`-MultiHome=${i}`]), ...opt('', c.name, (n) => [`-hostname=${n}`]), '-log']),
  src('l4d2', 'Left 4 Dead 2 Dedicated Server', 'l4d2', '222860', 'left4dead2', 'c1m1_hotel'),
  {
    id: 'mc', name: 'Minecraft: Java Edition Server', icon: 'mc', engine: 'custom', installer: 'minecraft-java', appId: null,
    exe: 'server.jar', port: '25565', queryPort: '25565', map: 'world', maxPlayers: '20', additional: '-Xmx1024M -Xms1024M', query: 'ut3',
    args: (c) => [...splitArgs(c.param), '-jar', 'server.jar', 'nogui'], launcher: 'java',
  },
  {
    id: 'mcbe', name: 'Minecraft: Bedrock Edition Server', icon: 'mcbe', engine: 'custom', installer: 'minecraft-bedrock', appId: null,
    exe: 'bedrock_server.exe', port: '19132', queryPort: '19132', map: 'Bedrock level', maxPlayers: '10', additional: '', query: null,
    args: () => [],
  },
  {
    id: 'mcpe', name: 'Minecraft: Pocket Edition Server (PocketMine-MP)', icon: 'mcpe', engine: 'custom', installer: 'manual', appId: null,
    exe: 'bin\\php\\php.exe', port: '19132', queryPort: '19132', map: 'world', maxPlayers: '20', additional: '', query: 'ut3',
    args: (c) => ['PocketMine-MP.phar', ...splitArgs(c.param)],
  },
  gen('mordhau', 'Mordhau Dedicated Server', 'mordhau', '629800', 'Mordhau\\Binaries\\Win64\\MordhauServer-Win64-Shipping.exe', '7777', '27015', 'FFA_ThePit', '16', '-BeaconPort={{beaconport}}',
    (c) => [c.map || '', ...opt('', c.ip, (i) => [`-MultiHome=${i}`]), ...opt('', c.port, (p) => [`-Port=${p}`]), ...opt('', c.queryPort, (p) => [`-QueryPort=${p}`]),
      ...splitArgs((c.param || '').replace('{{beaconport}}', String(parseInt(c.port || '7777', 10) + 10 || 15000))), '-log'].filter(Boolean)),
  src('nmrih', 'No More Room in Hell Dedicated Server', 'nmrih', '317670', 'nmrih', 'nmo_broadway'),
  gen('olow', 'Outlaws of the Old West Dedicated Server', 'olow', '915070', 'Outlaws\\Binaries\\Win64\\OutlawsServer-Win64-Shipping.exe', '27374', '27015', '/Game/Maps/MainMap/MainMap', '24',
    '-Type=PVP -ServerPassword="" -AdminPassword=""',
    (c) => [c.map || '', ...opt('', c.port, (p) => [`-port=${p}`]), ...opt('', c.name, (n) => [`-servername=${n}`]),
      ...opt('', c.maxPlayers, (p) => [`-PlayerCount=${p}`]), ...opt('', c.queryPort, (p) => [`-queryport=${p}`]), ...splitArgs(c.param), '-log'].filter(Boolean)),
  gen('onset', 'Onset Dedicated Server', 'onset', '1204170', 'OnsetServer.exe', '7777', '7776', '', '100', '', (c) => splitArgs(c.param), null),
  gen('ps', 'Post Scriptum Dedicated Server', 'ps', '746200', 'PostScriptum\\Binaries\\Win64\\PostScriptumServer.exe', '10027', '10037', '', '80', 'RANDOM=ALWAYS -fullcrashdump',
    (c) => ['-log', ...opt('', c.ip, (i) => [`MULTIHOME=${i}`]), ...opt('', c.port, (p) => [`Port=${p}`]), ...opt('', c.queryPort, (p) => [`QueryPort=${p}`]),
      ...opt('', c.maxPlayers, (p) => [`FIXEDMAXPLAYERS=${p}`]), ...splitArgs(c.param)]),
  src('rcc', 'Ricochet Dedicated Server', 'rcc', '60', 'ricochet', 'rc_arena', { engine: 'goldsource', exe: 'hlds.exe', additional: '', gslt: false }),
  unity('rok', 'Reign Of Kings Dedicated Server', 'rok', '381690', 'ROK.exe', '7350', '7350', 'CrownLand', '30', '', null),
  unity('ror2', 'Risk of Rain 2 Dedicated Server', 'ror2', '1180760', 'Risk of Rain 2.exe', '27015', '27016', '', '4', '', 'a2s'),
  gen('rust', 'Rust Dedicated Server', 'rust', '258550', 'RustDedicated.exe', '28015', '28016', 'Procedural Map', '50', '',
    (c) => ['-nographics', '-batchmode', '-silent-crashes',
      ...opt('', c.name, (n) => ['+server.hostname', n]), ...opt('', c.ip, (i) => ['+server.ip', i]), ...opt('', c.port, (p) => ['+server.port', p]),
      ...opt('', c.queryPort, (p) => ['+server.queryport', p]), ...opt('', c.map, (m) => ['+server.level', m]),
      ...opt('', c.maxPlayers, (p) => ['+server.maxplayers', p]), ...splitArgs(c.param)]),
  gen('se', 'Space Engineers Dedicated Server', 'se', '298740', 'DedicatedServer64\\SpaceEngineersDedicated.exe', '27016', '27017', 'world', '4', '',
    (c) => ['-noconsole', '-ignorelastsession', ...opt('', c.ip, (i) => ['-ip', i]), ...opt('', c.port, (p) => ['-port', p]), ...splitArgs(c.param)]),
  gen('sq', 'Squad Dedicated Server', 'sq', '403240', 'SquadGame\\Binaries\\Win64\\SquadGameServer.exe', '7787', '27165', '', '80', 'RANDOM=ALWAYS',
    (c) => ['-log', ...opt('', c.ip, (i) => [`MULTIHOME=${i}`]), ...opt('', c.port, (p) => [`Port=${p}`]), ...opt('', c.queryPort, (p) => [`QueryPort=${p}`]),
      ...opt('', c.maxPlayers, (p) => [`FIXEDMAXPLAYERS=${p}`]), ...splitArgs(c.param)]),
  gen('sw', 'Stormworks Dedicated Server', 'sw', '1247090', 'server.exe', '25564', '25564', 'data/tiles/island12.xml', '32', '', (c) => splitArgs(c.param), null),
  src('tf2', 'Team Fortress 2 Dedicated Server', 'tf2', '232250', 'tf', 'cp_badlands'),
  src('tfc', 'Team Fortress Classic Dedicated Server', 'tfc', '20', 'tfc', 'dustbowl', { engine: 'goldsource', exe: 'hlds.exe', additional: '', gslt: false }),
  gen('tf', 'The Forest Dedicated Server', 'tf', '556450', 'TheForestDedicatedServer.exe', '27015', '27016', '', '4', '-configfilepath "Server.cfg"',
    (c) => ['-batchmode', '-dedicated', ...splitArgs(c.param)], null),
  gen('unt', 'Unturned Dedicated Server', 'unt', '1110390', 'Unturned.exe', '27015', '27016', 'pei', '20', '+secureserver/Default',
    (c) => ['-batchmode', '--nographics', ...opt('', c.port, (p) => [`-port:${p}`]), ...opt('', c.maxPlayers, (p) => [`-players:${p}`]),
      ...opt('', c.map, (m) => [`-${m}`]), ...splitArgs(c.param)]),
  {
    id: 'vts', name: 'Vintage Story Dedicated Server', icon: 'vts', engine: 'custom', installer: 'vintagestory', appId: null,
    exe: 'VintageStoryServer.exe', port: '42420', queryPort: '42420', map: 'default', maxPlayers: '16', additional: '--dataPath ./data', query: null,
    args: (c) => splitArgs(c.param),
  },
  src('zps', 'Zombie Panic Source Dedicated Server', 'zps', '17505', 'zps', 'zps_cinema'),
];

// Normalise: attach exe / args from engine defaults
for (const g of GAMES) {
  const eng = ENGINES[g.engine] || {};
  g.exe = g.exe || eng.exe;
  if (!g.args) g.args = (c) => eng.args(c, g);
  g.supported = true;
  if (g.id === 'gta5') g.installer = 'fivem';
}

const byId = (id) => GAMES.find((g) => g.id === id);

module.exports = { GAMES, byId, splitArgs, q };
