'use strict';
// Custom (non-SteamCMD) installers: Minecraft Java, Vintage Story, FiveM
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { download, fetchText } = require('./steamcmd');

async function minecraftJava(dir, log) {
  log('Querying Mojang version manifest ...');
  const manifest = JSON.parse(await fetchText('https://launchermeta.mojang.com/mc/game/version_manifest.json'));
  const latest = manifest.latest.release;
  const entry = manifest.versions.find((v) => v.id === latest);
  const ver = JSON.parse(await fetchText(entry.url));
  const url = ver.downloads.server.url;
  log(`Downloading Minecraft server ${latest} ...`);
  await download(url, path.join(dir, 'server.jar'));
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(dir, '.wgsm-version'), latest);
  log(`Minecraft ${latest} installed (eula.txt written with eula=true - you accept Mojang's EULA by using this server).`);
}
minecraftJava.latest = async () => JSON.parse(await fetchText('https://launchermeta.mojang.com/mc/game/version_manifest.json')).latest.release;
minecraftJava.local = (dir) => { try { return fs.readFileSync(path.join(dir, '.wgsm-version'), 'utf8').trim(); } catch { return null; } };

async function vintageStory(dir, log) {
  log('Querying Vintage Story versions ...');
  const data = JSON.parse(await fetchText('https://api.vintagestory.at/stable.json'));
  const versions = Object.keys(data).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const v = versions[0];
  const zip = path.join(dir, 'vs.zip');
  log(`Downloading Vintage Story ${v} ...`);
  await download(`https://cdn.vintagestory.at/gamefiles/stable/vs_server_win-x64_${v}.zip`, zip);
  new AdmZip(zip).extractAllTo(dir, true);
  fs.unlinkSync(zip);
  fs.writeFileSync(path.join(dir, '.wgsm-version'), v);
  log(`Vintage Story ${v} installed.`);
}
vintageStory.latest = async () => {
  const data = JSON.parse(await fetchText('https://api.vintagestory.at/stable.json'));
  return Object.keys(data).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
};
vintageStory.local = minecraftJava.local;

async function fivem(dir, log) {
  log('Querying FiveM artifacts ...');
  const base = 'https://runtime.fivem.net/artifacts/fivem/build_server_windows/master/';
  const html = await fetchText(base);
  const m = [...html.matchAll(/href="\.\/(\d+-[0-9a-f]+)\/server\.7z"/g)];
  if (!m.length) throw new Error('Could not locate FiveM server artifact');
  const latest = m.map((x) => x[1]).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).pop();
  const target = path.join(dir, 'server');
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(dir, 'server.7z');
  log(`Downloading FiveM ${latest} (server.7z) ...`);
  await download(`${base}${latest}/server.7z`, file);
  log('server.7z downloaded. Extracting needs 7-Zip (tar can read 7z on Win11) ...');
  const { spawnSync } = require('child_process');
  const r = spawnSync('tar', ['-xf', file, '-C', target], { windowsHide: true });
  if (r.status !== 0) throw new Error('Extraction failed - install 7-Zip and extract server.7z into the "server" folder manually.');
  fs.unlinkSync(file);
  fs.writeFileSync(path.join(dir, '.wgsm-version'), latest);
  log('FiveM installed. Place your server.cfg in the server folder.');
}
fivem.local = minecraftJava.local;

const INSTALLERS = {
  'minecraft-java': minecraftJava,
  vintagestory: vintageStory,
  fivem,
  'minecraft-bedrock': async () => { throw new Error('Minecraft Bedrock must be downloaded from minecraft.net - use Import to point at an existing install.'); },
  manual: async () => { throw new Error('This server has no automatic installer - use Import to point at an existing install.'); },
};

module.exports = { INSTALLERS };
