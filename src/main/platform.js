'use strict';
// Platform layer: everything that differs between Windows and Linux lives here (process-tree kill, per-process CPU / RAM,
// CPU affinity, SteamCMD location and archive, firewall, default data folder, executable bit).
// Windows behaviour is unchanged from earlier versions. Linux code paths are unit-tested only (see docs/GUIDE-web-linux.md).
// The functions take their platform / system access as optional arguments so tests can inject fakes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFile } = require('child_process');
const dataLocation = require('./dataLocation');

const ALL = ['windows', 'linux'];

/** 'windows' | 'linux' | 'macos' (macOS is not supported but is named so messages are sensible). */
function current(p = process.platform) { return p === 'win32' ? 'windows' : p === 'linux' ? 'linux' : p === 'darwin' ? 'macos' : p; }
const isWindows = (p) => current(p) === 'windows';

// ---------- data folder ----------
/**
 * Default data folder. env NODEGSM_DATA / WGSM_DATA always win.
 * Windows: the legacy %APPDATA%\node-wgsm2026\WGSM if it exists, else %APPDATA%\NodeGSM.
 * Linux / other: $XDG_DATA_HOME/NodeGSM or ~/.local/share/NodeGSM.
 */
function defaultDataDir({ platform = process.platform, env = process.env, appData, home = os.homedir(), exists = fs.existsSync, readPointer = dataLocation.readPointer } = {}) {
  if (env.NODEGSM_DATA) return env.NODEGSM_DATA;
  if (env.WGSM_DATA) return env.WGSM_DATA;
  const chosen = readPointer({ platform, env, appData, home });   // Settings -> Data location / the installer
  if (chosen) return chosen;
  if (current(platform) === 'windows') {
    const base = appData || env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const legacy = path.join(base, 'node-wgsm2026', 'WGSM');   // folder of the pre-NodeGSM builds; Settings can move it to NodeGSM
    return exists(legacy) ? legacy : path.join(base, 'NodeGSM');
  }
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'NodeGSM');
}

/** The standard NodeGSM data folder (ignores the pointer file and the pre-NodeGSM folder). */
function standardDataDir({ platform = process.platform, env = process.env, appData, home = os.homedir() } = {}) {
  if (current(platform) === 'windows') return path.join(appData || env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'NodeGSM');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'NodeGSM');
}

// ---------- spawning / killing ----------
/** Extra spawn() options for game servers: POSIX servers get their own process group so the whole tree can be signalled. */
function spawnOptions(platform = process.platform) {
  return isWindows(platform) ? { windowsHide: true } : { detached: true };
}

/**
 * Kill a process tree. force=false: ask politely (taskkill /T without /F = WM_CLOSE, POSIX = SIGTERM to the process group);
 * force=true: taskkill /T /F or SIGKILL to the process group.
 * deps: { platform, spawnSync, kill } (injected in tests).
 */
