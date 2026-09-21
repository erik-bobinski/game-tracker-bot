# Cloud agent lessons

Lessons from running verification on Cursor Cloud.

## Railway tokens on Cursor Cloud

Two different token slots:

- **Project token** — `RAILWAY_TOKEN`. `railway status` and `railway run --service riot-tracker-bot --environment <env>` work with no `railway link`. Cursor Cloud injects these as `RAILWAY_API_TOKEN_DEV` and `RAILWAY_API_TOKEN_PROD`. Copy the one you mean onto `RAILWAY_TOKEN`. Do not leave a project token only in `RAILWAY_API_TOKEN`: `railway status` then says "No linked project", and `whoami` / GraphQL `projects` return Unauthorized.
- **Account or workspace token** — `RAILWAY_API_TOKEN`. `whoami` can still be Unauthorized. GraphQL `projects` and `railway ssh` can work once project, service, and environment are named.

Prefer **dev** for Discord proof (`RAILWAY_API_TOKEN_DEV`, `--environment dev`). That bot is not the production gateway, and the dev service sets `DEV_MODE=true`. Production leaves `DEV_MODE` unset and is already connected; do not `pnpm start` that token.

`src/verify/production-riot-id.ts` treats `RAILWAY_TOKEN` as a signal to `railway ssh`, then copies it onto `RAILWAY_API_TOKEN`. It does not read `RAILWAY_API_TOKEN_DEV` or `RAILWAY_API_TOKEN_PROD`. Export `RAILWAY_TOKEN` yourself before `pnpm verify`. Do not set `VERIFY_RIOT_ID` to skip that gap. Mock-report proof does not need the Riot id lookup.

With a project token, skip `railway link` and the `projects` query. Names that work:

- project `riot-tracker-bot`
- service `riot-tracker-bot`
- environments `dev` and `production`

`railway run` injects service variables into the child and overwrites `DB_PATH`. Point admin and the bot at an isolated sqlite file in that child. Do not print the injected variables.

## SSH

Account tokens only. Project tokens should use `railway run`, not ssh, for Discord proof.

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
- `discord-rest-proof.mjs` stops the bot it started and deletes its sqlite file. Artifact files stay.
