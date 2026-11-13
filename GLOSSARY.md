# Glossary

Use these words in code, commits, PRs and replies. When a name in the code
disagrees with this file, fix one of them in the same PR.

## Players and servers

- **Account**: one Discord user's signup (`accounts`), holding a Riot ID (`name#tag`).
- **Game account**: an account's identity in one game (`account_games`): its **PUUID**, routing region and `reported_matches`. One PUUID per game maps to at most one Discord user.
- **Server**: a Discord guild (`guilds`). Has one **report channel** and can be **paused**. Say "server" to people; `guild` stays in code and Discord APIs.
- **Subscription**: an account reporting into a server (`guild_accounts`). `/track` and `/untrack` change every subscribed server; `/signout` affects only the current one.
- **Tracked player**: a player in a match who has a subscription in the server receiving the report. Everyone else in the lobby is a plain player.
- **Opt-in**: games whose adapter `requiresOptIn` (Riot sign-in) report only after `/link` sets `opted_in_at`.

## Matches and reports

- **Poll**: one pass of the match engine over every game account (`pollOnce`).
- **Baseline**: the recent match IDs saved at signup, so old matches are never reported as new.
- **Discovery**: a poll finding a match ID that isn't in `reported_matches` (capacity 10 per game account).
- **Match report** (`MatchReport`): the match details plus its tracked players. Built once per match, posted once per server.
- **Card**: the PNG rendered from a report by `match-card.tsx`. **Embed**: the Discord text and fallback that go with it (`embed.ts`).
- **Delivery**: one `match_deliveries` row per (game, match, server) waiting to post. Deleted when it posts; dropped after a day.
- **Enrichment**: optional per-match extras fetched after discovery (ranks, crests). A failed enrichment never blocks the report.
- **Rank movement**: the LP/RR change between two rank snapshots of the same queue. Only ranked matches produce snapshots.

## Riot routing (three different words)

- **platformId**: the shard an account lives on (`na1`, `euw1`). Riot's "platform routing value". Not PC/console.
- **Cluster**: the regional host match-v5 lives on (`americas`, `europe`), derived from the platformId.
- **Henrik region**: Valorant's region for Henrik's API (`na`, `eu`). The player's region, not a Henrik server.

## Environments and verification

- **Prod**: the Railway service deployed from `master`. **Dev**: anything run with the dev bot's own Discord application and `DEV_MODE=true`, locally or on Railway's dev service.
- **Test server**: the `riot-tracker-testing` Discord server. The only server any agent posts to.
- **Mock report**: a report built from fixture data (`/dev_report`, `admin report-mock`). Proves layout, not API behaviour.
- **Live test**: `bun run test:live`. One real account, one real match, one post to the test server.
- **Live gate**: the required `Live verification gate` status. Pending until the live test passes for that exact commit.
- **Vouched**: listed in `.github/VOUCHED.td` on `master`. Write collaborators count as vouched.
