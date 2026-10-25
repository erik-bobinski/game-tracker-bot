# game-tracker-bot

A Discord bot that posts a scoreboard card when someone finishes a League of
Legends, Teamfight Tactics or VALORANT match. Players sign up with their Riot
ID and pick the games to report, and each server picks the channel its reports
go to. When several signed-up players were in the same match, each server gets
one post naming the ones who signed up there.

One bot process serves every server, and each Riot account is polled once
however many servers report it, so API usage grows with players, not servers.

## Commands

| Command                          | What it does                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `/setup <channel>`               | Pick the channel this server's reports go to (Manage Server)                       |
| `/signup <riot_name> <riot_tag>` | Start reporting your matches in this server, or switch your Riot ID                |
| `/track`                         | Pick games to report, in every server you're signed up in                          |
| `/untrack`                       | Pick games, or all of them, to stop reporting                                      |
| `/link`                          | Sign in with Riot so your VALORANT matches can be reported                         |
| `/signout`                       | Stop reporting your matches here; your data is deleted when no server reports them |
| `/rank_check <user> <game>`      | Post the current rank of someone signed up here, with their tier emblem            |
| `/pause` / `/resume`             | Stop or restart this server's reports (Manage Server)                              |

Every game is opt-in: signing up reports nothing until you pick games, and it
opens the `/track` picker right away. Riot only shares VALORANT matches for
players who signed in with Riot, so with Riot's VALORANT API, VALORANT also
needs `/link`.

Commands only work in servers. Server admins can hand `/setup`, `/pause` and
`/resume` to other roles under Server Settings → Integrations.

## Running it

Requires Node 24 and pnpm.

```sh
pnpm install
cp .env.example .env   # then fill it in, see below
pnpm start
```

Invite the bot with the `bot` and `applications.commands` scopes, then run
`/setup` in your server. The bot needs to view the report channel, send
messages, embed links and attach files there. Commands register themselves on
startup.

### Configuration

