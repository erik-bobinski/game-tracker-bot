# Riot Tracker Bot

A Discord worker that reports newly completed League of Legends and Valorant
matches for users who opt in. The business logic is game-agnostic: provider
clients decode raw API responses, adapters normalize each game, and the Match
Engine handles coalescing, ordering, notification, and deduplication.

## Requirements

- Node.js 24
- pnpm 11
- A Discord application and bot token
- Production: Riot and HenrikDev API keys

Install dependencies with `pnpm install --frozen-lockfile`.

## Discord setup

Create separate Discord applications for development and production. In each
application, create a bot and invite it with the `bot` and
`applications.commands` scopes. The bot needs permission to view and send
messages and embeds in the notification channel.

Commands are registered globally with `Ix.global`. Discord may take time to
propagate global command changes. Separate applications keep development-only
commands out of the production command set.

## Configuration

Copy `.env.example` and set:

| Variable                  | Purpose                                 | Default               |
| ------------------------- | --------------------------------------- | --------------------- |
| `APP_MODE`                | `development` or `production`           | `production`          |
| `DISCORD_BOT_TOKEN`       | Token for the environment's Discord bot | required              |
| `NOTIFICATION_CHANNEL_ID` | Channel receiving match reports         | required              |
| `RIOT_API_KEY`            | Riot API key                            | required              |
| `HENRIK_API_KEY`          | HenrikDev API key                       | required              |
| `DB_PATH`                 | SQLite database file                    | `riot-tracker.sqlite` |
| `POLL_INTERVAL`           | Effect duration such as `1 minute`      | `1 minute`            |

Riot development keys expire after 24 hours. A persistent production worker
needs an appropriate non-expiring key.

## Local development

`.env.dev` should use the dedicated development Discord application and include:

```dotenv
APP_MODE=development
DB_PATH=riot-tracker.dev.sqlite
```

Run `pnpm dev`. Discord and SQLite remain real. Only the game adapters are
replaced with in-memory dev adapters backed by mock accounts and staged
matches, so nothing reaches the Riot or Henrik networks. The Match Engine,
Polling, database, and embed services remain in the path.

Available mock Riot IDs:

| Riot ID          | Games and routes             |
| ---------------- | ---------------------------- |
| `MockAlpha#NA1`  | LoL `na1`, Valorant `na/pc`  |
| `MockBravo#NA1`  | LoL `na1`, Valorant `na/pc`  |
| `MockEuropa#EUW` | LoL `euw1`, Valorant `eu/pc` |

The development commands are:

- `/dev_accounts` lists the catalog.
- `/dev_match` stages a mock match report.
- `/dev_poll` runs one real polling pass.

Suggested manual walkthrough:

1. Run `/pause`.
2. Run `/signup` with one or two mock identities.
3. Run `/dev_match` and optionally select a signed-up teammate.
4. Run `/resume`; it unpauses and polls immediately.
5. Verify the real Discord match notification.
6. Stage with `duplicate:true`, run `/dev_poll`, and verify no second report.
7. Stage a shared match and verify one notification names both Discord users.
8. Exercise `/rank_check` and both forms of `/signout`.

## Commands

- `/signup riot_name riot_tag` discovers every supported game and route. It can
  be rerun to add a newly available game without replacing existing state.
- `/signout [game]` removes one game, or the whole account when omitted.
- `/rank_check user game` reports current ranked queues or `Unranked.`
- `/pause` pauses all polling.
- `/resume` resumes and immediately runs a pass.

LoL discovery resolves a Riot ID through regional clusters, then probes
Summoner-V4 across supported platform routes. Valorant discovery uses Henrik's
v2 account response and prefers PC when both PC and console are available.
Riot distinguishes [platform and regional routing values](https://developer.riotgames.com/docs/lol),
and Henrik documents [account platform data](https://docs.henrikdev.xyz/valorant/api-reference/accounts)
and [current MMR](https://docs.henrikdev.xyz/valorant/api-reference/mmr).

Existing database rows are migrated to former defaults (`na1` and `na/pc`) and
their tracking start is reset to migration time to prevent historical spam.
Existing non-NA users should sign out of that game and sign up again to discover
the correct route.

## Build and verification

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm check
pnpm start
```

`pnpm check` runs typechecking, the Vitest suite, and the production build.

## Persistence and delivery behavior

SQLite is stored at `DB_PATH`. Match IDs are retained in a bounded per-user,
per-game history. Matches started before signup are never announced.

Notifications are at-least-once. A failed Discord send stays pending and is
retried. If Discord succeeds but the subsequent SQLite write fails, a rare
duplicate can occur on the next pass. This is intentional for a small
single-replica deployment.

## Railway

The repository includes `railway.toml` for a Railpack build, `pnpm start`, one
replica, and restart-on-failure. This is a background worker, so it has no HTTP
health check or public-domain requirement.

Production variables:

```dotenv
APP_MODE=production
DB_PATH=/data/riot-tracker.sqlite
POLL_INTERVAL=1 minute
RAILPACK_NODE_VERSION=24
DISCORD_BOT_TOKEN=...
NOTIFICATION_CHANNEL_ID=...
RIOT_API_KEY=...
HENRIK_API_KEY=...
```

Attach one Railway volume at `/data`; otherwise SQLite is lost on deployment.
See [Railway volume documentation](https://docs.railway.com/volumes).

## Troubleshooting

- Configuration failures at startup name the missing or malformed variable.
- `401`/`403` provider errors usually indicate an invalid or expired API key.
- `429` and provider server failures are operational errors, not “account not
  found”; retry after the provider recovers.
- If commands are missing, confirm the bot invitation includes
  `applications.commands`, then allow for global propagation.
- If notifications fail, verify the channel ID and the bot's channel permissions.
- If a route is wrong after migration, sign out of that game and sign up again.
