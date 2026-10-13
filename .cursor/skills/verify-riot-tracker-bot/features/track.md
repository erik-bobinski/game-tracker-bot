# Track and untrack

Picks which games a signed-up account reports (`/track`, `/untrack`, `pnpm admin track`, `pnpm admin untrack`). Signup tracks no games on its own.

## Sub-features

- `track` — resolves each picked game the account doesn't report yet and calls `addGame`
- `idempotent` — tracking the same game again reports `added: []`
- `untrack` — deletes the picked games' rows; `remaining: []` means the account is signed up with no games

## How to get to it (user POV)

Discord: `/track` or `/untrack` opens a multi-select, so one use picks any number of games. `/signup` sends the same track picker. Operator: `pnpm admin track <target> --game <game> [--game <game>…] --json` (or `--all`), same for `untrack`. Target is a discord id, name, or riot id.

## Driving it with admin CLI

Preconditions: account already signed up in the same `DB_PATH`.

- Action: `pnpm admin track verify-agent-user --game lol --json`
- Observable: JSON has `added`, `alreadyTracked`, `needsLink`, `notFound` arrays; a second run has empty `added`.
- Action: `pnpm admin untrack verify-agent-user --game lol --json`
- Observable: JSON has `removed`, `notTracked`, `remaining` arrays.

## Gotchas

- Mirrors the Discord pickers via the same `trackGames` and `untrackGames` functions.
- Failed API lookups land in `notFound`, not a hard error. A failed baseline fetch also lands there, so old matches are never reported as new.
- Games that need a Riot sign-in land in `needsLink`; only `/link` adds them.
