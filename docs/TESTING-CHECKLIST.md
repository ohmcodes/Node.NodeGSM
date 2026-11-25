# Manual testing checklist

The automated tests (`npm test`) use fake servers, a fake RCON / A2S server, a local HTTP server instead of Discord and a stub renderer transport. Nothing below has been verified against the real thing. Work through the list with `npm start`, tick what passes, and write down what does not (copy the line from the **Logs** screen or `%APPDATA%\NodeGSM\logs\crash.log`).

Rules for a safe test run:
- Use a **throw-away server** (a small Minecraft or Source server you can reinstall) and a **throw-away Discord server / webhook / bot**. Back up anything you care about first.
- Several checks need two or more servers of the same game: create them with **+ Add Server** (or import copies of one folder).
- `[ ]` = not tested yet. Expected results are in italics.

## 0. First start and logo
- [ ] Start the app. *The window and the Windows taskbar show the NodeGSM icon (dark tile, blue N made of stacked blocks); the header shows the same mark in the accent colour next to "NodeGSM".*
- [ ] Settings > pick another accent colour. *The header mark changes colour with it.*
- [ ] Switch to the light theme. *The mark stays readable; the dark tile icon is unchanged (it is an image).*
- [ ] Enable **minimize to tray**, close the window. *A tray icon with the N appears (sharp at 100 % and 150 % display scaling); clicking it shows the window.*
- [ ] After `npm run pack`: open `dist\win-unpacked`. *Note: with `signAndEditExecutable: false` the .exe itself keeps the Electron icon; see the README build note.*

## 1. Layout panels, header stats and footer links
- [ ] Hamburger button (top left): *navigation shrinks to an icon rail, again to full width.*
- [ ] Toggle the three panel buttons (server list, details, quick settings). *Each panel collapses; the centre uses the freed space.*
- [ ] Collapse two panels, close and restart the app. *The same panels are collapsed and there is no flash of the expanded layout.*
- [ ] Select a server in List; edit **Port** in the quick settings panel but do not save; let the status change (start / stop it). *Your unsaved edit is not overwritten.* Save. *The server card shows the new port after the next start.*
- [ ] Settings > Header info bar: untick and tick CPU, RAM, Disk, Servers, Players, Tick. *The header bar follows immediately and after a restart.*
- [ ] Footer: Website, Discord and each Donate link. *Each opens in the default browser.* **They are placeholders until you set real URLs in `src/renderer/links.js`** (see OPEN-QUESTIONS).

## 2. Clusters (needs 2+ servers of one game, e.g. 3 Minecraft)
- [ ] Home > Clusters > **Create cluster**: pick the game, tick two servers, choose a parent, name it. *Cluster appears with both members and their status; trying one server of a different game is not offered.*
- [ ] Try to put a server that is already in a cluster into a second one. *Refused / not offered.*
- [ ] **Preview** an update. *Per member: files and bytes to copy, plus the list of never-overwritten paths (`world`, `server.properties`, ...). Nothing changes on disk.*
- [ ] Start one member, run **Update** (no validate). *The running member is stopped, files are copied, and it is started again; the progress bar moves; the result table shows one row per member.*
- [ ] Afterwards check a member folder. *`server.properties`, `world` and `configs\wgsm.json` are the member's own, not the parent's.*
- [ ] Lock a file in one member (open a jar in an editor that locks it) and run Update again. *That member is reported as failed or the file skipped; the other member still updates.*
- [ ] Delete a member server. *It leaves the cluster; with fewer than 2 left the cluster disappears and the other server is untouched.*

### Config sync
- [ ] In the parent change `motd` and `max-players` in `server.properties`; in a member set a different `server-port`. Cluster > **Config sync**, pick `server.properties`, **Preview changes**. *Diff shows motd and max-players changing, `server-port` and `rcon.*` untouched (protected).*
- [ ] **Apply**. *Member file updated, `server.properties.bak` created with the previous content; the Logs screen shows `cluster:config-sync`.*
- [ ] In the member's `server.properties` put a comment containing `NGSM:ignore` at the end of the `motd` line (for example `motd=Mine # NGSM:ignore`) and sync again. *That line keeps the member's value.*
- [ ] Clear folders: add an old `.log` (set its date back or wait) to a member's `logs` folder, **Preview** then **Run**. *Only matching old files are deleted; folders and newer files stay.*

