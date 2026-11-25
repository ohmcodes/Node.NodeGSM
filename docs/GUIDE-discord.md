# NodeGSM - Discord

Open **Discord** in the left navigation.

## Webhook alerts
1. In Discord: channel settings > Integrations > Webhooks > New webhook > **Copy Webhook URL**.
2. Paste it into **Webhook alerts** and press **Send test** (it saves the field first and posts a test message). The result is shown under the field.
3. Switch on the events you want in the **Events** list and press **Save all**.

Only `https://discord.com/api/webhooks/<id>/<token>` (and `discordapp.com`) URLs are accepted. The URL is a secret - anyone who has it can post to your channel. It is stored in `settings.json` as plain text.

## Events
Server started, stopped, crashed, restarted, updated, backup created, backup restored - plus the extra events that your game plugins declare (`game:...`, see [PLUGINS.md](../PLUGINS.md)). Default on: started, crashed, restarted, updated.

## Message editor
Click an event to edit how its message looks. Two modes:
- **Simple message** - one line of text.
- **Embed** - title, description, colour, thumbnail URL, image URL (https only), footer and up to 10 fields (name, value, inline). The fallback text is used when an embed would be empty.

Placeholders work in text fields: `{server}` `{event}` `{game}` `{ip}` `{port}` `{players}` `{time}` and also `{id}` `{reason}` `{file}` `{message}`. The **Preview** imitates a Discord embed and updates while you type. **Reset to default** restores the built-in look (started green, stopped grey, crashed red, restarted / updated blue, backup / restore teal). **Send test with this template** posts the current, even unsaved, template with sample values. NodeGSM never lets a message ping `@everyone` or roles.

## Per-server webhook and overrides
- Each server still has its own webhook in **server > Automation > Discord alerts** with the old checkboxes (Start, Auto restart, Auto update, Crontab restart, Crash). They keep working and decide what that webhook receives; other events (stopped, backup ...) follow the event toggles.
- **Discord event overrides** (same tab): per event Default / On / Off for this server. An override wins over the global toggle for both webhooks.
- The message design (templates) is shared by all servers.

## When Discord is slow
Messages are queued and sent with a short delay. If Discord answers "rate limited" NodeGSM waits the time Discord asks for and retries (also on server errors). A failing webhook never affects your servers.

## Bot (slash commands)
The bot lets people control servers from Discord. It is optional and **off by default**.

> **Not tested against real Discord yet.** The commands, permissions and registration are covered by unit tests with fake interactions and a fake discord.js client; a live test needs a real bot token. Please try it once on a test server and report problems.

### Commands
| Command | Does |
|---|---|
| `/check` | NodeGSM version, uptime, servers running / total, CPU and RAM |
| `/list` | every server: id, name, game, status, players |
| `/start serverid` `/stop serverid` `/restart serverid` | lifecycle; refused when the server is busy (installing, updating, backing up) or in the wrong state |
| `/update serverid [validate]` | update (stops and restarts a running server); `validate:true` re-checks every game file |
| `/backup serverid` | creates a backup, answers with the file name |
| `/stats` | system CPU / RAM / disk plus CPU, RAM, players and tick of each running server |
| `/send serverid command` | a console command; **only when "Allow raw console commands" is on** |

`serverid` autocompletes as `id - name`. Long operations show "thinking" and then the result as an embed; refusals and errors are private (only the person who ran the command sees them). Replies never ping anyone.

### Set it up
1. Open the [Discord Developer Portal](https://discord.com/developers/applications) > **New Application**. Copy the **Application ID** (General Information).
2. **Bot** tab > **Reset Token** and copy the token. Leave all privileged intents off: slash commands need none (NodeGSM only asks for the Guilds intent).
3. In NodeGSM > **Discord** > **Bot**: paste the token and the application id. Optionally enter your **Server (guild) ID** (Discord settings > Advanced > Developer Mode, then right-click the server > Copy Server ID): commands then appear in that server immediately, otherwise they are global and Discord can take up to an hour to show them.
4. Click **Copy invite link**, open it in a browser and add the bot to your server (the link asks for the `applications.commands` and `bot` scopes with no extra permissions).
5. Add who may use it (below), switch **Enable the bot** on and **Save bot settings** (or **Reconnect**). The badge shows *Connecting*, then *Online - commands registered*. The commands appear when you type `/` in the server.

### Who may use it
- **Allowed user IDs:** Discord user ids (Developer Mode > right-click the user > Copy User ID), one per line.
- **Admin role IDs:** members with one of these roles are allowed (Server settings > Roles > right-click the role > Copy Role ID).
- **Default deny:** with no user ids and no admin roles nobody can use any command (the page shows a warning). Allowed users and admin roles can use every command; the lists are read live, no reconnect needed.
- **Per server (optional):** put `"discordAllowedUserIds": ["<user id>"]` into the server's `configs/wgsm.json` to limit that server to those users; admin roles can still use it. There is no UI for this yet.
- **Rate limit:** 5 commands per 10 seconds per user.
- Everyone who tries a command - allowed or not - is written to the NGSM log (**Logs** screen, event `discord:command`: Discord id and tag, command, server, result). Denied users only see "You are not authorised".

### `/send` is dangerous
With **Allow raw console commands** on, every allowed user can run any console command on any server they may control (kick, ban, change a password, `stop`). Leave it off unless you trust everyone on the list and the admin roles. The command must be one line of at most 500 characters; the bot does not echo it back and does not store the text in its own log entry (the server's normal `server:command` entry still does). If a command needs a secret, run it in the NodeGSM console instead.

### The token is stored in plain text
The bot token is saved **unencrypted** in `settings.json` in the NodeGSM data folder (`%APPDATA%\NodeGSM` or the legacy folder). NodeGSM never shows it again, never sends it to the interface and removes it from error messages and logs, but anyone who can read that file or a backup of it can control your bot. Do not share or upload `settings.json`. If it leaks: Developer Portal > Bot > **Reset Token**, then enter the new one. **Remove saved token** deletes it from NodeGSM.

### Troubleshooting
- *The bot token does not look valid*: the token has three parts separated by dots; paste it without quotes.
- *An invalid token was provided*: reset the token in the portal.
- *Registering the slash commands failed (Missing Access)*: the bot is not in that guild (use the invite link) or the guild id is wrong; clear the guild id to register globally.
- Commands missing: global commands take up to an hour; use the guild id for instant registration.
- Commands show "not authorised": check the user id (not the username) and the role ids; roles work only with admin role ids.
- Long updates: Discord allows editing the reply for 15 minutes; if an update takes longer the work still finishes, only the final message is lost (see the NGSM log).
