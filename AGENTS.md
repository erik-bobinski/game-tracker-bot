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
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it

## Pull Requests

- Never open PRs as drafts
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work

## Project Structure

- Written in TypeScript with the Effect v4 library, use it wherever you can and idiomatically with the effect skill (vendored in `.agents/skills/effect`)
- Bun is the runtime, package manager and test runner. Where Effect has an abstraction (HTTP, sockets, SQLite, `FileSystem`, CLI), use it through its `@effect/platform-bun` / `@effect/sql-sqlite-bun` layers; otherwise use Bun APIs (`Bun.file`, `Bun.spawnSync`, `Bun.env`, Web Crypto) over `node:*` modules
- Effect is on the stable 4.x line: modules live at `effect/http`, `effect/cli`, `effect/sql`, etc. (not `effect/unstable/*`), and constructors are PascalCase (`Config.String`, `Flag.Boolean`, `Prompt.Select`)
- Production runs on Railway, built from the `Dockerfile` (Railpack doesn't detect Bun). Keep its `oven/bun` tag in step with `packageManager`
- The core pieces of the project are: entry point src/index.ts file and the various effect services in src/services such as SQLite, video game APIs, the Match Engine, the Polling, etc.

## Checks

- `bun run check` runs everything CI runs: `format:check` (prettier), `lint` (oxlint with the anti-slop rules in `tools/oxlint/anti-slop`), `typecheck` (tsc), `test` (`bun test`) and `audit`
- Fix lint findings properly: no disabling rules, no casts or renames just to quiet them. A finding that seems wrong for this codebase gets raised with a human
- Tests are `*.test.ts` next to the code, run with `bun test`, with effects run through `Effect.runPromise` and dependencies swapped by providing test layers (not `@effect/vitest`, and no module mocking). Reserve them for domain logic such as match detection, rank deltas and sign-in links. Don't spam them

## Cursor Cloud specific instructions

- **Bun is installed by the environment's install script** (`~/.bun/bin`, prepended to `PATH` via `~/.bashrc`; the version is pinned by `packageManager` in `package.json`). If a fresh pod reports `bun: command not found`, run `curl -fsSL https://bun.sh/install | bash -s "bun-v<version>"` and open a login shell. The install script then runs `bun install --frozen-lockfile`; there is no build step, Bun runs the TypeScript directly.
- **Secrets are ambient env vars, not a `.env` file.** `DISCORD_BOT_TOKEN`, `NOTIFICATION_CHANNEL_ID`, `RIOT_API_KEY`, `RIOT_TFT_API_KEY`, `HENRIK_API_KEY`, and `DEV_MODE=true` are injected into the environment. Optional UI-login secrets (`AGENT_EMAIL`, `AGENT_EMAIL_PASSWORD`, `DISCORD_TEST_CHANNEL_URL`) are listed below. Run the bot with `bun start`. Bun also loads a `.env` file when one exists, but none does here.
- **Static checks and tests:** `bun run check` (see Checks above).
- **Exercise reporting without a live match:** with `DEV_MODE=true` the bot registers `/dev_report <game>` (posts a match report card from mock data), `/dev_signup`, and `/dev_clear`. These are Discord slash commands invoked from a Discord client in the test server.
- **Verify report changes against real matches:** `bun run admin report-match 'name#tag' --game <game> [--index n] [--out card.png]` runs one live match through the same adapter, enrichment and posting path the match engine uses, with no bot process or polling. Render with `--out` first, then post to the dev channel and check it. Run it for any change to adapters, enrichment, the card or the embed. The recipe, including how to find a player who played a given mode, is in `.cursor/skills/verify-game-tracker-bot/features/report-match.md`.
- **Cloud agent verification (no Discord/Gmail login):** run `bun run verify`. It starts the live bot, drives `bun run admin` against an isolated sqlite file, and writes evidence to `/opt/cursor/artifacts/verify-<run-id>/`. Do not set `VERIFY_RIOT_ID` when a Railway token is present. `RAILWAY_API_TOKEN` is often a project token: `railway whoami` / `link` / `list` return Unauthorized, but GraphQL `projects` and `railway ssh` still work after you export `RAILWAY_PROJECT_ID`, `RAILWAY_SERVICE` (`game-tracker-bot`), and `RAILWAY_ENVIRONMENT` (`production`), register an SSH key (`railway ssh keys add`), and add `ssh.railway.com` to `known_hosts`. See `.cursor/skills/verify-game-tracker-bot/SKILL.md` and `.cursor/skills/verify-game-tracker-bot/references/cloud-agent-lessons.md`.
- **Discord web login for UI verification (optional).** Use this only with a dedicated throwaway test account, never a personal account. Discord's terms forbid automating user accounts; cloud datacenter IPs usually hit hCaptcha, email codes, or 2FA, so login often fails. Do not write captcha-bypass, cookie-stealing, or TOTP-extraction code. Never print `AGENT_EMAIL_PASSWORD` (or `AGENT_EMAIL`) to logs, artifacts, commits, or chat.
  - Required secrets (Cursor Cloud environment secrets, not `.cursor/environment.json`): `AGENT_EMAIL` (Discord login email/phone, not display name), `AGENT_EMAIL_PASSWORD`, `DISCORD_TEST_CHANNEL_URL` (`https://discord.com/channels/<guildId>/<channelId>` for the test server channel the bot can see).
  - If any of those three are unset, skip the browser and verify with `bun run check`, bot boot logs, and Discord REST (list slash commands / post via the bot token). Running agents do not pick up newly added secrets; only a newly started agent sees them.
  - If they are set: start the bot with `bun start`, open `https://discord.com/login` in computer-use, fill email from `AGENT_EMAIL` then password from `AGENT_EMAIL_PASSWORD` (do not echo them), click Log In. If a captcha, email code, or 2FA prompt appears, stop and report that browser verification is blocked. On success, open `DISCORD_TEST_CHANNEL_URL` and invoke the slash command under test the way a user would (`/` in the message box, pick the command, submit).
