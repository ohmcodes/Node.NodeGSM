# Writing a NodeGSM plugin

**Every game in NodeGSM is a plugin** - a folder with a `plugin.json`. The built-in games live in [`plugins/`](plugins) and are contributed by pull request ([CONTRIBUTING.md](CONTRIBUTING.md)); you can also add your own locally. No compiling, no app update.

```
plugins/palworld/
  plugin.json     required - the whole definition (this guide)
  icon.png        required - square PNG, 64-256 px
  README.md       required - shown in the in-app game browser and on the website
  banner.png      optional - wide image
  screenshots/    optional - 1.png, 2.png ...
  templates/      optional - default config files users can create with one click
  plugin.js       optional - custom code when JSON is not enough
```
Start by copying [`plugins/_template`](plugins/_template). A complete real example: [`plugins/palworld`](plugins/palworld). Editors that understand JSON Schema (VS Code) give auto-complete and errors from [`plugins/plugin.schema.json`](plugins/plugin.schema.json).

**Install a plugin locally:** in the app, **Games → Install plugin (ZIP / folder)**, or copy the folder into the plugins folder (**Games → Plugins folder**) and click **Reload**.
A local plugin with the **same id as a built-in one overrides it** - handy for fixing an obsolete game before your PR is merged.

**Check it:** `npm run validate:plugins <id>`.

## plugin.json

### Listing (shown in the game browser and on the website)
| Field | Required | |
|---|---|---|
| `id` | yes | unique, `a-z 0-9 _ -`, 2-32 chars. **Must equal the folder name** |
| `name` | yes | title, e.g. `Palworld Dedicated Server` |
| `description` | yes* | one or two sentences |
| `author`, `version` | yes* | semver version; bump it when you change the plugin |
| `url` | no | homepage / docs / SteamDB link |
| `tags` | no | search tags, e.g. `["survival", "steamcmd"]` |
| `color` | no | accent colour `#RRGGBB` |
| `media.icon` | yes | default `icon.png` |
| `media.readme` | yes* | default `README.md` |
| `media.banner` | no | e.g. `banner.png` |
| `media.screenshots` | no | e.g. `["screenshots/1.png", "screenshots/2.png"]` |

\* required for plugins submitted to the repository; local plugins only get warnings.

### install - get the server files
Shorthands:
```json
"install": { "type": "steamcmd", "appId": "2394010" }
"install": { "type": "manual" }
```
`manual` means the user must use **Import** (no automatic installer).

Or a list of **steps**, run in order. Everything happens inside the server's files folder; paths are relative and may not contain `..`.
```json
"install": {
  "steps": [
    { "type": "steamcmd", "appId": "90", "mod": "cstrike", "repeat": 5 },
    { "type": "download", "url": "https://example.com/tool.zip", "to": "tool.zip", "extract": true, "extractTo": "tools" },
    { "type": "run", "exe": "tools/vcredist_x64.exe", "args": ["/quiet", "/norestart"] },
    { "type": "mkdir", "path": "Game/Saved/Config" },
    { "type": "write", "path": "Game/Saved/Config/server.ini", "content": "[Server]\nName={name}\nPort={port}\n" },
    { "type": "script" }
  ]
}
```
| Step | Fields | What it does |
|---|---|---|
| `steamcmd` | `appId`, `mod`, `repeat`, `validate`, `beta` | install/update a Steam app. `mod` = GoldSource game via HLDS (`+app_set_config 90 mod X`); `repeat` runs the update several times |
| `download` | `url`, `to`, `extract`, `extractTo`, `deleteAfter` | download a file; optionally extract it (zip built in; 7z/tar.gz via Windows `tar`) and delete the archive |
| `extract` | `from`, `to` | extract an archive that is already there |
| `run` | `exe`, `args`, `cwd`, `ignoreExit` | run an installer (e.g. a redistributable) and wait for it |
| `write` | `path`, `content`, `overwrite` | create a file (only if missing, unless `overwrite`) |
| `mkdir` | `path` | create a folder |
| `script` | | call `install(h)` from `plugin.js` |

`url`, `to`, `path`, `content` ... accept the placeholders `{name} {ip} {port} {queryPort} {map} {maxPlayers} {serverFiles}`.
**Updates** re-run the `steamcmd` step only (when the game has one); otherwise all steps run again.

### run - start the server
```json
"run": {
  "exe": "Pal/Binaries/Win64/PalServer-Win64-Shipping-Cmd.exe",
  "workingDir": "",
  "args": ["{param}", "-port={port}", ["-queryport", "{queryPort}"], "-servername={name}"],
  "stdin": true,
  "stopCommand": "quit"
}
```
- `exe` - relative to the server files folder; use `/`. `command` runs another program instead (e.g. `"java"`), `exe` is then only used to check the install.
- `stdin: false` for srcds/hlds (a redirected console input breaks them). Console commands are disabled for those.
- `stopCommand` is written to the console to stop gracefully; NodeGSM then sends a soft `taskkill`, and force-kills after 15 s.

