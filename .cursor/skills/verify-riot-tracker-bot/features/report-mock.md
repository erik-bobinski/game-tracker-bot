# Report mock

Posts a mock match scoreboard card to the notification channel via Discord REST. The embed is only posted if the card fails to render.

## Sub-features

- `report-mock` — builds mock match data and posts its card (no live match required); `--out <file>` writes the card png instead of posting

## How to get to it (user POV)

`pnpm admin report-mock --game lol --json`

## Driving it with admin CLI

Preconditions: `DISCORD_BOT_TOKEN`, `NOTIFICATION_CHANNEL_ID`.

- Action: `pnpm admin report-mock --game lol --json`
- Observable: exit 0, JSON includes `channelId` and `matchId`; the card appears in the notification channel.

## Gotchas

- Outbound only — no Discord user session required.
- Reuses the same mock payloads as `/dev_report`.
- Cloud agents should not log into Discord web to confirm the post. REST success plus JSON `channelId` is the proof.
