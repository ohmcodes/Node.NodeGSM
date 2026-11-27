# Web mode and Linux (headless server)

NodeGSM can run without Electron as a small Node.js server and be controlled from any browser. The same code manages the game servers (`ServerManager`, backups, clusters, Discord, ...); only the window is replaced by a web page. It also runs on Linux.

> **Status: untested on real Linux.** The web mode runs and is covered by automated tests (on Windows). The Linux platform layer (process kill, `/proc` metrics, SteamCMD for Linux, `taskset`) is unit-tested with injected fake data only. Linux support of individual games is *declared, untested*. Please read [what is verified](#what-is-verified-and-what-is-not).

## Quick start

```bash
node --version          # 20 or newer
npm ci --omit=dev       # no Electron needed
npm run serve           # http://127.0.0.1:8730
```

On the **first start** a random access token is printed once and stored in `<data>/web-token` (mode `0600`). Open the page: it asks you to **create the owner account** (the token is needed this one time, it proves you control the machine). From then on you sign in with your username and password. To choose your own token set `NODEGSM_TOKEN` (at least 12 characters).

> From the **desktop app** you do not need any of this: **Settings > Web access** serves the same page from the running exe. See [Web access in the desktop app](#web-access-in-the-desktop-app).

Options (command line or environment):

| Option | Env | Default | Meaning |
|---|---|---|---|
| `--host` | `NODEGSM_HOST` | `127.0.0.1` | Bind address. Anything but loopback needs authentication (always on unless `--no-auth`) |
| `--port` | `NODEGSM_PORT` | `8730` | Port |
| `--data` | `NODEGSM_DATA` (or `WGSM_DATA`) | Linux: `$XDG_DATA_HOME/NodeGSM` or `~/.local/share/NodeGSM`; Windows: unchanged | Data folder |
| - | `NODEGSM_TOKEN` | generated | Access token |
| `--https` | `NODEGSM_HTTPS=1` | off | You terminate TLS in front: cookies get `Secure` |
| `--trust-proxy` | `NODEGSM_TRUST_PROXY=1` | off | Use `X-Forwarded-For` for the login rate limit (only behind your own proxy) |
| `--session-hours` | `NODEGSM_SESSION_HOURS` | `12` | Login session lifetime |
| `--max-body` | `NODEGSM_MAX_BODY` | 4 MiB | Request body limit (bytes) |
| `--require-2fa` | `NODEGSM_REQUIRE_2FA=1` | off | Every account must set up two-factor authentication (accounts without it only reach the account page) |
| `--no-auth` | `NODEGSM_NO_AUTH=1` | off | No login. **Only allowed on a loopback address** |

`npm run serve:dev` restarts on file changes (port 8731). The package also has a `nodegsm` bin entry (`npx nodegsm`).

Stop with Ctrl+C or `SIGTERM`: the running game servers are stopped the same way as when the desktop app quits (console command, then terminate, then kill after 15 s).

## Install on Ubuntu / Debian

```bash
# Node 20 (NodeSource) and the libraries SteamCMD needs (32-bit)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo dpkg --add-architecture i386
sudo apt update
sudo apt install -y nodejs tar curl ca-certificates lib32gcc-s1 lib32stdc++6
# Java for Minecraft: sudo apt install -y openjdk-21-jre-headless

sudo useradd --system --create-home --home-dir /var/lib/nodegsm nodegsm
sudo mkdir -p /opt/nodegsm && sudo chown $USER /opt/nodegsm
git clone https://github.com/ohmcodes/Node.NodeGSM /opt/nodegsm && cd /opt/nodegsm
npm ci --omit=dev --ignore-scripts
```

`--ignore-scripts` plus `--omit=dev` skips Electron and its downloader completely.

### systemd

```bash
sudo cp deploy/nodegsm.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now nodegsm
sudo journalctl -u nodegsm | grep -A3 "access token"      # token for the setup form (or: sudo cat /var/lib/nodegsm/web-token)
```

The unit runs as the `nodegsm` user, binds `127.0.0.1`, and is hardened (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, no capabilities, `ReadWritePaths=/var/lib/nodegsm`). Game servers run as children of the service and inherit those limits; if a game needs more (for example a path outside `/var/lib/nodegsm`), relax the unit consciously.

### Docker

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d --build
docker compose logs nodegsm | grep -A3 "access token"
```

The image is `node:20-slim`, runs as the non-root user `nodegsm` (uid 10001), keeps everything in the volume `/data`, includes `lib32gcc-s1`, exposes 8730 and has a health check on `/healthz`. The compose example publishes the web port on `127.0.0.1` only. **Game ports must be published explicitly** (`- "27015:27015/udp"`). The firewall of the host is yours to manage.

### nginx + TLS

`deploy/nginx.conf.example` is a complete server block: HTTP to HTTPS redirect, TLS, WebSocket upgrade for `/ws`, the headers NodeGSM needs. Start NodeGSM with `NODEGSM_HTTPS=1 NODEGSM_TRUST_PROXY=1`. Certificates: `sudo certbot --nginx -d nodegsm.example.com`. Keep `proxy_set_header Host $host;` - the CSRF check compares the browser's `Origin` with `Host`.

NodeGSM has **no built-in TLS** on purpose (see [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)). Never expose the plain-HTTP port to an untrusted network: passwords and the session cookie would travel unencrypted.

## Accounts, roles and two-factor

1. Open `http://127.0.0.1:8730` (or your HTTPS address). With no account yet you see the **setup form**: access token (once), username, password (10+ characters). The first account is the **owner**.
2. Afterwards the page asks for username + password. A session cookie (`HttpOnly`, `SameSite=Strict`, `Secure` behind HTTPS) is set; the password is never stored in the browser. Sessions end after 12 hours or 4 hours without use (`--session-hours`), and on every restart.
3. After 5 wrong attempts from one address that address is locked for 15 minutes, and after 5 wrong attempts for one account that account is locked for 15 minutes (HTTP 429), also for the right password. A wrong user name and a wrong password give the same answer.
4. **Settings > Web access > Accounts** (owner): add accounts, change roles, reset passwords (signs the user out), remove 2FA of someone who lost their phone, delete accounts, list and sign out sessions. The last owner cannot be deleted.
5. **My account** (`/account.html`, everyone): change password, set up two-factor (secret key + `otpauth://` link, confirm with a code, 8 one-time recovery codes shown once), turn it off (needs the password), sign out other sessions.

| Role | Can do |
|---|---|
| owner | everything: accounts, data folder, plugin installs, event-log clearing, Discord tests |
| admin | everything about the game servers, files, configs, console, backups, settings (not the bind address / port / HTTPS: those are changed in the desktop app or `settings.json`) |
| operator | a viewer who can also start, stop, restart and kill servers, send console / RCON commands, make backups and download them, and use bulk start / stop / restart / backup. No settings, files, configs, plugins or accounts |
| viewer | read only: server list, status, console output, logs, backup list. No files, configs, console commands, settings or downloads |

Operator and viewer accounts can be **limited to chosen servers** (Settings > Web access > Servers button, owner only): they then see only those servers in the list, console, logs, backups, event log and metrics, and live updates of other servers are not sent to them. Owners and admins always see everything. Changing the list or the role signs the account out.

Two-factor is a normal authenticator app (Google Authenticator, Authy, Aegis, 1Password ...). A code can be used once. With **Require two-factor** (`--require-2fa` or the Settings checkbox) every account must set it up: until then its session only reaches `/account.html`.

**Locked out?** The data folder is the key: stop NodeGSM, delete `<data>/web-users.json` and start again to get the setup form back (the token from `<data>/web-token` / `NODEGSM_TOKEN` is needed). From the desktop app the owner can always reset passwords and remove 2FA in Settings > Web access.

**Scripts:** the shared token still works as `Authorization: Bearer <token>` but only from a direct connection on the same machine (loopback, no `X-Forwarded-For` / `Forwarded` / `X-Real-IP` header) and gives owner rights. It does not sign in on the web page once an account exists. To rotate it: stop the service, delete `<data>/web-token` (or change `NODEGSM_TOKEN`) and start again.

```bash
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"args":[]}' http://127.0.0.1:8730/api/list
```

The channel list is [TECH-api.md](TECH-api.md). Every sign-in, failure, lockout and account change is written to the NGSM event log (address and account name, never a password, code or token).

## Web access in the desktop app

**Settings > Web access** (Windows desktop app):
- **Allow access from a web browser** starts the web server inside the app. It uses the same servers as the window (one manager, no second process) and starts again whenever NodeGSM starts.
- **Listen on:** *This computer only* (127.0.0.1) or *Other devices too* (all interfaces). Network access is refused until an owner account exists. **Port** defaults to 8730. Tick **reverse proxy provides HTTPS** / **trust X-Forwarded-For** only when you really run one in front.
- **Require two-factor authentication for every account.**
- The status line shows the address (Open / Copy address) or the reason it could not start (for example "Port 8730 is already in use").
- Turn on **Start NodeGSM on Windows login** and the app starts hidden in the tray when Web access is on, so after a reboot and a Windows sign-in the web page is back and Auto Start servers launch. A Windows service that runs before anyone signs in is not built; for a dedicated always-on machine use the headless mode (`npm run serve`) as a service.

### Background start (Windows, no desktop window)
Settings > Web access > **Run without the app** creates a Windows Task Scheduler task named `NodeGSM Web` that starts the web server hidden: **At sign-in** (no administrator needed) or **At Windows start** (runs as SYSTEM before anyone signs in; needs NodeGSM started as administrator once). It uses the host / port / HTTPS / 2FA settings above and this data folder, restarts the server 30 seconds after a crash and writes `logs/service.log` in the data folder. **Close the desktop app first**: the desktop app and the background server must not manage the same data folder at the same time. Remove the task from the same place. The first time, open the page and create the owner account (token in `web-token`).

This is a scheduled task, not an installed Windows service: a real service needs a wrapper executable that NodeGSM would have to ship and sign. The task gives the same result (starts at boot, hidden, restarts) with built-in tools.

## Putting NodeGSM on the internet

Best: **do not**. Use a VPN (WireGuard, Tailscale) or an SSH tunnel and keep the port closed. If you must publish it:
1. TLS in front (`deploy/nginx.conf.example`, certbot), start with `--https --trust-proxy` (or tick both boxes in the desktop app). Never publish the plain HTTP port.
2. Create the owner account **before** opening the port, use long unique passwords and turn on **Require two-factor**.
3. Give people the lowest role they need: **viewer** for watching, **operator** (limited to their own servers) for people who only restart and use the console; viewers cannot touch files or consoles.
4. Add what the proxy can add: an IP allow list, mTLS, or basic auth in front of NodeGSM, and the rate limit of your proxy on `/login`.
5. Keep NodeGSM and the OS updated, run as an unprivileged user, open only the game ports, watch the NGSM log for `web:login-failed` / `web:login-blocked`.
6. Remember what an account grants: control of the game servers' files and consoles. An owner / admin can run what the game server can run.

## Security hardening checklist
- [ ] Keep the default bind `127.0.0.1` and put a TLS reverse proxy in front; do not publish port 8730 directly.
- [ ] Create the owner account first, use long unique passwords and **require two-factor**. Treat `<data>/web-token` and `<data>/web-users.json` like passwords (both mode `0600`).
- [ ] Run as a dedicated unprivileged user (systemd unit / Docker image do this). Never as root.
- [ ] Remember what an owner / admin account grants: **full control of the machine's game servers**, including editing files and config of the servers and sending console / RCON commands. Anyone with such an account can run what the game server can run.
- [ ] Restrict the proxy further if you can (IP allow list, VPN, mTLS, basic auth) - the example nginx file shows where.
- [ ] Open only the game ports in your firewall (`ufw allow 27015/udp`); NodeGSM does not touch `ufw` / `iptables` (no sudo).
- [ ] Back up `<data>` (`servers/`, `backups/`, `settings.json`). Settings contain the Discord bot token and webhook URLs in plain text.
- [ ] Do not set `NODEGSM_TRUST_PROXY` unless a proxy you control overwrites `X-Forwarded-For`.
- [ ] `--no-auth` exists for local experiments only; NodeGSM refuses it on non-loopback addresses.
- [ ] Keep Node.js and the OS updated; game servers are the largest attack surface.

How the protection works (cookie / bearer, Origin check, rate limit, path confinement) is described in [TECH-architecture.md](TECH-architecture.md#web-mode-headless-server).

## What does not work in web mode
These need a native window and are hidden or replaced:

| Desktop feature | Web mode |
|---|---|
| Folder picker (Import server, plugin install) | Type the path **on the server** (Import existing folder). Install plugins by copying the folder into `<data>/plugins` and pressing *Reload* |
| "Folder" button (open in Explorer) | Hidden |
| Backups: "Open folder" | Becomes **Download** (authenticated `GET /download/backup`) |
| Restart NodeGSM, hardware acceleration, tray, start on login, auto-restart app | Hidden. Use systemd (`Restart=on-failure`) or Docker (`restart: unless-stopped`) |
| Opening links | They open in a new browser tab |
| Windows firewall button | Returns a message with a `ufw` hint; nothing is changed |

## Linux specifics

- **Data folder:** `$XDG_DATA_HOME/NodeGSM` or `~/.local/share/NodeGSM` (set `NODEGSM_DATA` to change). Settings -> Data location is desktop only; a service uses `--data` / `NODEGSM_DATA`. On Windows nothing changes: the legacy `%APPDATA%\node-wgsm2026\WGSM` folder is still used when it exists.
- **SteamCMD:** downloaded as `steamcmd_linux.tar.gz` from the Steam CDN into `<data>/bin/steamcmd`, extracted with `tar`, run as `steamcmd.sh` with the same arguments as on Windows. It needs the 32-bit libraries: `sudo apt install lib32gcc-s1` (Debian 12 / Ubuntu 22.04+; older: `lib32gcc1`). The first run self-updates.
- **Processes:** every game server is started in its own process group; *Stop* sends the console stop command, then `SIGTERM` to the group, then `SIGKILL` after 15 s. *Kill* sends `SIGKILL` to the group.
- **Metrics:** CPU / RAM / threads per server are read from `/proc` (the whole process tree). Disk uses the data folder's file system.
- **CPU priority** uses `os.setPriority` (lowering it works as any user; raising needs root or `CAP_SYS_NICE`). **CPU affinity** uses `taskset` (package `util-linux`).
- **Executable bit:** NodeGSM runs `chmod 755` on the server executable before starting it.
- **Not managed:** the firewall, `sudo`, installing Java or system libraries.

### Plugins and platforms
Plugins declare `platforms: ["windows", "linux"]` (default Windows only). The game browser and *Add Server* show a **not available on this platform** badge and refuse to create such servers. A plugin can override `run.linux` (`exe`, `command`, `args`, `workingDir`, `env`) and `install.linux`; see [PLUGINS.md](../PLUGINS.md#platforms-and-linux).

Declared for Linux (**declared, untested** - written from public knowledge of the games' Linux server builds, never run on Linux by the project):

| Plugin | Linux executable | Needs |
|---|---|---|
| `mc` Minecraft Java | `java -jar server.jar` (unchanged) | Java 17+ (`openjdk-21-jre-headless`) |
| `csgo` Counter-Strike: GO (app 740) | `srcds_run` | `lib32gcc-s1`, `lib32stdc++6` |
| `rust` (app 258550) | `RustDedicated` with `LD_LIBRARY_PATH=<files>/RustDedicated_Data/Plugins/x86_64` | Enough RAM (a 64-bit glibc distribution) |
| `palworld` (app 2394010) | `PalServer.sh` | `steamclient.so` copied to `~/.steam/sdk64/` |

All other plugins stay Windows only until someone verifies them. To declare more, see [CONTRIBUTING.md](../CONTRIBUTING.md). Some Steam apps ship only a Windows depot; for those a step can force the depot platform: `{ "type": "steamcmd", "appId": "...", "platform": "linux" }` adds `+@sSteamCmdForcePlatformType linux` to the SteamCMD command line (only when it differs from the host).

Other caveats: Source engine servers want the `-game` / `+map` arguments exactly as on Windows (they are the same); the in-app console of `srcds`-style servers has no stdin (use RCON); case-sensitive file names matter on Linux (plugin paths like `csgo/cfg/server.cfg` must match exactly); mods written for Windows do not load.

## What is verified and what is not
Verified by the automated tests on Windows (network free, localhost only): login, cookie flags, bearer, rate limiting, Origin / CSRF checks, content-type and body limits, static path confinement, backup download confinement, WebSocket auth and event delivery from a real (fake) game server, the refusal to bind publicly without authentication, loading `core.js` / `headless.js` with Electron unresolvable.

Unit-tested only, with injected fakes: the `/proc` parser, process-group kill, `taskset` command, XDG data folder, Linux SteamCMD paths / arguments / tar arguments, plugin platform fields, the Linux firewall message.

**Never run on a real Linux machine:** SteamCMD download and extraction, a real game install and start, `/proc` on a live system, process-group stop, `taskset`, Docker image build, the systemd unit and the nginx file. Please walk through the Linux section of [TESTING-CHECKLIST.md](TESTING-CHECKLIST.md).
