# Signup

Tracks a Riot account for a fake Discord user via the admin CLI.

## Sub-features

- `signup` — checks the Riot ID exists, then persists the account with only the games passed in (none by default)

## How to get to it (user POV)

`bun run admin signup <riot-id> --discord-id <id> [--game <game>…] --json`. In Discord, `/signup` tracks nothing and sends the `/track` picker; see [Track and untrack](./track.md).

## Driving it with admin CLI

Preconditions: `RIOT_API_KEY`, `RIOT_TFT_API_KEY`, `HENRIK_API_KEY`, isolated `DB_PATH`, real riot id.

- Action: `bun run admin signup <riot-id> --discord-id verify-agent-user --json`
- Observable: JSON includes a `games` array, empty unless `--game` was passed, or exit non-zero with a clear error.
- Without `--guild <server-id>` the account reports in no server, so the bot never polls it. Pass one to exercise polling; see [Servers](./servers.md).

## Gotchas

- Signup calls live Riot/Henrik APIs; a bad riot id fails the step.
- Prefer a production Riot ID from `railway ssh -- bun run admin status --json`. Do not hardcode `VERIFY_RIOT_ID` when Railway works.
- A Henrik 404 on Valorant (`play a game` / account payload missing) is expected for some Riot IDs when `--game valorant` is passed. Valorant stays untracked; the other games still save.
- `railway whoami` Unauthorized does not mean signup cannot get a production id. See the parent skill's Railway section.
