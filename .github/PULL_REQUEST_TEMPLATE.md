## What does this PR do?
- [ ] Adds a new game plugin: `plugins/<id>`
- [ ] Fixes / updates an existing plugin: `plugins/<id>` (what changed in the game, with a link to patch notes / SteamDB / wiki):
- [ ] App code change (also updated FEATURES.md, README.md, PLUGINS.md as needed)

## Checklist (plugins)
- [ ] `npm run validate:plugins <id>` passes
- [ ] Folder name equals `id`; has `icon.png`, `README.md`, `author`, `version`, `description`
- [ ] Bumped `version` if I changed an existing plugin
- [ ] Ran `npm run registry` and committed `plugins/registry.json`
- [ ] Tested in the app: install -> start -> stop (or explain what I could not test)
- [ ] Config Files and Logs tabs open the declared files (or the game has none)
- [ ] No binaries or secrets; downloads come from the official source
- [ ] `plugin.js` is only used when JSON can't do it (explain why):

## Tested on
Windows version / game server version / anything else reviewers should know:
