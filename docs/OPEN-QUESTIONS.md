# Open questions

Decisions deferred while implementing, to confirm with the project owner.

## Needs your input first
Decisions made on 2026-11-27 are listed first; what is left is the real-world testing. Details are in the sections below.
- **Decided:** the **logo** is approved as it is (N from stacked server blocks + a network link). The **Discord embed reference image** is dropped (the default embed stays). **`/send`** stays as it is: off by default, only for users the permission rules allow (it gives full console access). **Token encryption** is not needed (NodeGSM runs on the user's own machine or server; the bot token and webhook URLs stay plain text in `settings.json`). **BattlEye and Telnet RCON** are not planned.
- **Decided:** **footer URLs** are set (Website https://nodegsm.ohmcodes.com, Patreon, PayPal, Buy Me a Coffee); the **Discord link is halted** (hidden while empty). The website is served at https://nodegsm.ohmcodes.com; only the Catalogue is published through GitHub Pages.
1. **Bot token live test** (Phase 6): create a throw-away bot and run the commands once; nothing was ever run against real Discord (also: a real webhook **Send test**, Phase 2).
2. **Real-server pattern checks for tick / RCON** (Phases 5 and 7): the `mc`, `csgo` and `rust` patterns were written from documentation, not from live output; RCON was only tested against local fakes.
3. **Cluster preserve defaults** (Phase 4): only `mc`, `arkse` and `rust` ship `cluster.preserve`; a cluster update of any other game copies everything except configs. Refuse / confirm when a plugin declares none?
4. **Real backups and clusters** (Phases 3 and 4): try one multi-GB server, a neat-pick restore-as-new that downloads the game, and a real two-server cluster update (back up first).

The manual steps for all of this are in [TESTING-CHECKLIST.md](TESTING-CHECKLIST.md).

## Phase 1 - app shell
- Footer URLs are set in `src/renderer/links.js` (Discord halted: hidden while its URL is empty).
- Panel scope: the server-list panel shows only in the List view; the details and quick-settings panels also show in Table / System Metrics (following `state.sel`). In the Table view a single click does not change that selection (double-click does). Should Table selection drive them?
- Only List / Table / System Metrics are remembered as the start view (`settings.view`); Games, Settings and Discord are not. Should the start view be extendable?
- Tick header stat is a "-" placeholder until Phase 7. *(Resolved in Phase 7: it shows the worst tick of the running servers, `n/a` when none has one.)*
- Quick settings saves `name/port/map/maxPlayers/param` through the existing `save` IPC with no extra validation (same as the Settings tab).

## Phase 2 - logging and Discord
- **Embed reference image still wanted:** no reference image was supplied, so the default embed templates (title + description + 3 inline fields + footer, colours per event) are a neutral first guess. Send an example of the look you want and the defaults in `src/main/services/discord.js` (`DEFAULT_TEMPLATES`) will be adjusted.
- Discord alerts were never sent to a real webhook (tests use a local HTTP server). Please use **Send test** with a throw-away webhook once.
- Behaviour change to confirm: a webhook that is not `https://discord.com|discordapp.com/api/webhooks/...` is now rejected. Existing per-server webhooks of another form (for example proxies) would need to be re-entered / are refused on the next save. Should a "custom URL" escape hatch exist?
- Defaults for event toggles: started, crashed, restarted, updated are ON; stopped, backup, restore are OFF. Manual restarts are not sent to the per-server webhook (same as before) but are sent to the global one. OK?
- Per-server override covers both webhooks; the old per-server flags only apply to the per-server webhook. Is a per-server override for the *global* webhook only needed?
- Plugin `logging.logFiles` (scanning log files, not just the console) is implemented since 2026-11-25 (new lines, every 2 s); not yet tried against a real game log.
- Log retention counts days (default 30, UI control not added - setting `logging.retentionDays` in `settings.json`). Add a field in Settings?
- Logs screen shows the newest 500 entries; export takes up to 5000. Enough?
- The renderer CSP now allows `https:` images (for embed thumbnails in the preview). Acceptable?

## Phase 3 - backups
- **Real-world testing:** backups were tested with small fake servers only. A multi-GB server (the zip64 path is covered by a forced-zip64 unit test and was not opened with an external tool), a running server with locked files and a Neat-pick restore-as-new that really downloads the game (SteamCMD) have not been exercised. Please try one on a real server.
- Full restore overlays the zip on the existing files (files that are not in the backup stay). Should there be an option to **clean** the server folder first (exact copy)? It is riskier for imported servers (`installDir`).
- Plugin `backup.exclude` also applies to **Full** backups (logs / temp files are not stored). Is that wanted, or should Full ignore the plugin list and only honour the user's patterns?
- `includeServerSettings` defaults: Full = on, Neat pick = off. The saved `wgsm.json` contains the Discord webhook URL in plain text; should the webhook be stripped from backups?
- In-place restore keeps the current server settings unless the user says yes in a second prompt; restore-as-new applies them by default (ports moved if taken). OK?
- Retention counts every backup of a server (manual, bulk, on start); there is no "manual backups are never pruned" class. Needed?
- Server ids are reused: when a server is deleted its backups move to `<id>.deleted-<ms>`, and a new server that takes the same id starts with an empty list. The old ones show as "deleted server".
- Restore-as-new for a backup whose plugin was removed is refused with a clear message; there is no way to pick a different plugin yet (only old backups without a manifest ask for the game).
- Preset paths shipped for mc / csgo / rust / palworld / arkse are best-effort from the games' usual layouts; Rust's identity folder depends on `+server.identity`, so that preset takes the whole `server` folder.
- No scheduled (cron) backups yet - only manual, bulk, backup-on-start and retention. Add a per-server schedule?
- "Open folder" reveals the zip in Explorer (the desktop app has no browser-style download). A web build will need a real download endpoint.
- Empty directories are stored; NTFS ACLs, file attributes and alternate data streams are not.

## Phase 4 - clusters
- **Real-world testing:** clusters were tested with fake servers (copy, merge, clear, removal cleanup, running-member stop / start by a stub). A real SteamCMD parent update, a real multi-GB copy and locked files of running servers were not exercised. Please try a small real cluster (and back up first).
- Update distribution copies **everything** in the parent's files folder except the preserved paths, so a plugin without `cluster.preserve` (only `mc`, `arkse` and `rust` ship one) would overwrite per-server data that is not a config file. Should clusters refuse to update (or require a confirmation) when the plugin declares no `cluster.preserve`? Currently the preview lists the preserved paths and the guide says to add them.
- Files that exist only on a member are never deleted (the distribution is additive). Should there be a "mirror" option that removes extra files (mods removed from the parent)?
- `cluster.preserve` / `configs[].path` matching is path based; a pattern without `/` that has `*` / `?` matches by name anywhere. `**` is supported. Is that enough or should plugin authors get explicit `exclude` globs?
- Config sync of `text` / `xml` files replaces the whole file (only `NGSM:ignore` lines are kept, matched by their first word or tag). Real XML / structured merge (attributes, nested tags) is not implemented; the preview shows a warning.
- YAML merge is line based (no YAML library): multi-line strings, anchors and flow style (`{a: 1}`) are only matched line by line. JSON files with comments (JSONC) are rejected as invalid.
- Protected keys that exist only in the member are **kept** (appended at the end, or inside the same ini section); a key that exists only in the parent is added. Member-only keys that are not protected are dropped (the parent file wins). OK?
- A new member (no config file yet) receives the parent's protected values (ports, passwords) with a warning, not defaults. Should new members get an automatic port offset?
- `clearFolders` is non-recursive by default (`recursive: true` per rule opts in) and only matches file names; folders are never removed. Locked files are skipped and counted, but a running server's open log is not rotated first.
- Cluster actions refuse to start while another cluster action runs on the same cluster; they do not block normal single-server actions on the members except that a member that is busy (installing, backing up) is reported as failed for that run.
- Progress is byte based over all members; the parent update (SteamCMD) has no percentage inside the cluster bar yet (it shows "Updating the parent ...").
- The UI edits the cluster clear rules as `path | pattern | days` lines (no `recursive` toggle).
- Clusters of different game versions or branches are not supported (same game only); there is no cluster-level schedule yet (for example "update every Tuesday 04:00").
- The NGSM log shows cluster entries per member server id; there is no cluster filter on the Logs screen yet.

## Phase 5 - configs, auto-clear, consoles, validate
- **Real-world testing:** RCON was tested only against a local fake server (Source style, Minecraft style, no end marker). Please try a real Minecraft server (`enable-rcon=true`, `rcon.password` set) and a Source server (`rcon_password` in `server.cfg`) once. Rust / ARK web-socket RCON and BattlEye / Battlefield-style protocols are not supported.
- Source / Minecraft servers only accept RCON after they have read the saved config; if the password changed, the server has to be restarted. The RCON sub-tab reports "authentication failed" in that case, with no hint of the password.
- **WebRCON, quick commands, scheduled commands and stop over RCON (2026-11-25)** were tested with local fakes only; please try a real Rust server (WebRCON password in the start parameters) and a CS:GO server (`Stop` should quit by itself). Scheduled commands appear in the NGSM log like typed commands, and a command with a secret would be logged too.
- RCON commands are written to the NGSM log (as `server:command`) like console commands; commands that carry secrets (for example `rcon_password x`) would be logged. Should RCON commands be logged without arguments, or with a deny-list?
- Structured editor: values of `cfg` / `ini` files are shown raw (quotes included); there is no type-aware widget (checkbox for true / false, number spinner). YAML is the simple subset only (nested maps with space indentation); lists, anchors and block scalars are kept but not editable. JSON files with comments are raw only. Multi-line values and duplicate keys are edited line by line. Is a type-aware editor wanted?
- The Configs screen edits one file at a time; there is no "apply to several servers" (use clusters for that).
- Auto-clear: a seeded `default: true` plugin rule is enabled for every server of that game as soon as the app first looks at the server (its first run is one interval later). Should plugin defaults rather start disabled everywhere and be switched on by the user?
- Auto-clear deletes files directly (no recycle bin) and does not rotate or close a log that a running server holds open (such files are locked and skipped). Folders are never removed, even when empty. There is no per-rule size limit ("keep the newest N files / max X MB").
- Auto-clear counts the age by modified time only; there is no cron-style time of day.
- Consoles: log consoles share the tail of the Logs tab (one tail per server and log at a time), so following the same log in both tabs restarts the tail. The game console of Source / GoldSource engines still has no stdin; use an RCON console for those.
- Validate for games without a SteamCMD step re-runs the plugin install steps (same as Update); only `plugin.js` installers can tell the difference through `helpers.validate`. `update.validateArgs` supports only the key `steamcmd` for now.
- Validate asks for a confirmation (it can overwrite edited game files, configs are normally kept). Auto update never validates.
- The busy state text (`Validating`) was only checked through tests and the status events; the badge colour reuses the "Updating" style.

## Phase 6 - Discord bot
- **Live testing needed:** nothing was run against real Discord. Please create a test application / bot (see [GUIDE-discord.md](GUIDE-discord.md)), add it to a throw-away server, and try `/check`, `/list`, `/start`, `/stop`, `/update`, `/backup`, `/stats` and the denial path. Unverified: the exact look of the embeds, autocomplete latency, command registration timing, and discord.js reconnect behaviour after a network drop.
- Should `/send` exist at all? It is off by default behind a toggle and logged, but it gives every allowed user full console access. Options: remove it, restrict it to admin roles only, or add a per-server deny list of commands.
- The bot stores the token in `settings.json` in plain text (as planned). Encrypting it would need Electron `safeStorage` (OS-bound, breaks when the data folder is copied to another PC) - wanted?
- The deprecated `allowedUserIds` list and admin roles still have **all** rights; the new permission rules (see above) allow a finer split per user and server. Admin roles are not configurable per action yet.
- **Permission rules (2026-11-25), please confirm:** the request "`<discordID> <serverID> [what they can do]` ... (maybe zero for all)" was interpreted as: server id `0` (or `*`) = ALL servers, and "none" = simply no rule for that user (default deny). `check` / `list` / `stats` are treated as global actions (any rule listing them is enough; `/list` and `/stats` then show only the servers the user has some permission for). The old `allowedUserIds` list still gives full access (deprecated), admin roles still give full access, and rules are additive. Is that the intended model, and should the legacy list be removed (migrated to `<id> 0 all` rules)? Should admin roles also become configurable per action?
- Per-server `discordAllowedUserIds` has no UI (edit `wgsm.json`). Add a field to the server's Automation tab?
- `/update` and `/backup` can run longer than Discord's 15 minute limit for editing the reply; the operation continues but the final embed is lost. Alternatives: post a channel message via the webhook, or only reply "started" and rely on the alert webhook for the result.
- `serverid` is the numeric NodeGSM id (ids are reused after a server is deleted). Names are shown only in the autocomplete list.
- Server names are visible to everyone on the allow list via `/list` and autocomplete (not to others). Servers restricted by `discordAllowedUserIds` are hidden from autocomplete but still appear in `/list`.
- `/stats` uses the dashboard's 5-second sampling; the first answer after app start can be "no metrics yet".
- Commands are guild-only (`dm_permission: false`); DMs to the bot are not supported. Registration uses "set" (replaces all commands of that scope); switching from a guild id to global leaves the old guild commands registered - a clean-up step is not implemented.
- The bot logs the `/send` length, not the text, but the normal `server:command` event (and therefore the NGSM log) still contains the text, as for commands typed in the app console.
- The token format check is loose (three dot-separated parts); the real validation is the login attempt.
- `discord.js` adds about 9 MB of dependencies (undici, @discordjs/*) to the installer even for users who never enable the bot. Acceptable, or should the bot become an optional download?

## Phase 7 - server tick metric
- **Real-world testing:** tick polling was tested with local fakes only (a fake RCON server, a fake A2S server, fake console processes). Please try a real Paper server (`rcon:tps`), a vanilla 1.20.3+ server (`rcon:tick query`), a csgo server (`rcon:stats` column layout) and Rust (`fps` console output) and correct the patterns if the real output differs.
- Games with **no console / RCON access** (stdin-less hlds / srcds without RCON, Unreal / Unity servers that only log) cannot be polled; they get the Latency estimate only. Should a log-based tick (pattern on a periodic log line) be added per game, or a generic "stats" file reader?
- Minecraft: `tps` exists on Paper / Spigot / Purpur only; vanilla < 1.20.3 has no tick command at all. Spark (`/spark tps`) or a mod would need its own pattern; should the mc plugin try `spark tps` as a third metric when Spark is installed?
- The `stats` pattern for Source games reads the **FPS** column of the first numeric row; newer builds add `Svms +-ms ~tick` columns and the variance is not shown. Is a second metric (frame time / variance) wanted?
- Header Tick with servers of different games mixes units (TPS and fps): it shows the *worst by colour*, then by value, with the unit. Should it be per game group, or average only for same-unit servers (`aggregateTick(rows, 'avg')` exists but there is no setting)?
- Latency is the UDP / HTTP round trip from NodeGSM to the local query port (127.0.0.1), so it mostly reflects how busy the server's main loop is, not network latency. It is only measured every 15 s (the status poll). Is that acceptable, and should it also be offered as a column by default?
- Colour defaults without thresholds come from `tickTarget` (90 % / 75 % higher is better; 1x / 2x lower is better); these are guesses. Plugin authors can set exact `warn*` / `bad*`.
- Each RCON tick metric is a separate command per interval (mc ships two: `tps` and `tick query`, on Paper both answer). The unused one logs "unknown command" on the server console. Should a metric be disabled automatically after N consecutive failures?
- RCON polls are not written to the NGSM log (to avoid a line every 15 s). Failures are only kept in memory (`pollErrors`); there is no UI for them yet - should a failing tick poll show a hint (for example "RCON not reachable") in the details panel?
- `kind` is the only new `metrics[]` kind; the catalogue detail carries the metric names, but the website does not show the kind yet.

## Phase 8 - logo
- **Logo direction is a first pass.** Concept: an "N" whose two stems are stacked server units and whose diagonal is a network link with a node at each end; accent colour = the app's default `--accent` (#4f8cff). Please review `assets/logo.svg`, `assets/logo-wordmark.svg` and `assets/icon.svg` (or the generated `assets/icon.png`) and say what to change (shape, colours, a different motif, a lettered "NGSM" mark).
- The wordmark SVG uses text (Space Grotesk, falling back to Segoe UI / Arial) rather than outlined letters, so its look depends on the font that is installed. Convert it to outlines once the design is final?
- The Windows .exe itself keeps the Electron icon: `build.win.signAndEditExecutable` is still `false` (needs Windows Developer Mode to extract electron-builder's helper tools). The icon is set in `build.win.icon`, so it is used as soon as signing/editing is enabled; the window, taskbar, tray and installer-less runs (`npm start`) already use the new icon. Enable it?
- The 16 and 32 px images use solid stems (the gaps between the server blocks would blur). Check the tray icon at 100 % / 150 % / 200 % scaling on your display.
- The in-app header mark is inline SVG coloured by the accent; the website logo is a fixed-blue PNG (mark only, transparent) and the favicon is the dark tile.

## Phase 9 - docs, tests and release
- Features not done and listed as ⏳ in FEATURES.md: mod manager, passkeys (WebAuthn), online plugin repository, release downloads, web / Linux version (planned last, starts only after you confirm the plan and the docs).
- Which of the unverified (🧪) features do you want promoted to ✅ after the manual run in [TESTING-CHECKLIST.md](TESTING-CHECKLIST.md)?
- *(Resolved: `GUIDE-web-linux.md` exists.)*

## Phase 8 - web mode and Linux
- **Real Linux testing:** nothing ran on a real Linux machine. Unit-tested only: the `/proc` parser, process-group kill, `taskset` command, XDG data folder, SteamCMD Linux paths / arguments, the Linux firewall message. Please run the Linux section of [TESTING-CHECKLIST.md](TESTING-CHECKLIST.md) (SteamCMD download, a real install and start, stop / kill leaving no orphans, Docker image, systemd unit, nginx).
- **Per-game Linux validation:** `mc`, `csgo`, `rust` and `palworld` are *declared, untested* (written from public knowledge: `srcds_run`, `RustDedicated` with `LD_LIBRARY_PATH`, `PalServer.sh`). Which other games should be declared next, and who verifies them? Some need extra steps (Palworld's `steamclient.so`, CS:GO's `lib32stdc++6`) that are only documented, not automated. Should NodeGSM check for missing system libraries (`lib32gcc-s1`, Java) and warn before install?
- **Multi-user accounts (partly answered 2026-11-25):** accounts, roles (owner / admin / viewer), TOTP two-factor and an audit trail now exist. Still open: per-server permissions for accounts, an operator role between viewer and admin, e-mail / WebAuthn. Original question: web mode had one shared token (no users, roles, per-user audit trail, 2FA). Would you want accounts with roles (viewer / operator / admin), per-server permissions, and who-did-what in the NGSM log? Today the token holder can edit files, send console / RCON commands and delete servers.
- **Public exposure:** is exposing NodeGSM to the internet (behind TLS + token) acceptable, or should the docs require a VPN / IP allow list? Should sensitive actions (file editor, console, delete, plugin install) require re-entering the token or be switchable off per deployment (a read-only mode)?
- **HTTPS built in or not:** TLS is left to a reverse proxy (nginx example, `--https` only sets `Secure` cookies). Should NodeGSM terminate TLS itself (`--cert` / `--key`, Let's Encrypt)?
- **Sessions are in memory:** every restart logs everyone out. Persist them (signed, in `<data>`)? A single failed-login counter per client address; behind a proxy without `NODEGSM_TRUST_PROXY` all users share the proxy's address.
- **Web mode limits:** no folder picker (paths are typed), no plugin ZIP / folder install from the browser (copy to `<data>/plugins` and Reload), no file upload / download except backups. Add a file upload / download endpoint for plugins and server files?
- **Linux paths and users:** the data folder is `~/.local/share/NodeGSM` by default; the Docker image and systemd unit use `/data` and `/var/lib/nodegsm`. Game servers run as the NodeGSM user with the systemd hardening inherited (read-only system, no home); some games may need relaxed settings.
- **Firewall on Linux** is not managed (a `ufw` hint is shown). Manage `ufw` / `firewalld` through an optional, explicitly configured sudo rule?
- **Process isolation:** game servers are children of the NodeGSM process; a hard NodeGSM crash leaves them running (as orphans of init) and they are not re-attached after a restart. Re-attach by pid file, or run each server in its own systemd scope / container?
- **Crash handling in web mode:** uncaught exceptions are logged to `logs/crash.log` and the process keeps running (the desktop app can relaunch itself, a service relies on systemd `Restart=`). Exit and let the supervisor restart instead?
- **Windows web mode:** `npm run serve` also works on Windows (used for the automated tests). Since 2026-11-27 the desktop app can install a **scheduled task** that starts it hidden (Settings > Web access > Run without the app); a real installed Windows service (WinSW / NSSM) is not planned. Open: should NodeGSM refuse to start the desktop window while the background task runs on the same data folder?
- **New dependency:** `ws` 8.23.0 (about 0.2 MB; it was already installed transitively by `discord.js`, now pinned as a direct dependency).

## Website - WindowsGSM plugin converter
- **Hosting for the backend:** option 3 (automated submission) needs the Website's Node server; the site at https://nodegsm.ohmcodes.com runs the Website's Node server (Docker / compose files in the Website repository), so the API is on the same origin (`API_URL: 'auto'`). Only the Catalogue is published through GitHub Pages.
- **Moderation process:** who reviews submissions, how often, and what is the bar (the draft PR still needs icon, docs links, a test in NodeGSM and the Catalogue CI)? Should rejected submissions be kept, and for how long? There is only the `ADMIN_TOKEN` + curl / `admin-submissions.html`, no e-mail notification.
- **Bot token scope:** `GITHUB_TOKEN` should be a **fine-grained token limited to the Catalogue repository** with *Contents* and *Pull requests* read/write only. Should the PRs come from a dedicated bot account / GitHub App instead of a personal token, and should branches `submit/*` be cleaned up after merge?
- **Spam handling / captcha:** the only protections are per-hashed-IP limits (1 per 10 minutes, 3 per day), a 200-pending cap, size / character checks and owner review. Add a captcha, a proof-of-work, or require a verified contact?
- **Accept `plugin.js` conversions?** Today only `plugin.json` + README are accepted automatically; anything that needs code (custom install / update, version checks) must go through a normal PR so a person reviews the script. Keep it that way?
- **Licence consent wording:** the checkbox says *"I agree this plugin may be published under the repository licence"* (the Catalogue is MIT) and that the submitter has the right to share it. Is that enough, or should it name the licence and the original WindowsGSM plugin author (WindowsGSM plugins are often MIT but not always)? The converter keeps the original author only as text in the README / PR body.
- **Contact data:** the optional contact is stored as plain text and shown to the owners only. Retention (delete after the PR is merged?) and whether to ask for it at all.
- **Real-world check:** the converter was tested on the three WindowsGSM samples, original fixtures and by temporarily adding metadata to WindowsGSM's built-in engine classes (not committed); it has not been run on real third-party plugins from the plugin repository, and the GitHub flow has only run against a fake local GitHub.
