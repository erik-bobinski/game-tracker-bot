# Cloud agent lessons

Lessons from running `pnpm verify` on Cursor Cloud against Railway production.

## NEVER post verify or mock reports to Wise Fellas

This already happened. A verify / `report-mock` run used ambient Cursor/Railway `NOTIFICATION_CHANNEL_ID` (`1525711779865432135`, Wise Fellas `#riot-tracker`) and posted a Components V2 mock into production. That is unacceptable.

Rules:

- Run the bot locally in the cloud VM (`pnpm start` / `pnpm verify`).
- Connect that local bot only to **riot-tracker-testing**.
- Never use Wise Fellas / production `NOTIFICATION_CHANNEL_ID` for verify or mock reports.
- Isolated sqlite is not enough. Discord destination must be isolated too.
- Never `railway ssh -- printenv` (or otherwise copy production Discord env) into the VM. ssh is for `pnpm admin status --json` to read a Riot ID.
- `pnpm verify` ignores ambient `NOTIFICATION_CHANNEL_ID`. It needs `VERIFY_NOTIFICATION_CHANNEL_ID`, `TESTING_NOTIFICATION_CHANNEL_ID`, or `DISCORD_TEST_CHANNEL_URL` pointing at riot-tracker-testing.
- If those testing values are missing, skip Discord send. Do not fall back to production. `report-mock` and `DEV_MODE` refuse known Wise Fellas channel and guild IDs.

## Railway tokens on Cursor Cloud

`RAILWAY_API_TOKEN` is often a project or workspace UUID, not a personal account token.

- `railway whoami`, `railway list`, and `railway link` return `Unauthorized` (`me` is not allowed). That is not a dead end.
- GraphQL `projects` and `railway ssh` still work once project, service, and environment are named.

Discover IDs:

```bash
pnpm exec railway api 'query { projects { edges { node { id name } } } }'
```

Production in this repo has been:

- project name `riot-tracker-bot`
- service name `riot-tracker-bot`
- environment name `production`

Export before ssh (names or ids):

```bash
export RAILWAY_PROJECT_ID=<project-id>
export RAILWAY_SERVICE=riot-tracker-bot
export RAILWAY_ENVIRONMENT=production
```

The CLI reads `RAILWAY_API_TOKEN`. Cursor Cloud may inject `RAILWAY_API_KEY` or `RAILWAY_TOKEN`; `src/verify/production-riot-id.ts` copies those onto `RAILWAY_API_TOKEN`.

## SSH

`railway ssh` needs a key Railway knows and a host key in `known_hosts`:

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
pnpm exec railway ssh keys add -k ~/.ssh/id_ed25519.pub -n cursor-cloud-verify
ssh-keyscan -t ed25519 ssh.railway.com >> ~/.ssh/known_hosts
pnpm exec railway ssh --service riot-tracker-bot -- pnpm admin status --json
```

Banners go to stderr. JSON is on stdout; slice from the first `{`.

Do not set `VERIFY_RIOT_ID` when ssh works. The harness picks the first production account that already has tracked games.

## Bot boot race

dfx can emit READY before `makeDiscord` subscribes. `src/services/discord/index.ts` subscribes to READY before rank-emoji and command REST.

`pnpm verify` treats the process as up when it sees `discord gateway ready`, or both `slash commands registered` and `application started`. READY often arrives a moment later. Do not fail the run only because READY was late.

## Valorant Henrik 404

A 404 whose body asks the player to finish a game is a missing game, not a harness failure. League can still be in `games` / `tracked`. Second refresh must have `added: []`.

## Cloud runtime

- Node 24. Node 22 crashes on the sqlite native import.
- `pnpm start` with ambient env. `pnpm dev` wants a `.env` file that does not exist here.
- Leave the verify bot running. The harness deletes only its isolated sqlite file.