## 3. Backups (full, neat pick, restore, restore as new)
- [ ] Server > **Backups** tab > **Full** > create. *A zip and a `.json` manifest appear in `%APPDATA%\NodeGSM\backups\<id>`; the list shows size and mode.*
- [ ] Set retention (keep 2) and create 3 backups. *Only the newest 2 remain; the Logs screen shows `backup:pruned`.*
- [ ] **Neat pick**: tick a preset (e.g. World saves), expand the tree, tick one more folder, add an exclude pattern `*.tmp`, check the size estimate, create. *The zip contains only those paths.*
- [ ] **Restore** a Full backup after deleting a file in the server. *Server stops first; the file is back; optional settings restore asks separately.*
- [ ] **Restore as new server** from a Full backup. *A new server appears with the backup's game and settings; if the port was taken it moved to the next free one; the original is untouched.*
- [ ] Restore as new from a **Neat pick** backup. *Game files are installed (needs internet) and then the picked files applied.* (slow: SteamCMD / download)
- [ ] Delete the original server, open **Home > Backups**. *Its backups are listed marked as deleted; restore as new still works.*
- [ ] Home > Backups filters, **Open folder**, **Delete**. *They behave as labelled.*
- [ ] Try on a multi-GB server once. *Memory use stays flat during the backup; zip opens in 7-Zip / Windows.*

## 4. Discord webhook, embed editor, alerts
- [ ] Discord view: paste a throw-away webhook URL, **Send test**. *Status text under the field says it worked and the message shows in the channel.* A non-Discord URL is rejected.
- [ ] Open the embed editor for **Server started**: change title, colour, add a field, thumbnail URL. *The live preview updates while typing; **Send test** posts an embed that looks like the preview (compare it to the reference you want - see OPEN-QUESTIONS).*
- [ ] Switch to **Simple message** mode and back; **Reset to default**. *Template returns to the default look.*
- [ ] Turn events on / off (stopped, crashed, backup ...), save. Start / stop a server and create a backup. *Only toggled-on events reach the channel, with `{server}`, `{game}`, `{ip}`, `{port}` filled in.*
- [ ] Server > Automation: per-server webhook and an event override set to Off. *That server no longer posts that event.*
- [ ] Kill the server process in Task Manager. *A "crashed" message is sent (and an auto-restart one if enabled).*

## 5. Discord bot (needs a bot token)
Follow [GUIDE-discord.md](GUIDE-discord.md) > "Set it up".
- [ ] Paste token, application id, guild id, your user id; enable the bot; **Save bot settings**. *Badge goes Connecting then Online - commands registered; typing `/` in the guild lists the 9 commands.*
- [ ] `/check`, `/list`, `/stats`. *Embeds with version / uptime, server table, CPU / RAM / tick; `/stats` may say "no metrics yet" in the first seconds.*
- [ ] `/start`, `/stop`, `/restart`, `/update`, `/backup` with the autocomplete (`id - name`). *The server changes state; long ones show "thinking", then an embed. Wrong state (stop a stopped server) gives a private refusal.*
- [ ] Use the bot from an account that is **not** on the allow list. *"You are not authorised" (only visible to that user); the Logs screen has a `discord:command` entry with the result.*
- [ ] Spam 6 commands in 10 s. *The 6th is rate limited.*
- [ ] `/send` with the switch off. *Refused.* Turn **Allow raw console commands** on and send `say hi`. *Runs on the server; the bot reply does not echo the text.*
- [ ] Disable the bot / **Remove saved token**. *Badge goes Off; after **Remove saved token** the token is gone from `settings.json` (open the file and check).*
- [ ] Disconnect the network for a minute and reconnect. *The bot comes back by itself (discord.js reconnect).*

## 6. NGSM event log
- [ ] Start, stop, restart, update, backup, send a console command, edit a config file. *Home > Logs shows each entry with server and message.*
- [ ] Filter by server, level, event and text; Auto refresh; **Export** (opens text); **Clear**. *Each works; Clear empties the list.*
- [ ] Plugin patterns: with the `mc` plugin let a player join (or a pattern you added). *A `pattern:` / `game:` entry appears at most once per 10 s per pattern.*
- [ ] Look at `%APPDATA%\NodeGSM\logs`. *One `ngsm-YYYY-MM-DD.log` per day (JSON lines); files older than the retention (30 days) are gone after a day or a restart.*

