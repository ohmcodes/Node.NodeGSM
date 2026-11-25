'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const platform = require('./platform');

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'NodeGSM' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', reject);
    }).on('error', reject);
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'NodeGSM' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).toString()));
      }
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => (res.statusCode === 200 ? resolve(d) : reject(new Error(`HTTP ${res.statusCode}`))));
    }).on('error', reject);
  });
}

class SteamCMD {
  /** plat: process.platform value (injectable for tests). Windows: steamcmd.exe from the zip; Linux: steamcmd.sh from steamcmd_linux.tar.gz. */
  constructor(dataDir, plat = process.platform) {
    this.platform = plat;
    this.info = platform.steamcmdInfo(dataDir, plat);
    this.dir = this.info.dir;
    this.exe = this.info.exe;
  }

  async ensure(onLog = () => {}) {
    if (fs.existsSync(this.exe)) return;
    const archive = this.info.archive;
    onLog(`Downloading ${path.basename(archive)} ...`);
    await download(this.info.url, archive);
    if (this.info.kind === 'zip') new AdmZip(archive).extractAllTo(this.dir, true);
    else {
      const r = spawnSync('tar', platform.tarArgs(archive, this.dir), { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`Could not extract ${path.basename(archive)} (is tar installed?): ${String(r.stderr || '').trim()}`);
      platform.makeExecutable(this.exe, this.platform);
    }
    fs.unlinkSync(archive);
    onLog('SteamCMD extracted. Running first-time self-update ...');
    await new Promise((res) => {
      const p = spawn(this.exe, ['+quit'], { cwd: this.dir, windowsHide: true });
      p.stdout.on('data', (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach(onLog));
      p.on('error', res); p.on('close', res);
    });
  }

  /** Extra tokens after "validate": a plugin's update.validateArgs.steamcmd (plain words only, never "+commands"). */
  static validateTokens(text) {
    const t = String(text == null ? 'validate' : text).split(/\s+/).filter(Boolean);
    const ok = t.filter((x) => /^[A-Za-z0-9_.=-]{1,60}$/.test(x) && !x.startsWith('+'));
    return ok.length && ok.length === t.length ? ok : ['validate'];
  }

  buildArgs(installDir, appId, { validate = true, validateArgs, user, pass, beta, mod, repeat = 1, forcePlatform } = {}) {
    const a = [];
    // +@sSteamCmdForcePlatformType must come first; only added when the wanted platform differs from the host's
    if (forcePlatform && platform.steamPlatform(forcePlatform) !== platform.steamPlatform(this.platform)) a.push('+@sSteamCmdForcePlatformType', platform.steamPlatform(forcePlatform));
    a.push('+force_install_dir', installDir);
    a.push('+login', ...(user ? [user, pass || ''] : ['anonymous']));
    // GoldSource games are a "mod" of the HLDS app (90): +app_set_config 90 mod <game>
    if (mod) a.push('+app_set_config', '90', 'mod', mod);
    for (let i = 0; i < Math.max(1, repeat); i++) {
      a.push('+app_update', String(appId));
      if (beta) a.push('-beta', beta);
      if (validate) a.push(...SteamCMD.validateTokens(validateArgs));
    }
    a.push('+quit');
    return a;
  }

  /** Install or update an app. Returns promise of exit code. */
  async install(installDir, appId, opts = {}, onLog = () => {}) {
    await this.ensure(onLog);
    fs.mkdirSync(installDir, { recursive: true });
    const args = this.buildArgs(installDir, appId, opts);
    return new Promise((resolve) => {
      const p = spawn(this.exe, args, { cwd: this.dir, windowsHide: true });
      let lastPct = -10;
      const handle = (line) => {
        const m = /progress:\s*([\d.]+)\s*\((\d+)\s*\/\s*(\d+)\)/.exec(line);
        if (m) {
          const pct = parseFloat(m[1]);
          if (opts.onProgress) opts.onProgress({ percent: pct, done: +m[2], total: +m[3] });
          if (pct - lastPct < 1) return; // don't flood the console
          lastPct = pct;
        }
        onLog(line);
      };
      const pipe = (s) => s.on('data', (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach(handle));
      pipe(p.stdout); pipe(p.stderr);
      p.on('error', (e) => { onLog(`SteamCMD failed to start: ${e.message}`); resolve(-1); });
      p.on('close', (code) => resolve(code));
    });
  }

  /** Reads buildid from steamapps/appmanifest_<id>.acf */
  getLocalBuild(installDir, appId) {
    try {
      const f = path.join(installDir, 'steamapps', `appmanifest_${appId}.acf`);
      const m = /"buildid"\s+"(\d+)"/.exec(fs.readFileSync(f, 'utf8'));
      return m ? m[1] : null;
    } catch { return null; }
  }

  /** Public branch build id via steamcmd app_info_print */
  async getRemoteBuild(appId) {
    await this.ensure();
    return new Promise((resolve) => {
      const args = ['+login', 'anonymous', '+app_info_update', '1', '+app_info_print', String(appId), '+quit'];
      const p = spawn(this.exe, args, { cwd: this.dir, windowsHide: true });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('error', () => resolve(null));
      p.on('close', () => {
        const m = /"branches"\s*\{\s*"public"\s*\{\s*"buildid"\s*"(\d+)"/s.exec(out);
        resolve(m ? m[1] : null);
      });
    });
  }
}

module.exports = { SteamCMD, download, fetchText };