function killTree(pid, { force = false } = {}, deps = {}) {
  const platform = deps.platform || process.platform;
  if (isWindows(platform)) {
    const sp = deps.spawnSync || spawnSync;
    return sp('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true });
  }
  const kill = deps.kill || process.kill.bind(process);
  const sig = force ? 'SIGKILL' : 'SIGTERM';
  try { kill(-pid, sig); return { status: 0, target: -pid, signal: sig }; } catch (e1) {
    try { kill(pid, sig); return { status: 0, target: pid, signal: sig }; } catch (e2) { return { status: 1, error: e2.message }; }
  }
}

/** chmod +x (POSIX only; a no-op on Windows). Never throws. */
function makeExecutable(file, platform = process.platform) {
  if (isWindows(platform)) return false;
  try { fs.chmodSync(file, 0o755); return true; } catch { return false; }
}

// ---------- CPU affinity ----------
/** { cmd, args } that apply the bit string ("1100" = cores 3 and 2) to a pid, or null when no mask. */
function affinityCommand(pid, bits, platform = process.platform) {
  if (!bits || !/^[01]+$/.test(bits)) return null;
  const mask = parseInt(bits, 2);
  if (!mask) return null;
  if (isWindows(platform)) return { cmd: 'powershell', args: ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).ProcessorAffinity = ${mask}`] };
  return { cmd: 'taskset', args: ['-a', '-p', mask.toString(16), String(pid)] };
}
function setAffinity(pid, bits, platform = process.platform) {
  const c = affinityCommand(pid, bits, platform);
  if (c) execFile(c.cmd, c.args, { windowsHide: true }, () => {});
  return !!c;
}

// ---------- per-process CPU / RAM / threads ----------
/** One Windows call returns every process; times are in 100 ns units. */
function readProcessesWindows() {
  return new Promise((resolve) => {
    const cmd = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,ThreadCount | ConvertTo-Csv -NoTypeInformation';
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 20000 }, (err, out) => {
      if (err) return resolve(null);
      const rows = [];
      for (const line of String(out).split(/\r?\n/).slice(1)) {
        const f = line.match(/"([^"]*)"/g);
        if (!f || f.length < 6) continue;
        const n = f.map((x) => Number(x.slice(1, -1)) || 0);
        rows.push({ pid: n[0], ppid: n[1], mem: n[2], cpuTime: n[3] + n[4], threads: n[5] });
      }
      resolve(rows);
    });
  });
}

/** /proc/<pid>/stat: the command name is in parentheses and may contain spaces / parentheses, so split after the LAST ")". */
function parseProcStat(text) {
  const s = String(text);
  const close = s.lastIndexOf(')');
  const open = s.indexOf('(');
  if (open < 0 || close < open) return null;
  const pid = parseInt(s.slice(0, open), 10);
  const f = s.slice(close + 2).trim().split(/\s+/);   // f[0] = state (field 3)
  const n = (i) => Number(f[i - 3]);
  const r = { pid, comm: s.slice(open + 1, close), state: f[0], ppid: n(4), utime: n(14), stime: n(15), threads: n(20), rssPages: n(24) };
  return [r.pid, r.ppid, r.utime, r.stime, r.threads].every(Number.isFinite) ? r : null;
}
/** /proc/<pid>/status: VmRSS (kB) and Threads. */
function parseProcStatus(text) {
  const g = (k) => { const m = new RegExp('^' + k + ':\\s*(\\d+)', 'm').exec(String(text)); return m ? parseInt(m[1], 10) : null; };
  return { vmRssKb: g('VmRSS'), threads: g('Threads') };
}
/**
 * Rows { pid, ppid, mem (bytes), cpuTime (100 ns units, like Windows), threads } from /proc.
 * deps: { readdir, readFile, clkTck, pageSize } (injected in tests).
 */
function readProcessesLinux(deps = {}) {
  const readdir = deps.readdir || ((d) => fs.readdirSync(d));
  const readFile = deps.readFile || ((f) => fs.readFileSync(f, 'utf8'));
  const clk = deps.clkTck || 100; const page = deps.pageSize || 4096;
  const rows = [];
  let names; try { names = readdir('/proc'); } catch { return null; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const st = parseProcStat(readFile(`/proc/${name}/stat`));
      if (!st) continue;
      let mem = st.rssPages * page; let threads = st.threads;
      try { const ss = parseProcStatus(readFile(`/proc/${name}/status`)); if (ss.vmRssKb !== null) mem = ss.vmRssKb * 1024; if (ss.threads) threads = ss.threads; } catch { /* process gone / no status */ }
      rows.push({ pid: st.pid, ppid: st.ppid, mem: Number.isFinite(mem) ? mem : 0, cpuTime: Math.round((st.utime + st.stime) / clk * 1e7), threads });
    } catch { /* the process exited while scanning */ }
  }
  return rows;
}
function clockTicks() {
  try { const r = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }); const n = parseInt(r.stdout, 10); if (n > 0) return n; } catch { /* default */ }
  return 100;
}
let tick;
function readProcesses(platform = process.platform) {
  if (isWindows(platform)) return readProcessesWindows();
  if (tick === undefined) tick = clockTicks();
  return Promise.resolve(readProcessesLinux({ clkTck: tick }));
}

// ---------- SteamCMD ----------
const STEAM_CDN = 'https://steamcdn-a.akamaihd.net/client/installer/';
/** Where SteamCMD lives and which archive to download. */
function steamcmdInfo(dataDir, platform = process.platform) {
  const dir = path.join(dataDir, 'bin', 'steamcmd');
  if (isWindows(platform)) return { dir, exe: path.join(dir, 'steamcmd.exe'), url: STEAM_CDN + 'steamcmd.zip', archive: path.join(dir, 'steamcmd.zip'), kind: 'zip' };
  return { dir, exe: path.join(dir, 'steamcmd.sh'), url: STEAM_CDN + 'steamcmd_linux.tar.gz', archive: path.join(dir, 'steamcmd_linux.tar.gz'), kind: 'tar' };
}
/** tar arguments to extract an archive (gzip for .tar.gz / .tgz). */
function tarArgs(file, destDir) {
  return [/\.(tar\.gz|tgz)$/i.test(file) ? '-xzf' : '-xf', file, '-C', destDir];
}
/** The platform name SteamCMD understands for +@sSteamCmdForcePlatformType. */
const steamPlatform = (p) => (current(p) === 'windows' ? 'windows' : current(p) === 'macos' ? 'macos' : 'linux');

// ---------- firewall ----------
function firewall(cfg, id, enable = true, platform = process.platform) {
  const name = `NodeGSM #${id} ${cfg.name}`;
  const portList = [...new Set([cfg.port, cfg.queryPort].filter(Boolean))];
  if (!isWindows(platform)) {
    return { ok: false, unsupported: true, message: `The firewall is not managed on this platform. With ufw: ${portList.map((p) => `sudo ufw allow ${p}`).join('; ')} (add /udp or /tcp as the game needs).` };
  }
  const ports = portList.join(',');
  spawnSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`], { windowsHide: true });
  if (!enable) return { ok: true };
  let ok = true;
  for (const proto of ['TCP', 'UDP']) {
    const r = spawnSync('netsh', ['advfirewall', 'firewall', 'add', 'rule', `name=${name}`, 'dir=in', 'action=allow', `protocol=${proto}`, `localport=${ports}`], { windowsHide: true });
    if (r.status !== 0) ok = false;
  }
  return { ok, message: ok ? `Opened ports ${ports}` : 'Failed - run the app as Administrator to modify the firewall' };
}

// ---------- plugin support ----------
/** Does the plugin (game object or manifest) declare support for the platform? Default: Windows only. */
function supports(platforms, platform = process.platform) {
  const list = Array.isArray(platforms) && platforms.length ? platforms : ['windows'];
  return list.includes(current(platform));
}

module.exports = {
  ALL, current, isWindows, defaultDataDir, standardDataDir,spawnOptions, killTree, makeExecutable, affinityCommand, setAffinity,
  readProcesses, readProcessesLinux, readProcessesWindows, parseProcStat, parseProcStatus,
  steamcmdInfo, tarArgs, steamPlatform, firewall, supports,
};
