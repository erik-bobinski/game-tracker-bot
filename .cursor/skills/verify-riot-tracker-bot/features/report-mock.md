# Report mock embed

Posts a mock match scoreboard embed to the notification channel via Discord REST.

## Sub-features

- `report-mock` — builds mock match data and posts an embed (no live match required)

## How to get to it (user POV)

`pnpm admin report-mock --game lol --json`

## Driving it with admin CLI

Preconditions: `DISCORD_BOT_TOKEN`, `NOTIFICATION_CHANNEL_ID`.

- Action: `pnpm admin report-mock --game lol --json`
- Observable: exit 0, JSON includes `channelId` and `matchId`; embed appears in the notification channel.

## Gotchas

- Outbound only — no Discord user session required.
- Reuses the same mock payloads as `/dev_report`.
- Cloud agents should not log into Discord web to confirm the embed. REST success plus JSON `channelId` is the proof.
