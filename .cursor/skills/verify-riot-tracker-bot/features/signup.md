# Signup

Tracks a Riot account for a fake Discord user via the admin CLI.

## Sub-features

- `signup` — resolves Riot ID across game adapters and persists to sqlite

## How to get to it (user POV)

`pnpm admin signup <riot-id> --discord-id <id> --json`

## Driving it with admin CLI

Preconditions: `RIOT_API_KEY`, `HENRIK_API_KEY`, isolated `DB_PATH`, real riot id.

- Action: `pnpm admin signup <riot-id> --discord-id verify-agent-user --json`
- Observable: JSON includes `games` array with at least one entry, or exit non-zero with a clear error.

## Gotchas

- Signup calls live Riot/Henrik APIs; a bad riot id fails the step.
- Prefer a production Riot ID from `railway ssh -- pnpm admin status --json`. Do not hardcode `VERIFY_RIOT_ID` when Railway works.
- A Henrik 404 on Valorant (`play a game` / account payload missing) is expected for some Riot IDs. League can still be in `games`; Valorant stays untracked until they play.
- `railway whoami` Unauthorized does not mean signup cannot get a production id. See the parent skill's Railway section.
