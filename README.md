# game-tracker-bot

A Discord bot that posts a scoreboard to your server when someone finishes a
game.

The goal is to be **game agnostic**: League of Legends, Teamfight Tactics and
VALORANT are the current implementations, but supporting another game should
mean writing one adapter, not touching the rest of the app.

Players sign up with their Riot ID and pick the games to report, and each
server picks the channel its reports go to. A match several signed-up players
were in is posted once per server, naming the ones who signed up there, and
each account is polled once however many servers report it.

## Commands

| Command                          | What it does                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `/setup <channel>`               | Pick the channel this server's reports go to (Manage Server)                       |
| `/signup <riot_name> <riot_tag>` | Start reporting your matches in this server, or switch your Riot ID                |
| `/status`                        | Privately check account, games, consent and server reporting settings              |
| `/track`                         | Pick games to report, in every server you're signed up in                          |
| `/untrack`                       | Pick games, or all of them, to stop reporting                                      |
| `/link`                          | Sign in with Riot so your VALORANT matches can be reported                         |
| `/signout`                       | Stop reporting your matches here; your data is deleted when no server reports them |
| `/rank_check <user> <game>`      | Post the current rank of someone signed up here, with their tier emblem            |
| `/pause` / `/resume`             | Stop or restart this server's reports (Manage Server)                              |

Replacing an existing Riot ID with `/signup` requires `replace_account: true` after a warning. It changes the account in every subscribed server and resets consent-based games.

Every game is opt-in: signing up reports nothing until you pick games, and it
opens the `/track` picker right away. Riot only shares VALORANT matches for
players who signed in with Riot, so with Riot's VALORANT API, VALORANT also
needs `/link`.

Commands only work in servers. Server admins can hand `/setup`, `/pause` and
`/resume` to other roles under Server Settings → Integrations.

## Running it

Requires [Bun](https://bun.sh) (the version in `package.json`'s
`packageManager`).

```sh
bun install
cp .env.example .env   # then fill it in, see below; bun loads it
bun start
```

Invite the bot with the `bot` and `applications.commands` scopes, then run
`/setup` in your server. The bot needs to view the report channel, send
messages, embed links and attach files there. Commands register themselves on
startup.

### Configuration

