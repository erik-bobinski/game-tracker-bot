# riot-tracker-bot verification map

Run the app and check the testing Discord server. Read this index, then the feature file for the behavior under test.

## Baseline preconditions

- Node 24 (`nvm use 24`; prepend `$NVM_BIN` to `PATH` on cloud VMs).
- Ambient `DISCORD_BOT_TOKEN` and `NOTIFICATION_CHANNEL_ID`, or a Railway project token in `RAILWAY_TOKEN`. Cursor Cloud injects that token as `RAILWAY_API_TOKEN_DEV` / `RAILWAY_API_TOKEN_PROD`; the proof script copies the dev one onto `RAILWAY_TOKEN`.
- `pnpm start` with ambient env. Do not use `pnpm dev`.
- Isolated database for any bot or admin process: `DB_PATH=/tmp/riot-verify-$RUN_ID.sqlite`.
- Browser login only when `AGENT_EMAIL`, `AGENT_EMAIL_PASSWORD`, and `DISCORD_TEST_CHANNEL_URL` are all set. Otherwise Discord REST, and say the browser path is blocked.

## Driving conventions

- Discord proof: `node .cursor/skills/verify-riot-tracker-bot/scripts/discord-rest-proof.mjs`
- One-off admin steps: `pnpm admin … --json` (never prompt).
- Do not set `VERIFY_RIOT_ID` when `RAILWAY_API_TOKEN_DEV`, `RAILWAY_API_TOKEN_PROD`, or `RAILWAY_TOKEN` is present.
- Do not `pnpm start` the production bot token while production is connected. Use the dev environment.

## Proof and skip reporting

- `report.json` in the artifact directory is the Discord proof (message id and embed title).
- `browser.json` records whether the UI secrets were available. It never stores the values.
- `slash-commands.json` is the command list from Discord REST.
- A missing UI secret or a captcha / email code / 2FA stop is `browser: blocked`, not a failed report, once REST shows the embed.

## Features

- [Bot boot](./bot-boot.md)
- [Signup](./signup.md)
- [Refresh](./refresh.md)
- [Report mock embed](./report-mock.md)
