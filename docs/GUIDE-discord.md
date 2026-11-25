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

## Bot (slash commands) - coming
`/list`, `/start`, `/stop`, `/restart`, `/backup` ... with user / role permissions will be configured on this page in a later release.
