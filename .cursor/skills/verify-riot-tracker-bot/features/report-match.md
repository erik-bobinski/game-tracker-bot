# Report match

Reports one real, recent match through the path the match engine takes when it polls. The game adapter resolves the account and reads its recent matches. The chosen match is enriched (Performance Scores, RR, ranks) by the same `enrichOrSkip` step the engine calls, which falls back to an unenriched report with a warning if enrichment fails. Then the report is posted the way the bot posts it. Use it to check any change to adapters, enrichment, the card, or the embed against live data before it ships.

## Sub-features

- `report-match` posts the report (summary plus card, or the embed if the card fails) to `NOTIFICATION_CHANNEL_ID`
- `--out <file>` writes the card png instead of posting
- `--index <n>` picks an older match from the account's recent ones, `0` being the newest

## How to get to it (user POV)

`pnpm admin report-match 'name#tag' --game valorant --out /tmp/card.png --json` renders the card. Without `--out` the same command posts to `NOTIFICATION_CHANNEL_ID`.

## Driving it with admin CLI

Preconditions: `RIOT_API_KEY`, `RIOT_TFT_API_KEY`, `HENRIK_API_KEY`, isolated `DB_PATH`. Posting also needs `DISCORD_BOT_TOKEN` and `NOTIFICATION_CHANNEL_ID`. Locally, load them with `set -a && . .env.dev && set +a`. The dev Riot key for League expires every 24 hours, so a 401 on `--game lol` means the key needs renewing, not that the command is broken.

1. Pick a riot id whose recent matches cover what you changed. Tracked accounts come from `pnpm admin status --json`, locally or over `railway ssh` (see the parent skill). To test a specific mode, any public player works. Valorant leaderboard players come from Henrik, and League or TFT ladder players from Riot:
   ```bash
   curl -s -H "Authorization: $HENRIK_API_KEY" "https://api.henrikdev.xyz/valorant/v3/leaderboard/na/pc?size=20" | jq -r '.data.players[] | "\(.name)#\(.tag)"'
   curl -s -H "X-Riot-Token: $RIOT_TFT_API_KEY" https://na1.api.riotgames.com/tft/league/v1/challenger | jq -r '.entries[0].puuid'
   ```
   Riot ladders return puuids. Turn one into a riot id with `riot/account/v1/accounts/by-puuid/<puuid>` on `americas.api.riotgames.com` using the same key.
2. Render first and look at the png: `pnpm admin report-match 'name#tag' --game <game> --out /tmp/card.png --json`. The JSON names the `matchId`. If that match isn't the mode you need, try `--index 1` or `--index 2`, or another player.
3. Post it: drop `--out`. Then check the notification channel in a Discord client if you have one open. Otherwise the exit code and the JSON `channelId` and `matchId` are the proof.
4. Show nothing else moved: run `pnpm admin report-mock --game <game> --out /tmp/mock-branch.png` on your branch and the same with `/tmp/mock-master.png` in a detached worktree of `master` (`git worktree add --detach /tmp/master-wt origin/master`), then `cmp /tmp/mock-branch.png /tmp/mock-master.png`. Byte-identical mock cards mean the change only affects what it meant to.

Observable: exit 0 and JSON with `game`, `matchId`, and either `out` or `channelId`. Exit 3 with a one-line message for a malformed or unknown riot id, an account with no recent matches in that game, an `--index` past the recent matches, or an unwritable `--out` path. A missing or unknown `--game` is a usage error from the argument parser: exit 1 with help text.

## Gotchas

- Only an account's few most recent matches are reachable (`RECENT_MATCH_COUNT`). For a rare mode, find someone who just played it.
- The report is written from the riot account's side, and the summary names them by riot name.
- No rank snapshot is passed in, so League and TFT LP changes don't show. Valorant RR does, because Henrik's MMR history carries the delta.
- Rank emojis aren't loaded, so the embed fallback shows no rank icons. Changes to emoji rendering still need the bot itself.
- `NOTIFICATION_CHANNEL_ID` decides where the post lands. Only use the dev channel's id.
- Nothing is written to the database, but the admin CLI still opens `DB_PATH`, so point it at a scratch file.
