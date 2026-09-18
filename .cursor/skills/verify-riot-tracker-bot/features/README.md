# riot-tracker-bot verification map

Headless verification for cloud agents. Read this index, then the feature file for the behavior under test.

## Baseline preconditions

- Node 24 (`nvm use 24`; prepend `$NVM_BIN` to `PATH` on cloud VMs).
- Ambient secrets: `DISCORD_BOT_TOKEN`, `RIOT_API_KEY`, `HENRIK_API_KEY`.
- Discord destination for verify / mock reports: `VERIFY_NOTIFICATION_CHANNEL_ID`, `TESTING_NOTIFICATION_CHANNEL_ID`, or `DISCORD_TEST_CHANNEL_URL` must resolve to riot-tracker-testing guild `1523432684691525802`, channel `1523432733785722940`. If not, skip Discord send.
- A real non-production test Riot account in `VERIFY_RIOT_ID`.
- Isolated database: `DB_PATH=/tmp/riot-verify-$RUN_ID.sqlite`. Isolated sqlite is not enough; Discord must be isolated too.
- `pnpm start` with ambient env. Do not use `pnpm dev` (it wants a `.env` file).

## Driving conventions

- Prefer `pnpm verify` for full coverage.
- Use `pnpm admin … --json` for individual steps; never prompt in scripts.
- Do not log into Discord web or Gmail for verification.
- Do not post verify or mock reports to Wise Fellas. Local bot, riot-tracker-testing only.
- Do not give the cloud environment Railway or production database credentials.

## Proof and skip reporting

- JSON stdout from admin commands is the primary proof.
- `results.json` from `pnpm verify` records every step.
- Report unreachable features with the missing testing prerequisite.

## Features

- [Bot boot](./bot-boot.md)
- [Signup](./signup.md)
- [Refresh](./refresh.md)
- [Report mock](./report-mock.md)
