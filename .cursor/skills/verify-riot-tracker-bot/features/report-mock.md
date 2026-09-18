# Report mock

Posts a mock match scoreboard to the notification channel via Discord REST.
The payload is a Components V2 message (`IS_COMPONENTS_V2`, flag `1 << 15`),
not a classic rich embed.

Cloud agents must post this only to **riot-tracker-testing**. Never Wise Fellas.

## Sub-features

- `report-mock` — builds mock match data and posts a Components V2 report (no live match required)

## How to get to it (user POV)

`pnpm admin report-mock --game lol --json`

## Driving it with admin CLI

Preconditions: `DISCORD_BOT_TOKEN`, and a **testing** channel id. For `pnpm verify`
that is `VERIFY_NOTIFICATION_CHANNEL_ID`, `TESTING_NOTIFICATION_CHANNEL_ID`, or
the channel from `DISCORD_TEST_CHANNEL_URL`. Ambient `NOTIFICATION_CHANNEL_ID`
is ignored by verify because it often points at Wise Fellas.

- Action: `pnpm admin report-mock --game lol --json`
- Observable: exit 0, JSON includes `channelId`, `matchId`, and `flags` with
  `IS_COMPONENTS_V2` (`32768`) set. The report appears in riot-tracker-testing.
  `channelId` must equal `1523432733785722940`.

## Gotchas

- Outbound only — no Discord user session required.
- Reuses the same mock payloads as `/dev_report`.
- Cloud agents should not log into Discord web to confirm the message. REST
  success plus JSON `channelId` (testing server) and V2 `flags` is the proof.
- Admin posts without boot-time rank emojis, so rank crests in the scoreboard
  lines are text. Rank thumbnails use square HTTPS crests, not a Media Gallery.
  `/dev_report` on a running bot also inlines application emojis in the player
  list.
- Refuses every destination outside riot-tracker-testing guild
  `1523432684691525802`, channel `1523432733785722940`.
- If testing Discord credentials are missing, `pnpm verify` skips this send
  instead of posting to production.
