# Web mode and Linux (headless server)

NodeGSM can run without Electron as a small Node.js server and be controlled from any browser. The same code manages the game servers (`ServerManager`, backups, clusters, Discord, ...); only the window is replaced by a web page. It also runs on Linux.

> **Status: untested on real Linux.** The web mode runs and is covered by automated tests (on Windows). The Linux platform layer (process kill, `/proc` metrics, SteamCMD for Linux, `taskset`) is unit-tested with injected fake data only. Linux support of individual games is *declared, untested*. Please read [what is verified](#what-is-verified-and-what-is-not).

## Quick start

```bash
node --version          # 20 or newer
npm ci --omit=dev       # no Electron needed
npm run serve           # http://127.0.0.1:8730
```

On the **first start** a random access token is printed once and stored in `<data>/web-token` (mode `0600`). Open the page and paste it into the login form. To choose your own token set `NODEGSM_TOKEN` (at least 12 characters).

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
git clone https://github.com/ohmcodes/Node.WGSM2026 /opt/nodegsm && cd /opt/nodegsm
npm ci --omit=dev --ignore-scripts
```

`--ignore-scripts` plus `--omit=dev` skips Electron and its downloader completely.

### systemd

```bash
sudo cp deploy/nodegsm.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now nodegsm
sudo journalctl -u nodegsm | grep -A3 "access token"      # first token (or: sudo cat /var/lib/nodegsm/web-token)
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

NodeGSM has **no built-in TLS** on purpose (see [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)). Never expose the plain-HTTP port to an untrusted network: the token and the session cookie would travel unencrypted.

## First login

1. Open `http://127.0.0.1:8730` (or your HTTPS address). You are redirected to the login page.
2. Paste the token. A session cookie (`HttpOnly`, `SameSite=Strict`, `Secure` behind HTTPS) is set; the token itself is never stored in the browser.
3. After 5 wrong tokens from one address the address is locked for 15 minutes (HTTP 429).
4. To rotate the token: stop the service, delete `<data>/web-token` (or change `NODEGSM_TOKEN`) and start again. All sessions are in memory and end on every restart.

Scripts can use the same token as a bearer token:

```bash
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"args":[]}' http://127.0.0.1:8730/api/list
```

The channel list is [TECH-api.md](TECH-api.md).

## Security hardening checklist
- [ ] Keep the default bind `127.0.0.1` and put a TLS reverse proxy in front; do not publish port 8730 directly.
- [ ] Use a long random token (the generated one is 32 characters). Treat `<data>/web-token` like a password; it is mode `0600`.
- [ ] Run as a dedicated unprivileged user (systemd unit / Docker image do this). Never as root.
- [ ] Remember what the token grants: **full control of the machine's game servers**, including editing files and config of the servers and sending console / RCON commands. Anyone with the token can run what the game server can run.
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

- **Data folder:** `$XDG_DATA_HOME/NodeGSM` or `~/.local/share/NodeGSM` (set `NODEGSM_DATA` to change). On Windows nothing changes: the legacy `%APPDATA%\node-wgsm2026\WGSM` folder is still used when it exists.
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
