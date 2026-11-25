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
Nobody, until you say so (**default deny**). There are three ways to give access; they add up:

| Source | Rights |
|---|---|
| **Admin role IDs** | members with one of these roles may do everything on every server (Server settings > Roles > right-click the role > Copy Role ID) |
| **Permission rules** (below) | exactly what each rule lists, per user and per server |
| *Allowed user IDs* (deprecated) | the old list: every command on every server (except servers restricted by `discordAllowedUserIds`, see below). Kept so existing setups keep working; use rules instead |

With no rule, no allowed user id and no admin role nobody can use any command (the page shows a warning). Everything is read live: no reconnect is needed after saving.

### Permission rules: who may do what on which server
In **Discord > Bot > Permissions per user and server** write one rule per line:

```
<discordUserId> <serverId> <action,action,...>
```

- **discordUserId:** the person's Discord user id (Developer Mode > right-click the user > Copy User ID), 15 to 25 digits (not the username).
- **serverId:** the NodeGSM server id (shown in the server list and by `/list`), or **`0`** (also `*`) for **all servers**.
- **actions:** comma separated, case does not matter, spaces around the commas are fine.
- Lines starting with `#` (or the part after a `#`) are comments. Several rules for the same user and server are merged; rules for one server and for `0` are combined (a user gets the union).
- The editor checks every line while you type: bad lines are listed with their line number and block saving; a server id that does not exist yet is only a warning (you may create the server later). A table below shows who may do what, with server names.

| Action | Allows | Scope |
|---|---|---|
| `check` | `/check` | global: any rule that lists it is enough (the server id is ignored) |
| `list` | `/list` | global, but the list shows only the servers the user has **any** permission for (all servers when a rule has server `0`) |
| `stats` | `/stats` | global; the per-server lines show only servers the user has any permission for |
| `start` `stop` `restart` `update` `backup` | the same commands | only on the servers of a matching rule (or all servers with `0`) |
| `send` | `/send` | like the above, **and** it only works while **Allow raw console commands** is switched on |
| `all` | shortcut: every action above | |
| `read` | shortcut: `check`, `list`, `stats` | |

The server autocomplete only offers servers the user may use for that command.

**Examples**
```
# a moderator who may only restart server 3
123456789012345678 3 restart

# read-only on every server: /check, /list, /stats
234567890123456789 0 read

# an operator for servers 1 and 2: start, stop, back up
345678901234567890 1 start,stop,backup
345678901234567890 2 start,stop,backup

# a co-owner: everything everywhere (/send still needs the switch)
456789012345678901 0 all
```
**Nobody / none:** just have no line for that person (and no entry in the deprecated list or an admin role). There is no "deny" rule; permissions are only ever added.

**Denied attempts:** the user gets a private message naming what is missing ("You do not have permission to use /restart on server 4.", it never shows the rules) and the NGSM log entry `discord:command` records `result: denied: missing permission`, `required` (the action) and the server id. Successful entries record `via` (`admin`, `rule` or `legacy`).

**Interaction with the per-server restriction:** a server's `configs/wgsm.json` may contain `"discordAllowedUserIds": ["<user id>"]` (no UI yet). It narrows only the **deprecated allowed-user list**: a legacy user who is not named there may not control that server. **Permission rules are authoritative** for their user: a rule for that server works even if the user is not in that list, and admin roles are never narrowed.

### Other limits
- **Rate limit:** 5 commands per 10 seconds per user.
- Everyone who tries a command - allowed or not - is written to the NGSM log (**Logs** screen, event `discord:command`: Discord id and tag, command, server, result, required action).

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
