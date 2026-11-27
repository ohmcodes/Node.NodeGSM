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
    // a signed-in account without a password uses the login SteamCMD cached (Settings > Steam account)
    a.push('+login', ...(user ? (pass ? [user, pass] : [user]) : ['anonymous']));
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

  /**
   * Sign in once so SteamCMD caches the login (its own token in <steamcmd>/config, no password is kept by NodeGSM).
   * Resolves { ok, needGuard?, error?, output } - never rejects. The password and the Steam Guard code only go to SteamCMD's command line
   * (stdin is closed, so SteamCMD cannot wait for a prompt) and are never logged or returned.
   */
  async login({ user, pass, code }, onLog = () => {}) {
    if (!/^[A-Za-z0-9_.@-]{2,64}$/.test(String(user || ''))) return { ok: false, error: 'Enter the Steam account name (not the e-mail address of a different service).' };
    if (!pass || typeof pass !== 'string' || pass.length > 200 || /[\r\n\0]/.test(pass)) return { ok: false, error: 'Enter the password of the Steam account.' };
    if (code !== undefined && code !== '' && !/^[A-Za-z0-9]{4,10}$/.test(String(code))) return { ok: false, error: 'The Steam Guard code is 5 letters / digits.' };
    await this.ensure(onLog);
    const args = ['+login', user, pass, ...(code ? [String(code)] : []), '+quit'];
    onLog('Signing in to Steam as ' + user + ' ...');
    return new Promise((resolve) => {
      const p = spawn(this.exe, args, { cwd: this.dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, this.loginTimeoutMs || 90000);
      const take = (d) => { out += d.toString(); };
      p.stdout.on('data', take); p.stderr.on('data', take);
      p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: 'SteamCMD failed to start: ' + e.message }); });
      p.on('close', () => { clearTimeout(timer); resolve(SteamCMD.parseLogin(out, pass, code)); });
    });
  }

  /** Reads the outcome of a sign-in from SteamCMD's output. */
  static parseLogin(output, pass, code) {
    let text = String(output || '');
    if (pass && String(pass).length >= 6) text = text.split(pass).join('***');   // SteamCMD does not echo it, but never let it through (Steam passwords have 8+ characters)
    const tail = text.split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
    if (/Logged in OK|Waiting for user info\.\.\.OK/i.test(text)) return { ok: true, output: tail };
    if (/Rate Limit Exceeded|Too many login failures/i.test(text)) return { ok: false, error: 'Steam is rate limiting sign-ins. Wait a few minutes and try again.', output: tail };
    if (/Invalid Password|InvalidPassword/i.test(text)) return { ok: false, error: 'Steam says the account name or the password is wrong.', output: tail };
    if (/Two-factor code mismatch|Invalid Login Auth Code|ExpiredLoginAuthCode|Login Auth Code/i.test(text) && code) return { ok: false, needGuard: true, error: 'The Steam Guard code was wrong or expired. Enter a fresh one.', output: tail };
    if (/Steam Guard|Two-factor|Account Logon Denied|need.*guard/i.test(text)) return { ok: false, needGuard: true, error: 'Steam Guard: enter the code from your e-mail or the Steam mobile app, then sign in again.', output: tail };
    return { ok: false, error: 'Sign-in failed: ' + (tail.split('\n').pop() || 'no answer from SteamCMD'), output: tail };
  }

  /** Forget the cached login (best effort). */
  async logout() {
    try { await this.ensure(); } catch { return; }
    await new Promise((resolve) => {
      const p = spawn(this.exe, ['+logout', '+quit'], { cwd: this.dir, windowsHide: true, stdio: 'ignore' });
      p.on('error', resolve); p.on('close', resolve); setTimeout(resolve, 30000).unref();
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
