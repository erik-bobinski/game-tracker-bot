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
- Secrets aren't in the environment or a `.env` file: run anything that needs them through `infisical run` (exact command in the verify-game-tracker-bot skill)
- With `DEV_MODE=true` the bot refuses to start unless its token's bot is in `DEV_GUILD_ID` alone

## Checks

- `bun run check` runs everything CI runs, including the oxlint anti-slop rules in `tools/oxlint/anti-slop`
- Fix lint findings properly: no disabling rules, no casts or renames just to quiet them. A finding that seems wrong for this codebase gets raised with a human
- Tests are `*.test.ts` next to the code, run with `bun test`, with effects run through `Effect.runPromise` and dependencies swapped by providing test layers (not `@effect/vitest`, and no module mocking). Reserve them for domain logic such as match detection, rank deltas and sign-in links. Don't spam them
- When changes touch accounts, adapters, enrichment, cards, delivery or polling, run the [verify-game-tracker-bot skill](.agents/skills/verify-game-tracker-bot/SKILL.md) workflow.
