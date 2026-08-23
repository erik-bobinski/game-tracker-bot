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
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work

## Project Structure

- Written in TypeScript with the Effect v4 library, use it wherever you can and idiomatically with the effect skill
- Use pnpm and related tools
- The core pieces of the project are: entry point src/index.ts file and the various effect services in src/services such as SQLite, video game APIs, the Match Engine, the Polling, etc.

## Cursor Cloud specific instructions

- **Node 24 is required.** `@effect/sql-sqlite-node` imports `backup` from `node:sqlite`, which only exists in Node 24+; on Node 22 the bot crashes at boot with `SyntaxError: ... does not provide an export named 'backup'`. The pod's default `/exec-daemon/node` is v22, so the VM snapshot sets nvm's default to Node 24 and prepends it ahead of `/exec-daemon` via `~/.bashrc` (login shells get it automatically). If a fresh pod ever reports `node --version` v22, run `nvm alias default 24 && corepack enable`, and ensure `~/.bashrc` prepends the nvm default bin before `/exec-daemon`.
- **`pnpm` comes from corepack** (pinned `pnpm@11.16.0` via `packageManager`). The update script only runs `pnpm install --frozen-lockfile`; there is no build step (everything runs through `tsx`).
- **Secrets are ambient env vars, not a `.env` file.** `DISCORD_BOT_TOKEN`, `NOTIFICATION_CHANNEL_ID`, `RIOT_API_KEY`, `HENRIK_API_KEY`, and `DEV_MODE=true` are injected into the environment. Run the bot with `pnpm start` (reads ambient env). `pnpm dev` fails here because it passes `--env-file=.env` and no `.env` exists.
- **No test runner and no linter exist.** The only static checks are `pnpm typecheck` (tsc) and `pnpm format` (prettier) — see `package.json` scripts.
- **Exercise reporting without a live match:** with `DEV_MODE=true` the bot registers `/dev_report <game>` (posts a scoreboard embed from mock data), `/dev_signup`, and `/dev_clear`. These are Discord slash commands invoked from a Discord client in the test server.
- **Known caveat — `pnpm admin` game lookups fail with "Transport error".** `admin signup` / `rank-check` build the Riot/Henrik HTTP client layer in an inner scope that is released before the request runs, so those calls fail instantly. This is a code-level scoping issue, not an egress/env problem (the API hosts are reachable and the keys are valid). The bot itself (`src/index.ts`) is unaffected because it keeps the HTTP client at the top-level scope for the process lifetime.