## 7. Files auto-clear
- [ ] Server > **Files** > right-click a folder > **Auto-clear this folder...**: pattern `*.log`, older than 1 day, every 5 minutes, **Preview**. *Lists the matching old files, deletes nothing.*
- [ ] Save, then **Run now**. *Only matching old files (by modified time) are deleted; sub-folders stay; counts shown.*
- [ ] Wait for the interval with the server running and the rule set to "only when stopped". *Nothing is deleted until the server stops.*
- [ ] Lock a matching file (the running server's open log). *It is skipped and counted, not an error.*
- [ ] Check an `mc` server: **Files** shows the seeded plugin rule for `*.log.gz` (enabled) and crash reports (off). Edit / delete a rule and reload plugins. *Your edits stay.*
- [ ] Restart the app. *Rules and their last run are still there.*

## 8. Configs editor, consoles / RCON, Validate
- [ ] Home > Configs: pick a server and `server.properties`. *Structured rows with search; change a value, add a key, remove a key, Save.* Compare the file in a text editor. *Comments and unknown lines are unchanged; only the edited lines differ; `.bak` exists.*
- [ ] Toggle **Raw**, edit, toggle back. *Content stays consistent; an unparseable file (e.g. an `.xml`) says why it is raw only.*
- [ ] Minecraft: set `enable-rcon=true`, `rcon.password=test`, `rcon.port=25575` in `server.properties`, restart the server. Console tab > **RCON**: type `list`. *The player list answer appears; wrong password shows "authentication failed" without printing the password.*
- [ ] Console tab > **log** console (`latest.log`). *Read-only tail, follows new lines.*
- [ ] Source server (CS:GO): `rcon_password` in `server.cfg`, console tab RCON: `status`. *Answer shown (srcds has no stdin, RCON is the only way).*
- [ ] **Update** vs **Validate** buttons (server header and Table toolbar). *Status text shows `Updating` or `Validating`; Validate asks for confirmation.*

## 9. Server tick and Latency
- [ ] Paper / Spigot server with RCON on: Settings > table columns > tick on; wait 15-30 s. *Table shows a coloured **Tick** (TPS), the dashboard shows the Server tick tile and the header **Tick** stat (names in the tooltip).*
- [ ] Vanilla 1.20.3+ server (`rcon:tick query`). *ms per tick shown; 50 ms is yellow / red by thresholds; the unused `tps` metric just shows nothing (the server console may log "unknown command").* 
- [ ] CS:GO server with RCON: `fps` via `stats`. *FPS appears; tick target 64.*
- [ ] Rust: `fps` via the console. *FPS appears (console must be reachable).*
- [ ] A game without a tick metric (e.g. an A2S game). *Shows **Latency** (ms), never "Tick"; header Tick says n/a.*
- [ ] Stop RCON on the game. *The tick value disappears after the stale time; no error popups.*

## 10. Table, bulk actions and dashboard
- [ ] Table view: select several servers (checkbox, Ctrl / Shift click), **Start / Stop / Restart / Kill / Update / Backup**. *Buttons enable only where they apply; skipped servers are reported.*
- [ ] Settings > columns: add / remove / reset. *Table and Dashboard follow.*
- [ ] Dashboard: leave it open for 5 minutes with a server running. *CPU / memory / players update every 5 s; the history chart fills; follows the theme.*

## 12. Web mode and Linux (needs a Linux box or VM; web mode alone also works on Windows)
Web mode (any OS):
- [ ] `NODEGSM_DATA=<temp> npm run serve`; note the token printed on first start. Open `http://127.0.0.1:8730`. *Redirected to the login page; a wrong token shows an error; after 5 wrong tries "Too many failed attempts".*
- [ ] Log in. *The normal UI loads; start / stop a server and watch the status and console update live without reloading (WebSocket).* Restart the service. *You are sent back to the login page.*
- [ ] Check what is hidden: Folder button, Browse (Import: type the path instead), Install plugin (ZIP / folder), Plugins folder, hardware acceleration / start on login / tray / auto restart. *All hidden. Backups show Download instead of Open folder and the zip downloads.*
- [ ] `curl -s http://127.0.0.1:8730/healthz`. *`{"ok":true}`.* `curl -X POST http://127.0.0.1:8730/api/list -H "Content-Type: application/json" -d "{}"`. *401.* The same with `-H "Authorization: Bearer <token>"`. *Server list.*
- [ ] Behind nginx with TLS (`deploy/nginx.conf.example`, `NODEGSM_HTTPS=1`). *Login works, the cookie is `Secure`, live updates keep working (WebSocket upgrade).*
- [ ] Ctrl+C / `systemctl stop nodegsm` with a running server. *The game server stops gracefully.*

Linux only (everything here is **untested**):
- [ ] Fresh Ubuntu / Debian, Node 20, `lib32gcc-s1` installed. *`npm ci --omit=dev` and `npm run serve` start without Electron.*
- [ ] Add a **Minecraft Java** server (needs Java) and install. *server.jar downloads, Start works, stop sends `stop`.* Add a **Counter-Strike: GO** server. *SteamCMD downloads from `steamcmd_linux.tar.gz`, `srcds_run` starts (needs `lib32stdc++6`).* Try **Rust** and **Palworld** the same way and note what fails.
- [ ] A plugin that is not declared for Linux (for example `cs`) in Add Server. *Badge "not available on this platform", cannot be created.*
- [ ] Dashboard CPU / memory of a running server (read from `/proc`). *Plausible values, children are counted.* Kill. *No orphan processes left (`ps`).*
- [ ] Set CPU affinity on a server (`taskset` installed). *`taskset -p <pid>` shows the mask.*
- [ ] Firewall button. *Message with a ufw hint, nothing changed.*
- [ ] `docker compose up -d --build`; `docker ps` shows healthy; `deploy/nodegsm.service` starts and survives a reboot.

## 11. Website and docs
- [ ] `npm run site` then `npm run site:serve`, open the printed address. *Header shows the N mark; the browser tab shows the favicon; Features page lists the tables and the changelog newest first.*
- [ ] Open [docs/README.md](README.md) on GitHub. *Every link works.*
