# Signup

Tracks a Riot account for a fake Discord user via the admin CLI.

## Sub-features

- `signup` — resolves Riot ID across game adapters and persists to sqlite

## How to get to it (user POV)

`pnpm admin signup <riot-id> --discord-id <id> --json`

## Driving it with admin CLI

Preconditions: `RIOT_API_KEY`, `HENRIK_API_KEY`, isolated `DB_PATH`, real riot id.

- Action: `pnpm admin signup syan#NA1 --discord-id verify-agent-user --json`
- Observable: JSON includes `games` array with at least one entry, or exit non-zero with a clear error.

## Gotchas

- Signup calls live Riot/Henrik APIs; a bad riot id fails the step.
- Use production-derived riot ids when possible (`RAILWAY_TOKEN` or `PRODUCTION_DB_PATH`).
