# Pause and resume polling

Pause stops the bot from reporting new matches and sets its Discord presence to idle; resume re-enables polling and sets presence back to online.

## Sub-features

- `pause` stops match reports.
- `resume` restarts match reports.

## How to get to it (user POV)

- `/pause` — no options.
- `/resume` — no options.

## Driving it with control-riot-tracker + Discord

Preconditions:

- `control-riot-tracker doctor` reports ok.

- **Pause.** Run `/pause`. Bot replies `Match reports paused.`
- **Confirm logs.** `control-riot-tracker logs --tail 20` shows no error from `pause failed`.
- **Resume.** Run `/resume`. Bot replies `Match reports resumed.`
- **Proof.** Save `bot-log-tail.txt` covering both commands; optional screenshot of bot presence changing (idle → online) in the member list.

## Gotchas

- Presence updates are per gateway connection; a reconnect may briefly show stale status.
- Pausing does not delete accounts or reported-match history.
- These commands do not post to the notification channel — log + ephemeral reply are the proof.
