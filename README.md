# riot-tracker-bot

A Discord bot that reports finished matches for opted-in users. Someone signs
up with their Riot ID in a server, and when they finish a game the bot posts a
scoreboard card to the channel that server picked, or a scoreboard embed if the
card fails to render. If several signed-up users played the same match, each
server gets one post naming the ones who signed up there.

One bot process serves every server it's in. A Riot account is polled once no
matter how many servers report it, so API usage grows with players, not servers.

The goal is to be **game agnostic**: League of Legends, Valorant, and Teamfight
Tactics are the current implementations, but supporting another game should mean
writing one adapter, not touching the rest of the app.

## Commands

| Command                          | What it does                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `/setup <channel>`               | Pick the channel this server's reports go to (Manage Server)                       |
| `/signup <riot_name> <riot_tag>` | Start reporting your matches in this server, or switch your Riot ID                |
| `/signout`                       | Stop reporting your matches here; your data is deleted when no server reports them |
| `/rank_check <user> <game>`      | Post the current rank of someone signed up here, with their tier emblem            |
| `/pause` / `/resume`             | Stop or restart this server's reports (Manage Server)                              |
| `/refresh`                       | Recheck your Riot ID for games that were missing at signup                         |
| `/link`                          | Sign in with Riot to add games Riot only shares with consent (VALORANT)            |

Commands only work in servers. Server admins can hand `/setup`, `/pause` and
`/resume` to other roles under Server Settings → Integrations. `/link` only
exists once the bot has a Riot Sign On client, see
[VALORANT through Riot's API](#valorant-through-riots-api).

## Admin CLI

The same operations, without Discord. It runs inside the production container,
next to the bot:

```sh
railway ssh --service riot-tracker-bot
pnpm admin <command>
```

| Command                                                 | What it does                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| `status`                                                | Polling state, the database in use, every server and tracked account |
| `signup <riot-id> --discord-id <id> [--guild <id>]`     | Track a Riot account on someone's behalf, reporting in that server   |
| `signout <target>`                                      | Stop tracking an account everywhere and delete its data              |
| `setup <guild-id> --channel <id> [--adopt]`             | Set a server's report channel; `--adopt` adds accounts in no server  |
| `pause` / `resume`                                      | Stop or restart all reports, in every server                         |
| `rank-check <target> [--game <game>]`                   | Look up a tracked account's current rank                             |
| `refresh <target>`                                      | Recheck a signed-up account for games missing at signup              |
| `report-mock [--game <game>] [--channel <id>]`          | Post a mock match card                                               |
| `report-match <riot-id> --game <game> [--channel <id>]` | Report a real recent match through the polling pipeline              |

Posting commands use `--channel`, or `NOTIFICATION_CHANNEL_ID` without it.

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
    polling/                   ticks every minute, respects the global pause flag
    match-engine/              the core loop, see below
    game/
      index.ts                 game-agnostic domain types
      game-adapters/           one adapter per game, behind a shared interface
      game-api/                raw API clients and decode schemas
    discord/                   gateway, slash commands, embeds
    database/                  SQLite, migrations, account storage
    rso/                       Riot Sign On, for games that need a player's opt-in
    web/                       public pages, and where Riot's sign-in returns to
```

**The match engine** is where it comes together. Each tick it loads every
account that some unpaused server with a channel reports, and polls the ones
that are due: someone who just played is polled every minute, then less often
the longer they stay idle, down to every 15 minutes. A poll asks the game
adapter for the ids of the account's recent matches, one request, and drops the
ones already reported. Each new match is fetched once, however many tracked
players were in it, then enriched (rank lookups) and posted once per server,
naming the players who signed up there, and recorded as reported.

**Riot rate limits** are respected per key and routing host. The client reads
the limits off each response's `X-App-Rate-Limit` header and paces requests
under them, so swapping a personal key for a production one raises the ceiling
without code changes.

### Adding a game

1. Add the game to `gameIds` and `games` in `src/services/game/index.ts`. Display
   names and Discord/admin choices are derived from that registry.
2. Add an API client and decode schemas under `src/services/game/game-api/`.
3. Implement `GameAdapter` in `src/services/game/game-adapters/`: resolve an
   account, list its recent match ids in one request, fetch a match and map it
   to `MatchDetails`, optionally enrich it, and fetch rank data. Set
   `requiresMatchHistory` if an empty baseline should not persist the game, and
   `requiresOptIn` if the game's data may only be shown for players who signed
   in with Riot.
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
poll is logged and retried on the next tick. A server whose post fails doesn't
hold up the others; if its channel was deleted or the bot lost access, the
channel is unset until someone runs `/setup` again. When the bot is removed from
a server, that server's signups go with it.

## Setup

Requires Node and pnpm.

```sh
pnpm install
cp .env.example .env
```

Fill in `.env`:

| Variable                  | How to get it                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`       | [Discord Developer Portal](https://discord.com/developers/applications) → your app → Bot                                                            |
| `NOTIFICATION_CHANNEL_ID` | Optional. Where the admin CLI posts test reports without `--channel`: right-click a channel → Copy Channel ID (needs Developer Mode on)             |
| `RIOT_API_KEY`            | [developer.riotgames.com](https://developer.riotgames.com), key of a League of Legends product                                                      |
| `RIOT_TFT_API_KEY`        | [developer.riotgames.com](https://developer.riotgames.com), key of a separate Teamfight Tactics product. Riot keys only reach their own game's APIs |
| `HENRIK_API_KEY`          | [HenrikDev Discord](https://discord.com/invite/X3GaVkX2YN). Only used until `RIOT_VAL_API_KEY` is set                                               |
| `PORT`                    | Optional, default 3000. The web server's port; Railway sets it                                                                                      |

`RIOT_REGION`, `VAL_REGION` and `VAL_PLATFORM` are optional. Each account's
region is resolved and stored at signup; these are only fallbacks.

Invite the bot with the `bot` and `applications.commands` scopes, then run
`/setup` in your server to pick the report channel; the bot needs to view it,
send messages, embed links and attach files there. Commands register
themselves on startup.

```sh
pnpm start
```

The web server serves the bot's public pages at `/`, `/terms` and `/privacy`,
which Discord and Riot ask for when a bot goes public.

### VALORANT through Riot's API

Until Riot grants a VALORANT production key, VALORANT comes from HenrikDev's
unofficial API, whose free tier only covers a few dozen players. Riot only
issues VALORANT keys to approved products, and only lets a player's data be
shown once they sign in with Riot (RSO) to opt in. With the key and an RSO
client, set:

| Variable            | What it is                                                                         |
| ------------------- | ---------------------------------------------------------------------------------- |
| `RIOT_VAL_API_KEY`  | Key of a VALORANT product. Switches VALORANT to Riot's API                         |
| `RSO_CLIENT_ID`     | The product's RSO client, which turns on `/link`                                   |
| `RSO_CLIENT_SECRET` | Its secret, which also signs the sign-in links                                     |
| `PUBLIC_URL`        | The bot's public address; register `<PUBLIC_URL>/rso/callback` as the redirect URI |

Players then run `/link` to sign in with Riot. Riot encrypts player ids per key,
so VALORANT signups made through Henrik stop polling until their owners
`/link`, which replaces them.

### Moving off the single-channel setup

Before multi-server support, every account reported to `NOTIFICATION_CHANNEL_ID`.
After upgrading, those accounts report in no server until they're adopted:

```sh
pnpm admin setup <server-id> --channel <channel-id> --adopt
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
