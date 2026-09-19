---
name: verify-riot-tracker-bot
description: Headless end-to-end verification for the riot-tracker Discord bot. Use when cloud agents need to prove bot changes work without Discord or Gmail login.
---

# Verify riot-tracker-bot

Cloud agents prove bot behavior by running the live app plus the admin CLI against an isolated sqlite file. No Discord web login is required.

**Discord destination is isolated too.** Run the bot locally in the cloud VM (`pnpm start` / this harness). Connect it only to the explicitly configured testing guild and channel. Never post match reports, mock reports, or verify output to a production destination. Isolated sqlite does not make an ambient `NOTIFICATION_CHANNEL_ID` safe.

## Launch

```bash
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}" && . "$NVM_DIR/nvm.sh" && nvm use 24
export PATH="$NVM_BIN:$PATH"
pnpm verify
```

`pnpm verify` typechecks, starts the bot (`pnpm start`, not `pnpm dev`) only when a testing Discord destination is set, waits until the process is up, drives admin commands, writes JSON evidence to `/opt/cursor/artifacts/verify-<run-id>/`, and leaves the bot running.

Isolation:

- sqlite: `DB_PATH=/tmp/riot-verify-<run-id>.sqlite` so production data is never touched.
- Discord: ambient `NOTIFICATION_CHANNEL_ID` is ignored. Configure `TESTING_DISCORD_GUILD_ID` plus `TESTING_NOTIFICATION_CHANNEL_ID`, or `DISCORD_TEST_CHANNEL_URL`. `VERIFY_NOTIFICATION_CHANNEL_ID` may select only the configured testing channel. Missing or conflicting values skip Discord send. `report-mock` and `DEV_MODE` fail closed outside that destination.
- Riot: set `VERIFY_RIOT_ID` to the designated non-production test account.
- credentials: use only a testing bot token. Do not expose a production Discord token, a production Railway token, or a production database to the cloud environment.
- Railway: `RAILWAY_API_TOKEN_DEV` is allowed. It is a `dev`-environment-scoped Railway project token used read-only. Export it as `RAILWAY_TOKEN` only while running Railway CLI, and keep `RAILWAY_API_TOKEN` unset. Production Railway tokens, environments, databases, deploys, and mutations remain forbidden.

Cloud-agent traps (READY race, Henrik 404, Discord isolation) are in [references/cloud-agent-lessons.md](references/cloud-agent-lessons.md).

## Doctor

Before driving features manually:

```bash
pnpm typecheck
pnpm admin status --json
```

For the live bot, confirm the process log contains `slash commands registered` and either `discord gateway ready` or `application started`. dfx can emit READY before `makeDiscord` subscribes; slash-command registration plus application start still means the bot is up. The Discord service now subscribes to READY before rank-emoji REST so the first READY is less often missed.

## Riot ID resolution

Verification needs a real Riot account supplied as `VERIFY_RIOT_ID=name#tag`. Keep it separate from production tracking data. If Cursor secrets omit that account or the testing Discord destination, load them read-only from the Railway `dev` environment with `RAILWAY_API_TOKEN_DEV` (exported as `RAILWAY_TOKEN` for CLI only; `RAILWAY_API_TOKEN` stays unset). Never fall back to production Railway or a production database.

## Drive

Read `.cursor/skills/verify-riot-tracker-bot/features/README.md` before running individual recipes.

The bundled verifier exercises: typecheck → inspect mock payload → refuse a non-testing destination → bot boot (testing dest only) → signup → refresh (twice, idempotent) → status → report-mock (testing dest only) → signout.

Manual equivalents. Point all Discord variables at the dedicated testing destination:

```bash
export DB_PATH=/tmp/riot-verify-manual.sqlite
export TESTING_DISCORD_GUILD_ID=<testing-guild-id>
export TESTING_NOTIFICATION_CHANNEL_ID=<testing-channel-id>
export NOTIFICATION_CHANNEL_ID="$TESTING_NOTIFICATION_CHANNEL_ID"
pnpm start   # separate terminal
pnpm admin signup <riot-id> --discord-id verify-agent-user --json
pnpm admin refresh verify-agent-user --json
pnpm admin report-mock --game lol --json
pnpm admin status --json
```

## Evidence

Capture under `/opt/cursor/artifacts/verify-<run-id>/`:

- `results.json` — every step with stdout/stderr
- `bot.log` — boot excerpt showing the process is up

Proof standards: exercise real Riot/Henrik APIs, real sqlite writes, and real Discord REST for `report-mock` only when the destination is the configured testing server. Do not log into Discord web. Do not post verification output to production.

A Henrik 404 on Valorant during signup/refresh is not a harness failure. That game stays in `missing`; League can still track. Second refresh must have `added: []`.

## Cleanup

`pnpm verify` deletes only its isolated sqlite file. It does not kill the bot process.

## Helpers

`pnpm verify` runs `tsx src/verify/index.ts`. Riot ID resolution lives in `src/verify/production-riot-id.ts`.
