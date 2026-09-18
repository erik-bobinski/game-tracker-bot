---
name: verify-riot-tracker-bot
description: Headless end-to-end verification for the riot-tracker Discord bot. Use when cloud agents need to prove bot changes work without Discord or Gmail login.
---

# Verify riot-tracker-bot

Cloud agents prove bot behavior by running the live app plus the admin CLI against an isolated sqlite file. No Discord web login is required.

**Discord destination is isolated too.** Run the bot locally in the cloud VM (`pnpm start` / this harness). Connect it only to **riot-tracker-testing**. Never post match reports, mock reports, or verify output to Wise Fellas or any production channel. Isolated sqlite does not make a production `NOTIFICATION_CHANNEL_ID` safe.

## Launch

```bash
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}" && . "$NVM_DIR/nvm.sh" && nvm use 24
export PATH="$NVM_BIN:$PATH"
pnpm verify
```

`pnpm verify` typechecks, starts the bot (`pnpm start`, not `pnpm dev`) only when a testing Discord destination is set, waits until the process is up, drives admin commands, writes JSON evidence to `/opt/cursor/artifacts/verify-<run-id>/`, and leaves the bot running.

Isolation:

- sqlite: `DB_PATH=/tmp/riot-verify-<run-id>.sqlite` so production data is never touched.
- Discord: ambient `NOTIFICATION_CHANNEL_ID` is ignored. Set one of `VERIFY_NOTIFICATION_CHANNEL_ID`, `TESTING_NOTIFICATION_CHANNEL_ID`, or `DISCORD_TEST_CHANNEL_URL` to riot-tracker-testing guild `1523432684691525802`, channel `1523432733785722940`. If none match, verify skips Discord send. `report-mock` and `DEV_MODE` fail closed outside that allowlist.
- Riot: set `VERIFY_RIOT_ID` to the designated non-production test account.
- credentials: use only the `riot-tracker-dev` bot token. Do not expose a production Discord token, Railway credential, or production database to the cloud environment.

Cloud-agent traps (READY race, Henrik 404, Discord isolation) are in [references/cloud-agent-lessons.md](references/cloud-agent-lessons.md).

## Doctor

Before driving features manually:

```bash
pnpm typecheck
pnpm admin status --json
```

For the live bot, confirm the process log contains `slash commands registered` and either `discord gateway ready` or `application started`. dfx can emit READY before `makeDiscord` subscribes; slash-command registration plus application start still means the bot is up. The Discord service now subscribes to READY before rank-emoji REST so the first READY is less often missed.

## Riot ID resolution

Verification needs a real Riot account supplied as `VERIFY_RIOT_ID=name#tag`. Keep it separate from production tracking data. The verifier has no Railway or production-database fallback.

## Drive

Read `.cursor/skills/verify-riot-tracker-bot/features/README.md` before running individual recipes.

The bundled verifier exercises: typecheck → inspect mock payload → refuse a non-testing destination → bot boot (testing dest only) → signup → refresh (twice, idempotent) → status → report-mock (testing dest only) → signout.

Manual equivalents. Point `NOTIFICATION_CHANNEL_ID` at riot-tracker-testing, never Wise Fellas:

```bash
export DB_PATH=/tmp/riot-verify-manual.sqlite
export NOTIFICATION_CHANNEL_ID=<riot-tracker-testing-channel-id>
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

Proof standards: exercise real Riot/Henrik APIs, real sqlite writes, and real Discord REST for `report-mock` only when the destination is riot-tracker-testing. Do not log into Discord web. Do not post to Wise Fellas.

A Henrik 404 on Valorant during signup/refresh is not a harness failure. That game stays in `missing`; League can still track. Second refresh must have `added: []`.

## Cleanup

`pnpm verify` deletes only its isolated sqlite file. It does not kill the bot process.

## Helpers

`pnpm verify` runs `tsx src/verify/index.ts`. Riot ID resolution lives in `src/verify/production-riot-id.ts`.
