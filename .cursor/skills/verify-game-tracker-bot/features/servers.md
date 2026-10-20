# Servers

Checks that one bot process reports into several Discord servers: each server
gets its own post in its own channel, a broken channel is unset without
holding up the others, and an account is polled once however many servers
report it.

## Sub-features

- `setup` — a server's report channel, set with `/setup` or `pnpm admin setup`
- `fan-out` — one post per server, naming the players who signed up there
- `unreachable channel` — Unknown Channel or Missing Access unsets that server's channel

## Driving it with the admin CLI and a live bot

Preconditions: dev bot token, a Riot key that isn't expired (the TFT key lasts,
the dev League key dies daily), isolated `DB_PATH`. The dev server id is the
`guild_id` of `NOTIFICATION_CHANNEL_ID` (`GET /channels/{id}` with the bot token).

1. `pnpm admin setup <dev-server-id> --channel <dev-channel-id>`
2. `pnpm admin signup <riot-id> --discord-id verify-agent-user --guild <dev-server-id> --json`
3. A second server that can't be posted to: `pnpm admin setup 111111111111111111 --channel 222222222222222222`, then
   `sqlite3 $DB_PATH "INSERT INTO guild_accounts (guild_id, discord_user_id) VALUES ('111111111111111111','verify-agent-user')"`
4. Make recent matches look new: `sqlite3 $DB_PATH "UPDATE account_games SET reported_matches='[]'"`
5. `pnpm start`, wait for `poll finished`

Observable: `matchesReported` above 0, the cards in the dev channel, a
`report channel unreachable` warning for the fake server, and
`pnpm admin status --json` showing that server's `channelId` unset.

## Gotchas

- A real player to track: the TFT challenger ladder (`/tft/league/v1/challenger`
  on `na1`) always has active accounts; resolve one with
  `/riot/account/v1/accounts/by-puuid/{puuid}`.
- Fake discord ids aren't server members, so the nickname lookup warns and the
  report uses the signup name. That's expected.
- An account with `reported_matches='[]'` reports up to three matches at once,
  oldest first.
