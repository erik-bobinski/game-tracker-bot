# riot-tracker-bot verification map

Headless verification for cloud agents. Read this index, then the feature file for the behavior under test.

## Baseline preconditions

- Node 24 (`nvm use 24`; prepend `$NVM_BIN` to `PATH` on cloud VMs).
- Ambient secrets: `DISCORD_BOT_TOKEN`, `NOTIFICATION_CHANNEL_ID`, `RIOT_API_KEY`, `HENRIK_API_KEY`.
- A real Riot ID via `VERIFY_RIOT_ID`, `PRODUCTION_DB_PATH`, or `RAILWAY_API_KEY` (see the skill Launch section).
- Isolated database: `DB_PATH=/tmp/riot-verify-$RUN_ID.sqlite`.

## Driving conventions

- Prefer `pnpm verify` for full coverage.
- Use `pnpm admin … --json` for individual steps; never prompt in scripts.
- Do not log into Discord web or Gmail for verification.

## Proof and skip reporting

- JSON stdout from admin commands is the primary proof.
- `results.json` from `pnpm verify` records every step.
- Report unreachable features with the missing prerequisite (e.g. no `RAILWAY_API_KEY`).

## Features

- [Bot boot](./bot-boot.md)
- [Signup](./signup.md)
- [Refresh](./refresh.md)
- [Report mock embed](./report-mock.md)
