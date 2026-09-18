# riot-tracker-bot verification map

Headless verification for cloud agents. Read this index, then the feature file for the behavior under test.

## Baseline preconditions

- Node 24 (`nvm use 24`; prepend `$NVM_BIN` to `PATH` on cloud VMs).
- Ambient secrets: `DISCORD_BOT_TOKEN`, `RIOT_API_KEY`, `HENRIK_API_KEY`.
- Discord destination for verify / mock reports: `VERIFY_NOTIFICATION_CHANNEL_ID`, `TESTING_NOTIFICATION_CHANNEL_ID`, or `DISCORD_TEST_CHANNEL_URL` pointing at **riot-tracker-testing**. Do not use Wise Fellas / production `NOTIFICATION_CHANNEL_ID`. If those testing values are unset, skip Discord send.
- A real Riot ID via Railway (`RAILWAY_API_TOKEN` plus project/service/environment), `PRODUCTION_DB_PATH`, or `VERIFY_RIOT_ID` as a last resort. See the skill Launch section.
- Isolated database: `DB_PATH=/tmp/riot-verify-$RUN_ID.sqlite`. Isolated sqlite is not enough; Discord must be isolated too.
- `pnpm start` with ambient env. Do not use `pnpm dev` (it wants a `.env` file).

## Driving conventions

- Prefer `pnpm verify` for full coverage.
- Use `pnpm admin … --json` for individual steps; never prompt in scripts.
- Do not log into Discord web or Gmail for verification.
- Do not post verify or mock reports to Wise Fellas. Local bot, riot-tracker-testing only.
- Do not set `VERIFY_RIOT_ID` when proving production resolution through Railway.

## Proof and skip reporting

- JSON stdout from admin commands is the primary proof.
- `results.json` from `pnpm verify` records every step.
- Report unreachable features with the missing prerequisite (e.g. Railway token cannot `ssh` even after project ids and an SSH key).
- `railway whoami` Unauthorized is not a skip by itself. Try GraphQL `projects` and `railway ssh` with `--project` / `--service` / `--environment`.

## Features

- [Bot boot](./bot-boot.md)
- [Signup](./signup.md)
- [Refresh](./refresh.md)
- [Report mock](./report-mock.md)