Riot keys come from [developer.riotgames.com](https://developer.riotgames.com),
one product per game, since a key only reaches its own game's APIs.

| Variable                  | What it is                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`       | [Discord Developer Portal](https://discord.com/developers/applications) → your app → Bot                        |
| `RIOT_API_KEY`            | League of Legends key                                                                                           |
| `RIOT_TFT_API_KEY`        | Teamfight Tactics key                                                                                           |
| `RIOT_VAL_API_KEY`        | VALORANT key. Without it, VALORANT comes from HenrikDev's unofficial API instead                                |
| `RSO_CLIENT_ID`           | The VALORANT product's Riot Sign On client, which turns on `/link`                                              |
| `RSO_CLIENT_SECRET`       | Its secret, which also signs the sign-in links                                                                  |
| `PUBLIC_URL`              | The bot's public address. Register `<PUBLIC_URL>/rso/callback` as the RSO redirect URI                          |
| `HENRIK_API_KEY`          | Only without `RIOT_VAL_API_KEY`, from the [HenrikDev Discord](https://discord.com/invite/X3GaVkX2YN)            |
| `DB_PATH`                 | Optional, default `game-tracker.sqlite`. Keep it on a persistent volume                                         |
| `NOTIFICATION_CHANNEL_ID` | Optional. Where the admin CLI posts test reports without `--channel`                                            |
| `RIOT_VERIFICATION`       | Optional. The string Riot gives to verify your site, served at `/riot.txt`                                      |
| `PORT`                    | Optional, default 3000                                                                                          |
| `RIOT_REGION`             | Optional, default `americas`. Each account's region is stored at signup, so this and the next two are fallbacks |
| `VAL_REGION`              | Optional, default `na`. HenrikDev only                                                                          |
| `VAL_PLATFORM`            | Optional, default `pc`. HenrikDev only                                                                          |

Set `RIOT_VAL_API_KEY` together with the RSO variables: with Riot's VALORANT
API, matches are only reported for players who ran `/link`.

The web server also serves the public pages Discord and Riot ask for, at `/`,
`/terms` and `/privacy`, and is where Riot's sign-in returns to.

### Switching to production keys

Riot encrypts player IDs separately for every key, so stored accounts have to
move when a game's key changes. The bot reads each key's rate limits off
Riot's responses, so the higher production limits apply on their own.

**League of Legends and TFT.** Set the new key, keep the old one valid until
this is done, and run in the production container:

```sh
RIOT_PREVIOUS_KEY=<old LoL key> pnpm admin rekey lol
RIOT_PREVIOUS_KEY=<old TFT key> pnpm admin rekey tft
```

Each account keeps its reported matches and rank history. Accounts that can't
be moved are listed, and rerunning skips the ones already moved.

**VALORANT.** Set `RIOT_VAL_API_KEY`, `RSO_CLIENT_ID`, `RSO_CLIENT_SECRET` and
`PUBLIC_URL`. Each player then runs `/link` once; their VALORANT matches are
reported from then on.

## Deployment

Production runs on [Railway](https://game-tracker-bot.up.railway.app). Pushes
to `master` run CI and deploy to the Railway service, whose `/data` volume
holds the database.

## Admin CLI

The bot's operations without Discord, run inside the production container:

```sh
railway ssh --service game-tracker-bot
pnpm admin <command>
```

| Command                                                              | What it does                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `status`                                                             | Polling state, the database in use, every server and tracked account |
| `signup <riot-id> --discord-id <id> [--guild <id>] [--game <game>…]` | Sign someone up, reporting in that server, with the games given      |
| `track <target> --game <game>… \| --all`                             | Start reporting games for a signed-up account                        |
| `untrack <target> --game <game>… \| --all`                           | Stop reporting games for a signed-up account                         |
| `signout <target>`                                                   | Stop tracking an account everywhere and delete its data              |
| `setup <guild-id> --channel <id> [--adopt]`                          | Set a server's report channel; `--adopt` adds accounts in no server  |
| `pause` / `resume`                                                   | Stop or restart all reports, in every server                         |
| `rank-check <target> [--game <game>]`                                | Look up a tracked account's current rank                             |
| `rekey <lol\|tft>`                                                   | Move a game's accounts to a new Riot key                             |
| `report-mock [--game <game>] [--channel <id>]`                       | Post a mock match card                                               |
| `report-match <riot-id> --game <game> [--channel <id>]`              | Report a real recent match through the polling pipeline              |

`<target>` is a Discord user ID, a Discord name or a Riot ID. A missing
argument is prompted for, `--json` prints JSON and never prompts, and every
command takes `--help`.

## Development

Run a second bot application in a test server, with its own token and keys,
and set `DEV_MODE=true` for three extra commands:

| Command                              | What it does                                                               |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `/dev_clear`                         | Forget reported matches, so the next poll re-reports your real recent ones |
| `/dev_report <game>`                 | Post a report built from mock API responses                                |
| `/dev_signup <riot_name> <riot_tag>` | Track a Riot account under a fake Discord identity                         |

Tracked users are just database rows, so `/dev_signup` lets you produce real
multi-player reports while you're alone in the test server.

```sh
pnpm dev          # loads .env
pnpm typecheck
```

## Architecture

TypeScript on [Effect](https://effect.website) v4, with
[dfx](https://github.com/tim-smart/dfx) for Discord and SQLite for storage.
Every piece is an Effect service, wired together in `src/index.ts`.

```
src/
  index.ts           layer wiring and entry point
  admin/             the admin CLI, a second entry point
  services/
    polling/         ticks every 3 minutes, unless paused
    match-engine/    finds new matches and reports them
    game/            game-agnostic types, one adapter and API client per game
    discord/         gateway, slash commands, embeds and cards
    database/        SQLite storage and migrations
    rso/             Riot Sign On, for games that need a player's opt-in
    web/             public pages and the sign-in callback
```

Each tick, the match engine polls every account that an active server reports.
One request per account lists its recent matches; each new match is fetched
once, however many tracked players were in it, then posted once per server and
recorded. Riot and HenrikDev requests are paced under the rate limits their
responses state.

Failures stay small: an undecodable match is skipped, a failed rank lookup
drops the emblem, a failed poll is retried on the next tick, and a server whose
channel is gone has it unset until someone runs `/setup` again.

### Adding a game

1. Add it to `gameIds` and `games` in `src/services/game/index.ts`.
2. Add an API client and decode schemas under `src/services/game/game-api/`.
3. Implement `GameAdapter` in `src/services/game/game-adapters/`: resolve an
   account, list its recent match ids, fetch a match into `MatchDetails`, and
   fetch ranks. Set `requiresOptIn` if Riot only shares the game for players
   who signed in with Riot.
4. Register it in `GameAdaptersLive` and provide its client from `src/index.ts`.
5. Add a mock for `/dev_report`, then run `pnpm typecheck`.

Game-specific shapes stay inside the client and adapter; polling, storage and
reporting work on the shared types.
