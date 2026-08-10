# riot-tracker-bot

A Discord bot that reports finished matches for opted-in users. Someone signs
up with their Riot ID, and when they finish a game the bot posts a scoreboard
embed to a channel. If several signed-up users played the same match, it posts
once and names all of them.

The goal is to be **game agnostic**: League of Legends and Valorant are the two
implementations, but supporting another game should mean writing one adapter,
not touching the rest of the app.

## Commands

| Command                          | What it does                                                 |
| -------------------------------- | ------------------------------------------------------------ |
| `/signup <riot_name> <riot_tag>` | Start reporting your matches                                 |
| `/signout`                       | Stop tracking and delete your data                           |
| `/rank_check <user> <game>`      | Post someone's current rank with their tier emblem           |
| `/pause` / `/resume`             | Stop or restart all reports (the bot goes idle while paused) |

## Admin CLI

The same operations, without Discord. Useful when the bot is misbehaving, when
someone needs signing up on their behalf, or when you just want to see what
production thinks is true.

```sh
pnpm admin status
pnpm admin signup syan#NA1 --discord-id 195042765893632000
pnpm admin signout syan
pnpm admin pause
pnpm admin resume
pnpm admin rank-check syan --game lol
```

In production it runs inside the container, next to the bot:

```sh
railway ssh --service riot-tracker-bot
pnpm admin status
```

There is no socket and no server. The CLI opens the same SQLite file the bot
uses, so writes are visible to the running process immediately; the bot re-reads
the pause flag every few seconds, so `pause` and `resume` take effect without a
restart. It follows that the CLI needs the same `DB_PATH` as the bot, and that
`signup` and `rank-check` need `RIOT_API_KEY` and `HENRIK_API_KEY` — the other
commands don't.

It is built to be usable without looking anything up first:

- **Targets** are a Discord user ID, a Discord name, or a Riot ID — whichever
  you have. `pnpm admin signout syan`, `signout syan#NA1`, and
  `signout 195042765893632000` all work.
- **Omit an argument and it asks.** `pnpm admin signout` with no target opens a
  filterable list of tracked accounts; `rank-check` picks the game for you when
  the account only plays one. `--wizard` walks any command start to finish.
- **`--help` on every command**, and `--completions <bash|zsh|fish>` if you want
  tab completion.
- **`--json` for scripts.** It prints the result as JSON and never prompts, so a
  missing argument fails instead of hanging. Exit codes: `0` success, `2` bad
  usage, `3` the command ran and could not do what you asked.

## Architecture

TypeScript on [Effect](https://effect.website) v4, with [dfx](https://github.com/tim-smart/dfx)
for Discord and SQLite for storage. Every piece is an Effect service, wired
together as layers in `src/index.ts`.

```
src/
  index.ts                     layer wiring and entry point
  admin/                       the admin CLI, a second entry point
  services/
    polling/                   ticks every minute, respects the pause flag
    match-engine/              the core loop, see below
    accounts/                  signup, shared by /signup and the admin CLI
    game/
      index.ts                 game-agnostic domain types
      game-adapters/           one adapter per game, behind a shared interface
      game-api/                raw API clients and decode schemas
    discord/                   gateway, slash commands, embeds
    database/                  SQLite, migrations, account storage
```

**The match engine** is where it comes together. Each tick it loads every
account, asks each game adapter for that account's recent matches, drops the
ones already reported, and collapses matches shared by multiple users into a
single entry. Then it enriches each match (rank lookups), posts it, and records
it as reported.

### Adding a game

1. Add the game ID to `GameId` in `src/services/game/index.ts`, along with its
   display name in `gameNames` just below it.
2. Add an API client and decode schemas under `src/services/game/game-api/`.
3. Implement `GameAdapter` in `src/services/game/game-adapters/`: resolve an
   account, fetch recent matches, map them to `MatchDetails`, optionally enrich
   them, and fetch rank data.
4. Register the adapter in `GameAdaptersLive` and provide its API-client layer
   from `src/index.ts`.
5. Add the game to the `/rank_check` choices, the admin CLI's `--game` choices,
   and the development report mocks, then run `pnpm typecheck` and test
   `/dev_report`.

Keep game-specific API shapes inside the client and adapter. Once they produce
the shared types, polling, deduplication, storage, and Discord reporting should
not need game-specific branches.

**Failures degrade rather than crash.** One undecodable match is skipped, not
fatal. A failed rank lookup drops the icon but still posts the report. A failed
poll is logged and retried on the next tick.

## Setup

Requires Node and pnpm.

```sh
pnpm install
cp .env.example .env
```

Fill in `.env`:

| Variable                  | How to get it                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`       | [Discord Developer Portal](https://discord.com/developers/applications) → your app → Bot |
| `NOTIFICATION_CHANNEL_ID` | Right-click the target channel → Copy Channel ID (needs Developer Mode on)               |
| `RIOT_API_KEY`            | [developer.riotgames.com](https://developer.riotgames.com)                               |
| `HENRIK_API_KEY`          | [HenrikDev Discord](https://discord.com/invite/X3GaVkX2YN)                               |

`RIOT_REGION`, `VAL_REGION` and `VAL_PLATFORM` are optional. Each account's
region is resolved and stored at signup; these are only fallbacks.

Invite the bot with the `bot` and `applications.commands` scopes, and give it
permission to send messages in your notification channel. Commands register
themselves on startup.

```sh
pnpm start
```

## Local development

Run a second bot application in a separate test server, with its own token and
API keys, and set `DEV_MODE=true`. That registers three extra commands:

| Command                              | What it does                                                               |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `/dev_clear`                         | Forget reported matches, so the next poll re-reports your real recent ones |
| `/dev_report <game>`                 | Post a report built from mock API responses, no game required              |
| `/dev_signup <riot_name> <riot_tag>` | Track a Riot account under a fake Discord identity                         |

`/dev_signup` exists because tracked users are just database rows — Discord
membership is never checked. Registering a friend's Riot ID under a fabricated
identity lets you produce real multi-user reports while you're the only person
in the test server.

```sh
pnpm dev          # loads .env
pnpm typecheck
```