#### Argument templates (`run.args`)
Each list item becomes one command-line argument.
| Item | Meaning |
|---|---|
| `"-port={port}"` | placeholder inside text. If the value is empty the **whole argument is dropped** |
| `["-ip", "{ip}"]` | a **group**: all parts kept, or all dropped if any placeholder is empty |
| `"{param}"` | the user's *Start parameters*, split on spaces (quotes respected) |
| `"{paramRaw}"` | the raw parameter string pasted into the text (for ARK-style `Map?listen?Key=Value`) |
| `"[?Port={port}]"` | `[ ... ]` marks an **optional part** of one argument |
| `"{port+10}"` | placeholder plus a number |

Placeholders: `{name} {ip} {port} {queryPort} {map} {maxPlayers} {gslt} {param} {paramRaw} {serverFiles} {appId}`.
Values with spaces are passed safely as one argument - do not add quotes yourself.

### defaults
```json
"defaults": { "port": "8211", "queryPort": "8212", "map": "MainWorld5", "maxPlayers": "32",
              "additional": "-publiclobby", "portIncrement": 2 }
```
`additional` is the default *Start parameters*. `portIncrement` reserves several ports per instance when NodeGSM suggests free ports.

### query / gslt
`"query": "a2s" | "ut3" | "fivem" | null` - protocol used to show player counts and detect *Started*. `"gslt": true` shows a Game Server Login Token field.

### configs - editable config files (INI, JSON, ... any number)
```json
"configs": [
  { "id": "settings", "name": "PalWorldSettings.ini", "path": "Pal/Saved/Config/WindowsServer/PalWorldSettings.ini",
    "format": "ini", "description": "World options", "template": "templates/PalWorldSettings.ini" },
  { "id": "admins", "name": "admins.json", "path": "Saved/admins.json", "format": "json" }
]
```
They appear in the **Config Files** tab: edit, save (the previous version is kept as `.bak`), format/validate JSON, and **Create** a missing file (from `template` in the plugin folder, or empty).
`format`: `ini json xml properties cfg yaml text`. JSON is validated before saving.

### logs - live log viewer (any number)
```json
"logs": [
  { "id": "server", "name": "Server log", "path": "Pal/Saved/Logs/*.log", "description": "Newest file is followed" },
  { "id": "chat",   "name": "Chat log",   "path": "logs/chat.txt" }
]
```
They appear in the **Logs** tab as a list; click one to follow it live (filter, pause, errors/warnings highlighted). `*` and `?` are allowed in the **file name**; the newest match is followed, and it switches automatically when the game rotates its logs.

## plugin.js (optional)
Use it only when JSON cannot do the job (for example resolving the latest download URL). It runs with **full Node.js access** - only install plugins you trust; repository plugins get a security review.
```js
module.exports = {
  // install.steps contains { "type": "script" }  ->  this runs. h = helpers:
  //   h.dir, h.cfg, h.log(line), h.fetchJson(url), h.fetchText(url),
  //   h.download(url, relPath), h.extract(relFile, relDir), h.inside(relPath), h.steamcmd(appId, opts), h.fs, h.path
  async install(h) {
    const info = await h.fetchJson('https://example.com/latest.json');
    await h.download(info.url, 'server.zip');
    h.extract('server.zip', '.');
  },
  // update checks: latest(h) -> string, local(dir) -> string; shown as "update available" when they differ
  latest: async (h) => (await h.fetchJson('https://example.com/latest.json')).version,
  local: (dir) => '1.2.0',
  // replace run.args entirely: return an array of argv strings
  args: (cfg, ctx) => ['-port=' + cfg.port],
};
```
Real examples: [`plugins/mc`](plugins/mc), [`plugins/mcbe`](plugins/mcbe), [`plugins/vts`](plugins/vts), [`plugins/gta5`](plugins/gta5).

## Website / registry
`npm run registry` builds [`plugins/registry.json`](plugins/registry.json): id, name, description, author, version, tags, ports, install type, config/log lists and the **relative paths** of the icon, banner, README and screenshots (`plugins/<id>/...`). A website can fetch it from the repository (e.g. via `raw.githubusercontent.com`) to list the supported games with their README and screenshots. The in-app **Games** browser shows the same information.

## Converting a WindowsGSM C# plugin
| C# (`WindowsGSM.Plugins`) | `plugin.json` |
|---|---|
| `Plugin { name, author, description, version, url, color }` | `name`, `author`, `description`, `version`, `url`, `color` |
| `AppId` | `install: { "type": "steamcmd", "appId": ... }` |
| `StartPath` | `run.exe` (use `/`) |
| `Port`, `QueryPort`, `Defaultmap`, `Maxplayers`, `Additional`, `PortIncrements` | `defaults.port/queryPort/map/maxPlayers/additional/portIncrement` |
| `QueryMethod = new A2S()` | `"query": "a2s"` (`null` if `QueryMethod = null`) |
| the `param += ...` lines in `Start()` | `run.args` templates (`_serverData.ServerPort` -> `{port}`, `ServerName` -> `{name}`, `ServerIP` -> `{ip}`, `ServerMaxPlayer` -> `{maxPlayers}`, `ServerParam` -> `{param}`) |
| `Stop()` sending `^c` / `quit` | `run.stopCommand` |
| `RedirectStandardInput = false` (srcds) | `run.stdin: false` |
| `CreateServerCFG()` writing files | `install.steps` -> `write`, or `configs[].template` |
