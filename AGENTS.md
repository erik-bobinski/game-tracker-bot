This a repo for a discord bot that reports newly completed matches of video games for opted in discord users

## General Points

- Respond concisely unless told otherwise
- Do not write code unless explicitly asked - default to review and suggesting code snippets
- Simplicity and maintainability over all else
- If a simpler approach exists, say so and push back when warranted
- If something is unclear stop and ask, don't make many assumptions
- Goal of project is to create a match reporting discord bot that is game agnostic (extendable other games with minimal code changes)

## Taste

- Re-use the Effect pieces as much as possible
- Inferred types over annotations. `any` is the enemy
- Don't spam helper functions to be used once
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it

## Pull Requests

- Never make a PR unless the developer explicitly asks you to do so
- Never open PRs as drafts
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work

## Project Structure

- Written in TypeScript with the Effect v4 library, use it wherever you can and idiomatically with the effect skill
- Use pnpm and related tools
- The core pieces of the project are: entry point src/index.ts file and the various effect services in src/services such as SQLite, video game APIs, the Match Engine, the Polling, etc.

## Cursor Cloud specific instructions

- **Node 24 is required.** `@effect/sql-sqlite-node` imports `backup` from `node:sqlite`, which only exists in Node 24+; on Node 22 the bot crashes at boot with `SyntaxError: ... does not provide an export named 'backup'`. The pod's default `/exec-daemon/node` is v22, so the VM snapshot sets nvm's default to Node 24 and prepends it ahead of `/exec-daemon` via `~/.bashrc` (login shells get it automatically). If a fresh pod ever reports `node --version` v22, run `nvm alias default 24 && corepack enable`, and ensure `~/.bashrc` prepends the nvm default bin before `/exec-daemon`.
- **`pnpm` comes from corepack** (pinned `pnpm@11.16.0` via `packageManager`). The update script only runs `pnpm install --frozen-lockfile`; there is no build step (everything runs through `tsx`).
- **Secrets are ambient env vars, not a `.env` file.** Cursor Cloud receives a testing bot token, the Riot/Henrik API keys, a designated `VERIFY_RIOT_ID`, the testing Discord destination, `DEV_MODE=true`, and optionally `RAILWAY_API_TOKEN_DEV`. Never give the `syan-alt/riot-tracker-bot` environment a production Discord token or destination, a production Railway token, or a production database. Run the bot with `pnpm start` (reads ambient env). `pnpm dev` fails here because it passes `--env-file=.env` and no `.env` exists.
- **Railway (read-only, `dev` only).** `RAILWAY_API_TOKEN_DEV` is allowed. It is a Railway project token scoped to the `dev` environment and used read-only (list environments, load that environment's variables). When running Railway CLI, export it as `RAILWAY_TOKEN` for those commands only and keep `RAILWAY_API_TOKEN` unset. Do not export it into the bot process. Production Railway tokens, environments, databases, deploys, and mutations remain forbidden.
- **No test runner and no linter exist.** The only static checks are `pnpm typecheck` (tsc) and `pnpm format` (prettier) — see `package.json` scripts.
- **Exercise reporting without a live match:** with `DEV_MODE=true` the bot registers `/dev_report <game>` (posts a Components V2 scoreboard from mock data), `/dev_signup`, and `/dev_clear`. These are Discord slash commands invoked from a Discord client in the test server.
- **Cloud agent verification (no Discord/Gmail login):** run `pnpm verify`. It starts the live bot, drives `pnpm admin` against an isolated sqlite file, and writes evidence to `/opt/cursor/artifacts/verify-<run-id>/`. `VERIFY_RIOT_ID` supplies the designated test account. If Cursor secrets are missing, `RAILWAY_API_TOKEN_DEV` may load Railway `dev` variables read-only as above; never read production Railway or a production database. See `.cursor/skills/verify-riot-tracker-bot/SKILL.md`.
- **Verify and mock reports post only to the configured testing Discord destination.** Cloud agents run the bot locally (`pnpm start` / `pnpm verify`). Configure `TESTING_DISCORD_GUILD_ID` plus `TESTING_NOTIFICATION_CHANNEL_ID`, or `DISCORD_TEST_CHANNEL_URL`. `VERIFY_NOTIFICATION_CHANNEL_ID` may select only that configured channel. `pnpm verify` ignores ambient `NOTIFICATION_CHANNEL_ID`; missing or conflicting testing values skip Discord send. `report-mock` and `DEV_MODE` also fail closed outside the configured destination. No production server or channel is hard-coded in the repository.
- **Discord web login for UI verification (optional).** Use this only with a dedicated throwaway test account, never a personal account. Discord's terms forbid automating user accounts; cloud datacenter IPs usually hit hCaptcha, email codes, or 2FA, so login often fails. Do not write captcha-bypass, cookie-stealing, or TOTP-extraction code. Never print `AGENT_EMAIL_PASSWORD` (or `AGENT_EMAIL`) to logs, artifacts, commits, or chat.
  - Required secrets (Cursor Cloud environment secrets, not `.cursor/environment.json`): `AGENT_EMAIL` (Discord login email/phone, not display name), `AGENT_EMAIL_PASSWORD`, `DISCORD_TEST_CHANNEL_URL` (`https://discord.com/channels/<guildId>/<channelId>` for the test server channel the bot can see).
  - If any of those three are unset, skip the browser and verify with `pnpm typecheck`, bot boot logs, and Discord REST against the configured testing destination only. Never post verification output to a production server. Running agents do not pick up newly added secrets; only a newly started agent sees them.
  - If they are set: start the bot with `pnpm start`, open `https://discord.com/login` in computer-use, fill email from `AGENT_EMAIL` then password from `AGENT_EMAIL_PASSWORD` (do not echo them), click Log In. If a captcha, email code, or 2FA prompt appears, stop and report that browser verification is blocked. On success, open `DISCORD_TEST_CHANNEL_URL` and invoke the slash command under test the way a user would (`/` in the message box, pick the command, submit).
