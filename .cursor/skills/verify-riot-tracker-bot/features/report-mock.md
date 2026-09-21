# Report mock embed

Posts a mock match scoreboard into the notification channel.

## Sub-features

- `/dev_report` — Discord user posts the mock embed (needs a running bot with `DEV_MODE=true`)
- `report-mock` — admin CLI posts the same mock embed over Discord REST (no gateway)

## How to get to it (user POV)

In the testing server, with the dev bot online: `/dev_report`, option `game`, choice `lol` or `val`.

The bot answers in that channel and posts the scoreboard to `NOTIFICATION_CHANNEL_ID`. That channel is not read from `DISCORD_TEST_CHANNEL_URL`. If those ids differ, the embed is in the notification channel.

Operators: `pnpm admin report-mock --game lol --json`.

## Driving it with the proof script

Preconditions: Node 24. Dev bot token via ambient env or `RAILWAY_API_TOKEN_DEV` as `RAILWAY_TOKEN`.

- Action: `node .cursor/skills/verify-riot-tracker-bot/scripts/discord-rest-proof.mjs`
- Browser, only when `AGENT_EMAIL`, `AGENT_EMAIL_PASSWORD`, and `DISCORD_TEST_CHANNEL_URL` are set: log in at `https://discord.com/login`, open the test channel, submit `/dev_report` with `lol`. Stop on captcha, email code, or 2FA and record browser blocked.
- REST, when those secrets are unset or login is blocked: the script lists global slash commands, runs `pnpm admin report-mock --game lol --json`, and reads the new channel message.
- Observable: exit 0, `report.json` has `channelId`, `matchId`, `messageId`, and an embed title starting with `Victory`. `slash-commands.json` includes `dev_report` after the dev bot has registered commands. `browser.json` says `blocked` when the UI secrets are missing.

## Gotchas

- Admin passes an empty rank-emoji map; a live `/dev_report` uses provisioned rank emojis. The title and scoreboard text still match.
- Do not start this feature's bot with the production token. Production is already on that gateway, and registration would replace production's global commands.
- Production leaves `DEV_MODE` unset, so its command list has no `dev_report`. The dev environment has `DEV_MODE=true`.
- Reuses `buildMockMatchReport` for both the slash command and the admin command.
