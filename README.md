# Riot Tracker Bot

## Production admin CLI

The running Rust bot exposes a private Unix-domain socket inside its Railway
container. Admin commands sent through that socket operate on the same in-memory
database, persistent `accounts.json`, API clients, and polling flag as Discord
slash commands.

Set a reusable shell prefix:

```bash
railway_admin=(
  railway ssh
  --project b7c45da2-61ef-4c9b-8d46-9a64baaf1f22
  --service 3c97af33-467b-4c28-8e03-4d291cfe501f
  --environment production
  /app/bin/riot-tracker-bot admin
)
```

Then run:

```bash
"${railway_admin[@]}" status
"${railway_admin[@]}" pause
"${railway_admin[@]}" resume
"${railway_admin[@]}" signout --discord-user-id 502202450183454721
"${railway_admin[@]}" rank-check --discord-user-id 502202450183454721 --game val
"${railway_admin[@]}" signup \
  --discord-user-id 502202450183454721 \
  --discord-name syanx_ \
  --riot-name syan \
  --riot-tag 7571
```

Human-readable output is the default. Add `--json` before or after the admin
subcommand for automation:

```bash
"${railway_admin[@]}" signout --discord-user-id 502202450183454721 --json
```

Discord user IDs are authoritative; usernames are not accepted as selectors.
`signup`, `signout`, `pause`, and `resume` mutate live production state
immediately. CLI commands do not post messages into Discord.

Exit codes:

- `0`: success
- `2`: invalid CLI usage
- `3`: live admin socket unavailable
- `4`: command rejected, invalid request, or target not found
- `5`: database, upstream API, protocol, or internal failure

The socket defaults to `/tmp/riot-tracker-bot-admin.sock`. Override it with
`ADMIN_SOCKET_PATH` for local testing. Railway SSH is the authorization boundary;
the bot does not expose a public admin port.

If recovery from a bad mutation is required, stop the bot before restoring a
persistent-volume backup so the live in-memory database cannot overwrite the
restored file.
