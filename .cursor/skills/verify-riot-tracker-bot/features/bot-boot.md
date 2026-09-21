# Bot boot

Starts the Discord bot and confirms slash commands are registered.

## Sub-features

- `boot` — process starts without crash
- `commands` — slash commands register (`/dev_report`, `/dev_signup`, `/dev_clear`, `/dev_signout` when `DEV_MODE=true`)
- `gateway` — Discord gateway reaches ready, or the process is otherwise up

## How to get to it (user POV)

The bot is online in the testing server and `/dev_report` appears in the slash-command menu.

## Driving it with the proof script

Preconditions: Node 24. Use the dev bot token. Do not connect the production token while production is running.

- Action: `node .cursor/skills/verify-riot-tracker-bot/scripts/discord-rest-proof.mjs` (it starts `pnpm start` with `DEV_MODE=true` and an isolated `DB_PATH` against the dev environment).
- Observable: `bot.log` contains `slash commands registered` and `application started` or `discord gateway ready`. `slash-commands.json` includes `dev_report`.

Manual REST check, token stays in the environment:

```bash
# application id, then command names; do not echo the token
node --input-type=module -e '
const headers = { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` };
const app = await fetch("https://discord.com/api/v10/applications/@me", { headers }).then((r) => r.json());
const commands = await fetch(`https://discord.com/api/v10/applications/${app.id}/commands`, { headers }).then((r) => r.json());
console.log(commands.map((command) => command.name).sort().join("\n"));
'
```

## Gotchas

- Node 22 crashes on `@effect/sql-sqlite-node`. Use Node 24.
- `pnpm dev` needs a `.env` file. Cloud agents use `pnpm start`.
- dfx can emit READY before `makeDiscord` subscribes. `slash commands registered` plus `application started` means the bot is up.
- A second gateway on the production token disconnects production and bulk-replaces global commands. Boot the dev bot instead.
