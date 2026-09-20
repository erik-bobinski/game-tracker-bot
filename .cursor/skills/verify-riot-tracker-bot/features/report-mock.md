# Report mock embed

Posts a scoreboard embed built from a committed production match fixture.

## Sub-features

- `fixtures:check` — decode all 50 production matches and render embeds locally
- `report-mock` — post one fixture embed to the notification channel (no live match required)

## How to get to it (user POV)

`pnpm fixtures:check`
`pnpm admin report-mock --game lol --json`
`pnpm admin report-mock --game valorant --json`

## Driving it with admin CLI

Preconditions: `DISCORD_BOT_TOKEN`, `NOTIFICATION_CHANNEL_ID`. `fixtures:check` needs no secrets.

- Action: `pnpm fixtures:check`
- Observable: exit 0, JSON includes `"ok": true`, `"lol": 25`, `"valorant": 25`.
- Action: `pnpm admin report-mock --game lol --json`
- Observable: exit 0, JSON includes `channelId` and a real `matchId` (not `NA1_DEV_...`).

`/dev_report` uses the same `productionMatchReport` helper.

## Gotchas

- Fixtures live in `src/fixtures/production-matches.json`. They are schema-pruned Riot/Henrik payloads from production-tracked players, not sqlite rows (prod sqlite only stores match ids).
- Refresh with `python3 scripts/dump-production-matches.py`. Project tokens must use GraphQL header `project-access-token`.
- Outbound Discord REST only. Cloud agents should not log into Discord web. REST success plus JSON `channelId` is the proof for `report-mock`.
