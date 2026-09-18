# Report mock

Posts a mock match scoreboard to the notification channel via Discord REST.
The payload is a Components V2 message (`IS_COMPONENTS_V2`, flag `1 << 15`),
not a classic rich embed.

## Sub-features

- `report-mock` — builds mock match data and posts a Components V2 report (no live match required)

## How to get to it (user POV)

`pnpm admin report-mock --game lol --json`

## Driving it with admin CLI

Preconditions: `DISCORD_BOT_TOKEN`, `NOTIFICATION_CHANNEL_ID`.

- Action: `pnpm admin report-mock --game lol --json`
- Observable: exit 0, JSON includes `channelId`, `matchId`, and `flags` with
  `IS_COMPONENTS_V2` (`32768`) set. The report appears in the notification channel.

## Gotchas

- Outbound only — no Discord user session required.
- Reuses the same mock payloads as `/dev_report`.
- Cloud agents should not log into Discord web to confirm the message. REST
  success plus JSON `channelId` and V2 `flags` is the proof.
- Admin posts without boot-time rank emojis, so rank crests render as text.
  `/dev_report` on a running bot includes application emojis and rank thumbnails.
