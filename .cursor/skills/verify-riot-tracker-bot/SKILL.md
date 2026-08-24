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

`pnpm verify` typechecks, starts the bot (`pnpm start`, not `pnpm dev`), waits until the process is up, drives admin commands, writes JSON evidence to `/opt/cursor/artifacts/verify-<run-id>/`, and leaves the bot running.

Isolation uses `DB_PATH=/tmp/riot-verify-<run-id>.sqlite` so production data is never touched.

Do not set `VERIFY_RIOT_ID` when a Railway token is available. The harness resolves a production Riot ID itself.

Cloud-agent traps (Railway project tokens, ssh keys, READY race, Henrik 404) are in [references/cloud-agent-lessons.md](references/cloud-agent-lessons.md).

## Doctor

Before driving features manually:

```bash
pnpm typecheck
pnpm admin status --json
```

For the live bot, confirm the process log contains `slash commands registered` and either `discord gateway ready` or `application started`. dfx can emit READY before `makeDiscord` subscribes; slash-command registration plus application start still means the bot is up. The Discord service now subscribes to READY before rank-emoji REST so the first READY is less often missed.

## Riot ID resolution

Verification needs a real Riot account. Resolution order:

1. `VERIFY_RIOT_ID=name#tag` — explicit override. Skip this when proving Railway lookup.
2. `PRODUCTION_DB_PATH=/path/to/riot-tracker.sqlite` — read accounts via `pnpm admin status --json`
3. Railway token (`RAILWAY_API_TOKEN`, `RAILWAY_API_KEY`, or `RAILWAY_TOKEN`) — `railway ssh --service riot-tracker-bot -- pnpm admin status --json`

Pick the first account with tracked games when reading production status.

### Railway tokens and ssh

Cursor Cloud often injects a **project/workspace** token as `RAILWAY_API_TOKEN` (a UUID). That token:

- Fails `railway whoami`, `railway list`, and `railway link` with `Unauthorized` (`me` is not allowed).
- Still answers GraphQL `projects` and can `railway ssh` once a project/service/environment are named.

Do not treat a whoami failure as "Railway is unusable." Discover IDs, then ssh:

```bash
pnpm exec railway api 'query { projects { edges { node { id name } } } }'
pnpm exec railway api 'query { project(id: "<project-id>") { name services { edges { node { id name } } } environments { edges { node { id name } } } } }'
```

Export what ssh needs (names or ids work for `--service` / `--environment`):

```bash
export RAILWAY_PROJECT_ID=<project-id>
export RAILWAY_SERVICE=riot-tracker-bot
export RAILWAY_ENVIRONMENT=production   # or the environment id
```

`pnpm verify` already forwards those into `railway ssh --project --service --environment`.

SSH also needs a key registered with Railway and `ssh.railway.com` in `known_hosts`:

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
pnpm exec railway ssh keys add -k ~/.ssh/id_ed25519.pub -n cursor-cloud-verify
ssh-keyscan -t ed25519 ssh.railway.com >> ~/.ssh/known_hosts
pnpm exec railway ssh --service riot-tracker-bot -- pnpm admin status --json
```

Banners from ssh go to stderr. JSON for `admin status` is on stdout; the harness slices from the first `{`.

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
- `bot.log` — boot excerpt showing the process is up

Proof standards: exercise real Riot/Henrik APIs, real sqlite writes, real Discord REST for `report-mock`. Do not log into Discord web.

A Henrik 404 on Valorant during signup/refresh is not a harness failure. That game stays in `missing`; League can still track. Second refresh must have `added: []`.

## Cleanup

`pnpm verify` deletes only its isolated sqlite file. It does not kill the bot process.

## Helpers

`pnpm verify` runs `tsx src/verify/index.ts`. Riot ID resolution lives in `src/verify/production-riot-id.ts`.
