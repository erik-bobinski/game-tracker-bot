---
name: verify-riot-tracker-bot
description: Headless end-to-end verification for the riot-tracker Discord bot. Use when cloud agents need to prove bot changes work without Discord or Gmail login.
---

# Verify riot-tracker-bot

Cloud agents prove bot behavior by running the live app plus the admin CLI against an isolated sqlite file. No Discord web login is required.

## Launch

```bash
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}" && . "$NVM_DIR/nvm.sh" && nvm use 24
export PATH="$NVM_BIN:$PATH"
pnpm verify
```

`pnpm verify` typechecks, starts the bot (`pnpm start`), waits for `discord gateway ready`, drives admin commands, writes JSON evidence to `/opt/cursor/artifacts/verify-<run-id>/`, and leaves the bot running.

Isolation uses `DB_PATH=/tmp/riot-verify-<run-id>.sqlite` so production data is never touched.

## Doctor

Before driving features manually:

```bash
pnpm typecheck
pnpm admin status --json
```

For the live bot, confirm the process log contains `slash commands registered` and `discord gateway ready`.

## Riot ID resolution

Verification needs a real Riot account. Resolution order:

1. `VERIFY_RIOT_ID=name#tag` — explicit override
2. `PRODUCTION_DB_PATH=/path/to/riot-tracker.sqlite` — read accounts via `pnpm admin status --json`
3. `RAILWAY_TOKEN` — `railway ssh --service riot-tracker-bot -- pnpm admin status --json`

Pick the first account with tracked games when reading production status.

## Drive

Read `.cursor/skills/verify-riot-tracker-bot/features/README.md` before running individual recipes.

The bundled verifier exercises: typecheck → bot boot → signup → refresh (twice, idempotent) → status → report-mock → signout.

Manual equivalents:

```bash
export DB_PATH=/tmp/riot-verify-manual.sqlite
pnpm start   # separate terminal
pnpm admin signup <riot-id> --discord-id verify-agent-user --json
pnpm admin refresh verify-agent-user --json
pnpm admin report-mock --game lol --json
pnpm admin status --json
```

## Evidence

Capture under `/opt/cursor/artifacts/verify-<run-id>/`:

- `results.json` — every step with stdout/stderr
- `bot.log` — boot excerpt showing gateway ready

Proof standards: exercise real Riot/Henrik APIs, real sqlite writes, real Discord REST for `report-mock`. Do not log into Discord web.

## Cleanup

`pnpm verify` deletes only its isolated sqlite file. It does not kill the bot process.

## Helpers

`pnpm verify` runs `tsx src/verify/index.ts`. Riot ID resolution lives in `src/verify/production-riot-id.ts`.
