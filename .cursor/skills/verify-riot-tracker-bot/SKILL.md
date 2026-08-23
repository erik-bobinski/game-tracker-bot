---
name: verify-riot-tracker-bot
description: Drive the riot-tracker Discord bot end-to-end — launch an isolated instance, invoke slash commands in Discord, and capture channel/log proof. Use when proving match-reporting, signup, or dev-mode behavior.
---

# Verify riot-tracker-bot

This skill drives the **Discord slash-command surface** of the riot-tracker bot. The bot is a long-lived Node process (gateway + polling); verification launches a disposable instance, exercises commands the way a user would in Discord, and captures log plus channel evidence.

**Do not drive a bot instance you did not start for this run.** Only one gateway connection per bot token is reliable; a shared dev instance will fight this harness.

**Cloud agents without a Discord login** can still verify `launch`, `doctor`, `logs`, and `messages` (REST channel fetch). Full `/dev_report` proof requires invoking the slash command in the test server (human or `computerUse` with Discord access).

## Launch

Prerequisites:

- **Node 24+** on `PATH` ahead of `/exec-daemon` (see `AGENTS.md`). The helper uses `NODE24` (default: `~/.nvm/versions/node/v24.19.0/bin/node`).
- Ambient env: `DISCORD_BOT_TOKEN`, `NOTIFICATION_CHANNEL_ID`, `DEV_MODE=true`.
- `pnpm install` already run in the repo root.

Start an isolated instance:

```bash
export RUN_ID="verify-$(date +%s)"
export PATH="$(dirname "$NODE24"):$PATH"
.cursor/skills/verify-riot-tracker-bot/control-riot-tracker launch
```

Ready when `control-riot-tracker doctor` exits 0 and logs contain:

- `database ready; migrations applied`
- `slash commands registered` with `devMode: true`
- `discord gateway ready`

Each run uses:

- `DB_PATH=/tmp/riot-tracker-verify-$RUN_ID/riot-tracker.sqlite` (disposable)
- tmux session `riot-tracker-verify-$RUN_ID`
- log at `/tmp/riot-tracker-verify-$RUN_ID/bot.log`

Teardown (instances only — **not** artifacts):

```bash
.cursor/skills/verify-riot-tracker-bot/control-riot-tracker stop
```

## Doctor

Run before the first drive and after any failed drive:

```bash
.cursor/skills/verify-riot-tracker-bot/control-riot-tracker doctor
```

Requires: process alive, log markers above present, `DEV_MODE` confirmed in logs.

## Drive

**Harness split:**

1. **Terminal** — `control-riot-tracker` for launch, doctor, logs, and Discord REST message fetch.
2. **Discord client** — slash commands (`/dev_report`, `/signup`, etc.) must be invoked by a human tester or the `computerUse` subagent in the configured test server.

Slash command names (with `DEV_MODE=true`):

| Command | Purpose |
|---------|---------|
| `/dev_report game:<lol\|valorant>` | Post a mock match scoreboard embed |
| `/dev_signup riot_name:… riot_tag:…` | Track a Riot account under a fake identity |
| `/dev_clear` | Clear reported-match history |
| `/dev_signout` | Remove a tracked account |
| `/signup` | Production signup (hits live Riot APIs) |
| `/signout` | Remove caller's account |
| `/pause` / `/resume` | Pause or resume polling |
| `/rank_check user:… game:<lol\|valorant>` | Rank embed for a signed-up user |

**Driving `/dev_report` (preferred smoke test):**

1. `control-riot-tracker launch` then `doctor`.
2. In Discord (test server), run `/dev_report` with `game: lol`.
3. Expect ephemeral reply: `Mock match report sent.`
4. Fetch channel messages:

   ```bash
   .cursor/skills/verify-riot-tracker-bot/control-riot-tracker messages --limit 3
   ```

5. Confirm the newest message in `NOTIFICATION_CHANNEL_ID` has embeds (scoreboard fields, team stats).

Read `.cursor/skills/verify-riot-tracker-bot/features/README.md` before driving; use the matching feature file as the recipe.

## Evidence

Save proof under `/opt/cursor/artifacts/riot-tracker-verify/$RUN_ID/`:

| Artifact | Contents |
|----------|----------|
| `channel-messages.json` | REST fetch of notification channel (from `control-riot-tracker messages`) |
| `dev-report-discord.png` | Screenshot of the scoreboard embed in Discord |
| `bot-log-tail.txt` | `control-riot-tracker logs --tail 100` after the command |

**Proof standards:**

- Exercise the real user path (Discord slash command → channel embed), not internal imports.
- Capture both the command acknowledgment and the resulting channel message.
- Log proof must show `slash command invoked` with `command: dev_report`.
- Mocks are acceptable only via `/dev_report` / `/dev_signup` (dev-mode boundaries).
- `/signup` and `/rank_check` hit live Riot/Henrik APIs — use sparingly.

## Cleanup

```bash
.cursor/skills/verify-riot-tracker-bot/control-riot-tracker stop
```

- Stops the PID recorded for `RUN_ID` and kills the tmux session.
- Removes the disposable sqlite file under `/tmp/riot-tracker-verify-$RUN_ID/`.
- **Does not** delete `/opt/cursor/artifacts/riot-tracker-verify/$RUN_ID/`.

Never `pkill -f tsx` or kill by process name.

## Helpers

All commands go through the script (must be executable):

```bash
.cursor/skills/verify-riot-tracker-bot/control-riot-tracker <launch|doctor|logs|messages|stop>
```

Environment knobs: `RUN_ID`, `NODE24`, `DB_PATH`, `ARTIFACT_DIR`, `REPO_ROOT`.

Maintenance: `/maintain-verification-skill` keeps the feature map honest as commands change.
