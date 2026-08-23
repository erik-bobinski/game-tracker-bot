# Refresh

Rechecks a signed-up account for games that were missing at signup.

## Sub-features

- `refresh` — looks up untracked game adapters, calls `addGame` for new hits
- `idempotent` — second refresh reports `added: []`

## How to get to it (user POV)

`pnpm admin refresh <target> --json` where target is a discord id, name, or riot id.

## Driving it with admin CLI

Preconditions: account already signed up in the same `DB_PATH`.

- Action: `pnpm admin refresh verify-agent-user --json`
- Observable: JSON has `added`, `tracked`, `missing` arrays; second run has empty `added`.

## Gotchas

- Mirrors `/refresh` slash command logic via the same `refreshAccount` function.
- Failed API lookups land in `missing`, not a hard error.
