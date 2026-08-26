# riot-tracker-bot

A Discord bot that reports finished matches for opted-in users. Someone signs
up with their Riot ID, and when they finish a game the bot posts a scoreboard
embed to a channel. If several signed-up users played the same match, it posts
once and names all of them.

The goal is to be **game agnostic**: League of Legends, Valorant, and Teamfight
Tactics are the current implementations, but supporting another game should mean
writing one adapter, not touching the rest of the app.

## Commands

| Command                          | What it does                                                 |
| -------------------------------- | ------------------------------------------------------------ |
| `/signup <riot_name> <riot_tag>` | Start reporting your matches                                 |
| `/signout`                       | Stop tracking and delete your data                           |
| `/rank_check <user> <game>`      | Post someone's current rank with their tier emblem           |
| `/pause` / `/resume`             | Stop or restart all reports (the bot goes idle while paused) |
| `/refresh`                       | Recheck your Riot ID for games that were missing at signup   |

## Admin CLI

The same operations, without Discord. It runs inside the production container,
next to the bot:

```sh
railway ssh --service riot-tracker-bot
pnpm admin <command>
```

| Command                               | What it does                                                  |
| ------------------------------------- | ------------------------------------------------------------- |
| `status`                              | Polling state, the database in use, and every tracked account |
| `signup <riot-id> --discord-id <id>`  | Track a Riot account on someone's behalf                      |
| `signout <target>`                    | Stop tracking an account and delete its data                  |
| `pause` / `resume`                    | Stop or restart all reports                                   |
| `rank-check <target> [--game <game>]` | Look up a tracked account's current rank                      |
| `refresh <target>`                    | Recheck a signed-up account for games missing at signup       |
| `report-mock [--game <game>]`         | Post a mock match report embed to the notification channel    |

`<target>` is a Discord user ID, a Discord name, or a Riot ID — whichever you
have. Leave an argument off and the command asks for it. `--json` prints the
result as JSON and never prompts, for scripts. Every command takes `--help`.

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

1. Add the game to `gameIds` and `games` in `src/services/game/index.ts`. Display
   names and Discord/admin choices are derived from that registry.
2. Add an API client and decode schemas under `src/services/game/game-api/`.
3. Implement `GameAdapter` in `src/services/game/game-adapters/`: resolve an
   account, fetch recent matches, map them to `MatchDetails`, optionally enrich
   them, and fetch rank data. Set `requiresMatchHistory` if an empty baseline
   should not persist the game.
4. Register the adapter in `GameAdaptersLive` and provide its API-client layer
   from `src/index.ts`.
5. Add a development report mock, then run `pnpm typecheck` and test
   `/dev_report`.

Keep game-specific API shapes inside the client and adapter. Once they produce
the shared types, polling, deduplication, storage, and Discord reporting should
not need game-specific branches. Match reports are a versus scoreboard or a
placement board, switched on `match.kind`.

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
| `RIOT_API_KEY`            | [developer.riotgames.com](https://developer.riotgames.com). Riot must authorize or register the Teamfight Tactics product for TFT API access. |
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
