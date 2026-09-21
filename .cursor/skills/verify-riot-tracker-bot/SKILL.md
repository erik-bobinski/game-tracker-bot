---
name: verify-riot-tracker-bot
description: End-to-end verification for the riot-tracker Discord bot. Use when a cloud agent must run the bot and check a mock report in the testing Discord server.
---

# Verify riot-tracker-bot

Run the bot, post a mock match report, and confirm it in Discord. When `AGENT_EMAIL`, `AGENT_EMAIL_PASSWORD`, and `DISCORD_TEST_CHANNEL_URL` are all set, do that in the browser the way a user would. When any of them is unset, or login stops on captcha, an email code, or 2FA, prove the same channel with the bot token over Discord REST. Say that the browser path is blocked. Never print `AGENT_EMAIL` or `AGENT_EMAIL_PASSWORD`. Never bypass captcha, steal cookies, or extract TOTP codes.

## Launch

```bash
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}" && . "$NVM_DIR/nvm.sh" && nvm use 24
export PATH="$NVM_BIN:$PATH"
node .cursor/skills/verify-riot-tracker-bot/scripts/discord-rest-proof.mjs
```

Node 24 is required. `pnpm start` reads ambient env. `pnpm dev` passes `--env-file=.env` and fails here because that file does not exist.

The script writes `/opt/cursor/artifacts/verify-discord-<timestamp>/`. It uses an isolated sqlite file under `/tmp` and deletes that file when it finishes. Artifacts stay.

### Which Discord bot

Prefer the **dev** Railway environment. Its bot token is not the production gateway, and `DEV_MODE=true` there.

Cursor Cloud injects project tokens as `RAILWAY_API_TOKEN_DEV` and `RAILWAY_API_TOKEN_PROD`. The CLI only scopes those to the project when they are in `RAILWAY_TOKEN`. Putting a project token in `RAILWAY_API_TOKEN` alone makes `railway status` report "No linked project".

The script copies `RAILWAY_API_TOKEN_DEV` onto `RAILWAY_TOKEN` and runs `railway run --service riot-tracker-bot --environment dev` so the child receives `DISCORD_BOT_TOKEN` and `NOTIFICATION_CHANNEL_ID` without printing them. It does not start a gateway against **production**: a second session kicks the live bot and replaces global slash commands.

Do not set `VERIFY_RIOT_ID` when either Railway token is present. Mock report proof does not need a Riot account. `pnpm verify` still resolves one for signup; that lookup does not read `RAILWAY_API_TOKEN_DEV` / `RAILWAY_API_TOKEN_PROD`. See the product gap in [references/cloud-agent-lessons.md](references/cloud-agent-lessons.md).

## Doctor

```bash
node --version   # v24
```

The proof script is the doctor for Discord: it refuses to continue when no bot token and no Railway project token exist. For a bot you started yourself, the log must contain `slash commands registered` and either `discord gateway ready` or `application started`.

## Drive

Read [features/README.md](features/README.md) before a single feature.

### Browser, when all three UI secrets are set

1. `pnpm start` with `DEV_MODE=true` and an isolated `DB_PATH`, using the **dev** bot token (see Launch). Do not start the production token.
2. Open `https://discord.com/login`. Type the email from `AGENT_EMAIL`, then the password from `AGENT_EMAIL_PASSWORD`. Click Log In. Do not echo either value.
3. If captcha, an email code, or 2FA appears, stop. Record `browser: blocked` and fall through to REST.
4. Open `DISCORD_TEST_CHANNEL_URL`. Type `/`, choose `dev_report`, set `game` to `lol`, and submit.
5. The bot replies in that channel ("Mock match report sent.") and posts the scoreboard embed to `NOTIFICATION_CHANNEL_ID`. If the URL's channel id is not `NOTIFICATION_CHANNEL_ID`, the embed is in the notification channel, not the channel you typed in. The app does not read `DISCORD_TEST_CHANNEL_URL`.

### REST, always, and whenever the browser path is blocked

`discord-rest-proof.mjs` does all of this:

- `GET /applications/@me` then `GET /applications/{id}/commands`
- `pnpm admin report-mock --game lol --json` (same mock payload as `/dev_report`)
- `GET /channels/{NOTIFICATION_CHANNEL_ID}/messages` and keeps the new embed

`/dev_report` is in the command list only after a process with `DEV_MODE=true` has registered commands. The dev environment is that process. Production leaves `DEV_MODE` unset, so its command list omits `dev_*`.

## Evidence

`/opt/cursor/artifacts/verify-<run-id>/`:

- `browser.json` — `ready` or `blocked`, with the missing secret **names** only
- `slash-commands.json` — application id and command names
- `report.json` — `channelId`, `matchId`, `messageId`, embed title
- `results.json` — the summary
- `bot.log` — boot excerpt when the script started a bot

Proof is the embed row in `report.json` plus the command names. A Henrik 404 is unrelated to this feature.

## Cleanup

The script deletes `/tmp/riot-verify-<run-id>.sqlite` and stops the bot process group it spawned. It does not delete the artifact directory. Do not kill processes by name.

## Helpers

```bash
node .cursor/skills/verify-riot-tracker-bot/scripts/discord-rest-proof.mjs
```

Optional: `VERIFY_RUN_ID`, `VERIFY_ARTIFACT_DIR`, `VERIFY_RAILWAY_ENVIRONMENT` (`dev` or `production`). Default environment is `dev` when `RAILWAY_API_TOKEN_DEV` is set.
