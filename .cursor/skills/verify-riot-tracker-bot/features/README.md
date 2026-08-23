# riot-tracker-bot verification map

This directory is the maintained source for verifying user-facing Discord behavior. Read this index before driving the app, then open the matching feature file as the recipe.

## Baseline preconditions

- `DEV_MODE=true`, `DISCORD_BOT_TOKEN`, and `NOTIFICATION_CHANNEL_ID` are set in the environment.
- Node 24 is available (`NODE24` points at a v24 binary; see `AGENTS.md`).
- Launch with a disposable database:

  ```bash
  export RUN_ID="verify-$(date +%s)"
  .cursor/skills/verify-riot-tracker-bot/control-riot-tracker launch
  .cursor/skills/verify-riot-tracker-bot/control-riot-tracker doctor
  ```

- Drive slash commands from the configured Discord test server (human or `computerUse`).
- Never drive a bot instance that was not started by this verification run.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise.
- Invoke slash commands by name (`/dev_report`, `/signup`, …) in Discord; do not call internal Effect services directly.
- After mutations, confirm both the ephemeral command reply and the notification channel (when applicable).
- Use `control-riot-tracker messages` for machine-readable channel proof; screenshot the embed for human-readable proof.
- Restore disposable DB state by stopping the instance (`control-riot-tracker stop`); do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the slash command, the bot's reply, and the channel side effect (embed or text).
- Channel proof: `channel-messages.json` plus a screenshot showing the embed.
- Log proof: `bot-log-tail.txt` with `slash command invoked` for the command under test.
- Record the feature ID and entry point with every artifact.
- Report unreachable paths with the attempted command and unmet prerequisite.
- Do not claim a feature verified through a different entry point than the map lists.

## Features

- [Dev mock match report](./dev-report.md) — `/dev_report` posts a LoL or Valorant scoreboard embed without live matches.
- [Account signup](./signup.md) — `/signup` and `/dev_signup` track Riot accounts.
- [Pause and resume polling](./pause-resume.md) — `/pause` and `/resume` toggle match reporting.
- [Sign out](./signout.md) — `/signout` and `/dev_signout` remove tracked accounts.
- [Rank check](./rank-check.md) — `/rank_check` shows a rank embed for a signed-up user.
