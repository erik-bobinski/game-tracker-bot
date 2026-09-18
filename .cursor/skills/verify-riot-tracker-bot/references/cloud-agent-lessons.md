# Cloud agent lessons

Lessons from running `pnpm verify` on Cursor Cloud.

## NEVER post verify or mock reports to production

This already happened: a verify / `report-mock` run inherited an ambient production `NOTIFICATION_CHANNEL_ID` and posted a Components V2 mock there. That is unacceptable.

Rules:

- Run the bot locally in the cloud VM (`pnpm start` / `pnpm verify`).
- Connect that local bot only to the explicitly configured testing destination.
- Never inherit a production `NOTIFICATION_CHANNEL_ID` for verify or mock reports.
- Isolated sqlite is not enough. Discord destination must be isolated too.
- Do not give the cloud environment a Railway credential or production database.
- `pnpm verify` ignores ambient `NOTIFICATION_CHANNEL_ID`. Configure `TESTING_DISCORD_GUILD_ID` plus `TESTING_NOTIFICATION_CHANNEL_ID`, or `DISCORD_TEST_CHANNEL_URL`.
- If testing values are missing or conflict, skip Discord send. Do not fall back. `report-mock` and `DEV_MODE` allow only the configured testing guild and channel.
- Supply a designated test account through `VERIFY_RIOT_ID`; never resolve one from production.

## Bot boot race

dfx can emit READY before `makeDiscord` subscribes. `src/services/discord/index.ts` subscribes to READY before rank-emoji and command REST.

`pnpm verify` treats the process as up when it sees `discord gateway ready`, or both `slash commands registered` and `application started`. READY often arrives a moment later. Do not fail the run only because READY was late.

## Valorant Henrik 404

A 404 whose body asks the player to finish a game is a missing game, not a harness failure. League can still be in `games` / `tracked`. Second refresh must have `added: []`.

## Cloud runtime

- Node 24. Node 22 crashes on the sqlite native import.
- `pnpm start` with ambient env. `pnpm dev` wants a `.env` file that does not exist here.
- Leave the verify bot running. The harness deletes only its isolated sqlite file.