Riot keys come from [developer.riotgames.com](https://developer.riotgames.com),
one product per game, since a key only reaches its own game's APIs.

| Variable            | What it is                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN` | [Discord Developer Portal](https://discord.com/developers/applications) → your app → Bot                        |
| `RIOT_API_KEY`      | League of Legends key                                                                                           |
| `RIOT_TFT_API_KEY`  | Teamfight Tactics key                                                                                           |
| `RIOT_VAL_API_KEY`  | VALORANT key. Without it, VALORANT comes from HenrikDev's unofficial API instead                                |
| `RSO_CLIENT_ID`     | The VALORANT product's Riot Sign On client, which turns on `/link`                                              |
| `RSO_CLIENT_SECRET` | Its secret, which also signs the sign-in links                                                                  |
| `PUBLIC_URL`        | The bot's public address. Register `<PUBLIC_URL>/rso/callback` as the RSO redirect URI                          |
| `HENRIK_API_KEY`    | Only without `RIOT_VAL_API_KEY`, from the [HenrikDev Discord](https://discord.com/invite/X3GaVkX2YN)            |
| `DB_PATH`           | Optional, default `game-tracker.sqlite`. Keep it on a persistent volume                                         |
| `RIOT_VERIFICATION` | Optional. The string Riot gives to verify your site, served at `/riot.txt`                                      |
| `PORT`              | Optional, default 3000                                                                                          |
| `RIOT_REGION`       | Optional, default `americas`. Each account's region is stored at signup, so this and the next two are fallbacks |
| `VAL_REGION`        | Optional, default `na`. HenrikDev only                                                                          |
| `VAL_PLATFORM`      | Optional, default `pc`. HenrikDev only                                                                          |

Set `RIOT_VAL_API_KEY` together with the RSO variables: with Riot's VALORANT
API, matches are only reported for players who ran `/link`.

The web server also serves the public pages Discord and Riot ask for, at `/`,
`/terms` and `/privacy`, and is where Riot's sign-in returns to.

### Switching to production keys

Riot encrypts player IDs separately for every key, so stored accounts have to
move when a game's key changes. The bot reads each key's rate limits off
Riot's responses, so the higher production limits apply on their own.

**League of Legends and TFT.** Set the new key, keep the old one valid until
this is done, and run:

```sh
RIOT_PREVIOUS_KEY=<old LoL key> bun run admin rekey lol
RIOT_PREVIOUS_KEY=<old TFT key> bun run admin rekey tft
```

Each account keeps its reported matches and rank history. Accounts that can't
be moved are listed, and rerunning skips the ones already moved.

**VALORANT.** Set `RIOT_VAL_API_KEY`, `RSO_CLIENT_ID`, `RSO_CLIENT_SECRET` and
`PUBLIC_URL`. Each player then runs `/link` once; their VALORANT matches are
reported from then on.

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
bun dev           # restarts on change, loads .env
bun run check     # format, lint, typecheck, tests and audit, as CI runs them
```

## Architecture

TypeScript on [Effect](https://effect.website) v4 and [Bun](https://bun.sh),
with [dfx](https://github.com/tim-smart/dfx) for Discord and SQLite for storage.
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

After the bot was down or paused (no poll for 10 minutes), the next poll looks
back 10 matches instead of 3 and posts at most the 5 newest each player missed,
oldest first; older ones are skipped and logged. League and TFT LP changes come
from the live rank against the last saved one, so they only show when exactly
one ranked game was played since then; otherwise the report shows current LP.

Failures stay small: an undecodable match is skipped, a failed rank lookup
drops the emblem, a failed poll is retried on the next tick, and a server whose
channel is gone has it unset until someone runs `/setup` again.

### Adding a game

1. Add it to `gameIds` and `games` in `src/services/game/index.ts`.
2. Add an API client and decode schemas under `src/services/game/game-api/`.
3. Implement `GameAdapter` (`game-adapters/adapter.ts`) as a service and layer
   in `src/services/game/game-adapters/`, as `lol.ts` does: resolve an account,
   list its recent match ids, fetch a match into `MatchDetails`, and fetch
   ranks. Set `requiresOptIn` if Riot only shares the game for players who
   signed in with Riot.
4. Register it in `GameAdaptersLive` and provide its client from `src/index.ts`.
5. Add a mock for `/dev_report`, then run `bun run check`.

Game-specific shapes stay inside the client and adapter; polling, storage and
reporting work on the shared types.

## Delivery retries and local checks

Discovered matches are queued in SQLite per game, match and server before player
history advances. Each poll retries unposted deliveries until they post, no
subscribed player is left in them, or they are a day old. A day-old delivery is
dropped and logged: HenrikDev can only refetch a match still in a player's
recent history, and a channel that has failed that long shouldn't flood with
its backlog once it works again. A server that already got a match isn't posted
it again. Paused servers keep their pending deliveries; untracking or signing
out removes the player's queued identity immediately. Retries use the current
report channel.

Discord posting and SQLite acknowledgement are not atomic. A shutdown waits for
the pair to finish, but a crash between them can still produce a duplicate.
Only the poll that discovers a match holds its rank changes. A later retry
enriches the match again without the saved rank snapshots, so it shows current
ranks and only movement that needs no snapshot (Valorant's per-match RR). A posted delivery's row is deleted; each player's own reported
match history is what stops a rediscovery from posting again.

`src/services/match-engine/delivery.test.ts` covers this with temporary SQLite
files and stubbed game and Discord services, run by `bun run check`.
It needs no credentials and does not connect a bot. Live Discord command registration
and UI behavior still need verification in a dedicated development server.

Live testing needs a separate Discord application, never the production token:
the bot syncs its commands globally for its application. With `DEV_MODE=true`,
`DEV_GUILD_ID` must name the dev server, and startup stops before connecting if
the bot is in any other server. That check cannot prove the token belongs to a
dedicated dev application, so confirm that before starting it.
