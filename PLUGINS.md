# Writing a plugin

A plugin = a folder with a `plugin.json` (and optionally `icon.png` and `plugin.js`). No compiling, no app update.
Users install it by **Plugins -> Install from ZIP / folder**, or by copying the folder into the plugins folder
(`Plugins -> Open plugins folder`) and clicking **Reload**. The game then shows up under **Add Server**.

See [`examples/palworld`](examples/palworld) (port of WindowsGSM.Palworld) and [`examples/_template`](examples/_template).

## plugin.json

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | unique, lowercase `a-z 0-9 _ -` (2-32 chars). Must not collide with a built-in game |
| `name` | yes | shown in the game picker |
| `author`, `version`, `description`, `url`, `color` | no | metadata |
| `install.type` | yes | `steamcmd` (needs `install.appId`), `manual` (user must Import) or `script` (implement `install` in plugin.js) |
| `exe` | yes | start path relative to the server files folder (use `/` as separator) |
| `workingDir` | no | working dir relative to server files (default: server files root) |
| `defaults` | no | `port`, `queryPort`, `map`, `maxPlayers`, `additional` (default start params), `portIncrement` (ports reserved per instance) |
| `args` | no | array of argument templates (default `["{param}"]`) |
| `query` | no | `a2s`, `ut3`, `fivem` or null - enables player count / Started detection |
| `stopCommand` | no | text written to stdin on stop (default `quit`); then taskkill, then force kill after 15s |
| `gslt` | no | true = show a Game Server Login Token field |

### Argument templates
Each array item becomes one argv entry. Placeholders: `{name} {ip} {port} {queryPort} {map} {maxPlayers} {gslt} {param} {serverFiles}`.
- `{param}` on its own expands to the user's start parameters (split on spaces, quotes respected).
- If a placeholder in an item is **empty**, the whole item is dropped (so `-publicip={ip}` vanishes when no IP is set).
- Values with spaces are passed safely as a single argument - don't add quotes yourself.

## plugin.js (optional, for custom logic)
```js
module.exports = {
  // replace templates entirely: return an array of argv strings
  args: (cfg, ctx) => ['-port=' + cfg.port],            // ctx.serverFiles = install dir
  // custom installer (use with install.type = "script")
  install: async (dir, log, cfg) => { log('downloading...'); /* write files into dir */ },
  // update checks (strings compared for equality)
  latest: async () => '1.2.3',
  local:  (dir) => '1.2.0',
};
```
plugin.js runs with full Node access in the app: **only install plugins you trust**.

## Distributing
Zip the folder (plugin.json at the root, or inside a single sub-folder) and publish it, e.g. as a GitHub release.
