# Bot boot

Starts the live Discord bot process and confirms it is serving commands. Uses only the bot token — no user login.

## Sub-features

- `boot` — process starts without crash
- `commands` — slash commands register (including dev commands when `DEV_MODE=true`)
- `gateway` — Discord gateway reaches ready, or the process is otherwise up

## How to get to it (user POV)

Run `bun start` with `DEV_MODE=true` and an isolated `DB_PATH`.

## Driving it with bun run verify

Preconditions: Bun, ambient `DISCORD_BOT_TOKEN`.

- Action: run `bun run verify` or start `bun start` manually.
- Observable: log contains `slash commands registered` with `devMode: true`, plus `application started` and/or `discord gateway ready`.

## Gotchas

- Cloud agents use `bun start` with ambient env; `bun dev` restarts on every file change.
- dfx can emit READY before `makeDiscord` subscribes. Waiting only on `discord gateway ready` flakes. Treat `slash commands registered` plus `application started` as a successful boot; READY often shows up a moment later.
- Rank-emoji REST used to run before the READY subscription and ate the first READY. Subscribe first, then do REST.
