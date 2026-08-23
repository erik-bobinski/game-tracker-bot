# Dev mock match report

`/dev_report` lets a developer post a full match scoreboard embed to the notification channel using mock API data, without waiting for a real game to finish.

## Sub-features

- `dev-report-lol` posts a League of Legends scoreboard with mock ranks.
- `dev-report-val` posts a Valorant scoreboard with agent stats.

## How to get to it (user POV)

- In the Discord test server, type `/dev_report` and choose `game: lol` or `game: valorant`.
- Only available when the bot runs with `DEV_MODE=true`.

## Driving it with control-riot-tracker + Discord

Preconditions:

- `control-riot-tracker doctor` reports ok with `devMode: true`.
- You can post slash commands in the test server where the bot is installed.

- **Invoke LoL mock.** Run `/dev_report` with `game: lol`. The bot replies `Mock match report sent.` within a few seconds.
- **Confirm channel embed.** Run `control-riot-tracker messages --limit 3`. The newest message in the notification channel has at least one embed with team/player fields (blue vs red, KDA, etc.).
- **Confirm logs.** Run `control-riot-tracker logs --tail 30`. Log contains `slash command invoked` with `command: dev_report`.
- **Proof.** Save `channel-messages.json` (from `messages`), `bot-log-tail.txt` (from `logs --tail 100`), and `dev-report-discord.png` (screenshot of the embed in Discord).
- **Valorant variant.** Repeat with `game: valorant`; embed should reference agents/maps instead of champions.

## Gotchas

- `/dev_report` is not registered when `DEV_MODE` is false — doctor must confirm `devMode: true` in logs.
- The embed lands in `NOTIFICATION_CHANNEL_ID`, not in the channel where you ran the command.
- A second bot instance using the same token will prevent gateway ready — always launch via this harness first.
- Ephemeral success text alone is insufficient proof; always fetch channel messages or screenshot the embed.
