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
- **Secrets are ambient env vars, not a `.env` file.** `DISCORD_BOT_TOKEN`, `NOTIFICATION_CHANNEL_ID`, `RIOT_API_KEY`, `HENRIK_API_KEY`, and `DEV_MODE=true` are injected into the environment. Optional UI-login secrets (`AGENT_EMAIL`, `AGENT_EMAIL_PASSWORD`, `DISCORD_TEST_CHANNEL_URL`) are listed below. Run the bot with `pnpm start` (reads ambient env). `pnpm dev` fails here because it passes `--env-file=.env` and no `.env` exists.
- **No test runner and no linter exist.** The only static checks are `pnpm typecheck` (tsc) and `pnpm format` (prettier) — see `package.json` scripts.
- **Exercise reporting without a live match:** with `DEV_MODE=true` the bot registers `/dev_report <game>` (posts a scoreboard embed from mock data), `/dev_signup`, and `/dev_clear`. These are Discord slash commands invoked from a Discord client in the test server.
- **Cloud agent verification (no Discord/Gmail login):** run `pnpm verify`. It starts the live bot, drives `pnpm admin` against an isolated sqlite file, and writes evidence to `/opt/cursor/artifacts/verify-<run-id>/`. Do not set `VERIFY_RIOT_ID` when a Railway token is present. `RAILWAY_API_TOKEN` is often a project token: `railway whoami` / `link` / `list` return Unauthorized, but GraphQL `projects` and `railway ssh` still work after you export `RAILWAY_PROJECT_ID`, `RAILWAY_SERVICE` (`riot-tracker-bot`), and `RAILWAY_ENVIRONMENT` (`production`), register an SSH key (`railway ssh keys add`), and add `ssh.railway.com` to `known_hosts`. See `.cursor/skills/verify-riot-tracker-bot/SKILL.md` and `.cursor/skills/verify-riot-tracker-bot/references/cloud-agent-lessons.md`.
- **Discord web login for UI verification (optional).** Use this only with a dedicated throwaway test account, never a personal account. Discord's terms forbid automating user accounts; cloud datacenter IPs usually hit hCaptcha, email codes, or 2FA, so login often fails. Do not write captcha-bypass, cookie-stealing, or TOTP-extraction code. Never print `AGENT_EMAIL_PASSWORD` (or `AGENT_EMAIL`) to logs, artifacts, commits, or chat.
  - Required secrets (Cursor Cloud environment secrets, not `.cursor/environment.json`): `AGENT_EMAIL` (Discord login email/phone, not display name), `AGENT_EMAIL_PASSWORD`, `DISCORD_TEST_CHANNEL_URL` (`https://discord.com/channels/<guildId>/<channelId>` for the test server channel the bot can see).
  - If any of those three are unset, skip the browser and verify with `pnpm typecheck`, bot boot logs, and Discord REST (list slash commands / post via the bot token). Running agents do not pick up newly added secrets; only a newly started agent sees them.
  - If they are set: start the bot with `pnpm start`, open `https://discord.com/login` in computer-use, fill email from `AGENT_EMAIL` then password from `AGENT_EMAIL_PASSWORD` (do not echo them), click Log In. If a captcha, email code, or 2FA prompt appears, stop and report that browser verification is blocked. On success, open `DISCORD_TEST_CHANNEL_URL` and invoke the slash command under test the way a user would (`/` in the message box, pick the command, submit).
