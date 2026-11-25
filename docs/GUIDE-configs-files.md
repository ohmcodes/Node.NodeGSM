# NodeGSM - configs, files auto-clear, consoles, update and validate

## Config files (Home > Configs, and the server's "Config Files" tab)
Every game plugin can declare any number of config files (`configs[]` in its `plugin.json`). NodeGSM lists them for the selected server:

1. Open **Home > Configs** (pick the server at the top) or the server's **Config Files** tab.
2. Pick a file in the list on the left. When a game has several files **nothing opens until you choose one**; a game with a single file opens it right away. Files that do not exist yet are marked "missing"; **Create file** copies the plugin's template (or makes an empty file).
3. Edit it in one of two ways (the toggle above the editor):
   - **Structured** - one row per setting. Change a value and leave the field (Tab / Enter / click away) to apply it; **x** removes the line; the box at the bottom adds a key (for ini files you can name the `[Section]`, for json / yaml use dots: `network.port`). The **search** box filters keys and values.
   - **Raw** - the whole text. Always available.
4. **Save** (or Ctrl+S) writes the file; the previous version is kept next to it as `<file>.bak`. The edit is recorded in the NodeGSM log (**Home > Logs**).

What the structured editor understands:

| Format | Rows | Notes |
|---|---|---|
| `ini` | `Section.Key = value` | comments (`;` `#`), blank lines and unknown lines stay; new keys go to the end of their section |
| `properties` | `key=value` (also `key: value`) | Minecraft `server.properties`; dotted keys such as `rcon.port` are plain keys |
| `cfg` | `key value` | Source engine style, `//` comments stay; the value is shown exactly as written, with quotes |
| `json` | every value, nested paths with dots | numbers, true / false and null keep their type; lists of values can be typed as JSON (`["a","b"]`); the file is rewritten with its own indentation (comments cannot exist in JSON) |
| `yaml` | nested `key: value` pairs | simple YAML only: lists, anchors and `\|` / `>` blocks are kept but not shown |

Only the line you change is rewritten; comments, blank lines, unknown lines, line endings (CRLF) and a BOM are kept. If a file cannot be read safely - invalid JSON, a JSON file whose top level is a list (`ops.json`), YAML indented with tabs, xml, plain text - **Structured** is greyed out and the reason is shown; use **Raw**.

## Files auto-clear (server > Files tab)
Deletes old files on a schedule, for example log archives or crash dumps. A rule is: **folder** (relative to the server files), **file name pattern** (`*` and `?`), **older than N days** (by last-modified time, 0 = any age), **run every N minutes**, optional **include sub-folders**, optional **only while the server is stopped**, and **enabled**.

- Open the folder in the Files tab and press **Auto-clear this folder...** (or right-click a folder) to make a rule. The rules table below the file browser has the switch, **Run now**, **Preview** (shows what would be deleted, deletes nothing), **Edit** and **Delete**.
- Rules are checked every minute and a rule runs at most once per interval. They do not run while the server is being installed, updated or backed up.
- Safety: only **files** are deleted (never folders), links / junctions are never followed, nothing outside the server's folder can be reached, files the game has open (locked) are skipped and counted, and the rule folder may not contain `..`.
- The game plugin can suggest rules (`files.autoClear`). They are copied into the server's own list once: some start enabled (only things that are always safe, such as old compressed logs), some start disabled. After that they are yours - edit, disable or delete them; plugin updates never overwrite your changes and a rule you deleted does not come back. A suggested rule starts counting its interval when it is first copied, so nothing is deleted the moment you update the app.
- Every run that deleted something (and every manual run) is written to the NodeGSM log (`autoclear:run`).
- Rules live in the server's `wgsm.json` (`autoClear`); the format is in [TECH-data-formats.md](TECH-data-formats.md).

## Consoles (server > Console tab)
The **Game console** is the server's own text console (stdin / stdout), exactly as before. When the game plugin declares more consoles, sub-tabs appear above it:

- **Log consoles** follow a log file of the game (read-only, the input is disabled).
- **RCON consoles** send commands through the game's RCON (Source RCON; Minecraft uses the same protocol) and show the reply. The server must be running and RCON must be enabled in the game's own config (Minecraft: `enable-rcon=true`, `rcon.port`, `rcon.password` in `server.properties`; Source games: `rcon_password` in `server.cfg`). NodeGSM reads the port and password from those files each time you send a command, connects to `127.0.0.1` only, reconnects by itself after a dropped connection and never shows or logs the password. Messages: "authentication failed" = wrong password (restart the game after changing it), "timed out" / "connection failed" = RCON is not enabled or the port is wrong, "was not found" = the setting is missing in the config file.
- Commands typed in an RCON console are recorded in the NodeGSM log like normal console commands.

Games without `consoles[]` look unchanged. Plugin authors: see `consoles` in [PLUGINS.md](../PLUGINS.md) for the `rcon:<port>:<password>` source format.

## Update and Validate
- **Update** downloads the newest game version (a running server is stopped first and started again afterwards).
- **Validate** does the same and additionally re-checks **every** game file against the source and repairs damaged or modified ones (SteamCMD `validate`). It takes longer and can overwrite game files you edited by hand (config files are normally not part of the download). You are asked to confirm.
- Both are in the server header and in the Table toolbar (several servers one after another). While one runs the status shows **Updating** or **Validating** (with the percentage when the installer reports it).
- Plugin authors can change the words used for Validate with `update.validateArgs.steamcmd`; automatic updates never validate.
