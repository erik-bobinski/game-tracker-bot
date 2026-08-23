# Rank check

`/rank_check` looks up the current ranked tier for a signed-up user in League or Valorant and replies with a rank embed.

## Sub-features

- `rank-check-lol` shows League rank for a signed-up user.
- `rank-check-val` shows Valorant rank for a signed-up user.

## How to get to it (user POV)

- `/rank_check user:<member> game:lol` or `game:valorant`.
- Target must already be signed up for that game.

## Driving it with control-riot-tracker + Discord

Preconditions:

- Target user is signed up (`/signup` or `/dev_signup` succeeded for that game).
- `RIOT_API_KEY` / `HENRIK_API_KEY` valid for live rank lookup.
- `control-riot-tracker doctor` reports ok.

- **Unsigned user.** Run `/rank_check` on a user with no account. Expect `**<name>** isn't signed up for …`.
- **Signed-up user.** Run `/rank_check` for a signed-up member. Expect deferred reply then either a rank embed or `has no ranked data`.
- **Proof.** Screenshot the follow-up embed or message; save `bot-log-tail.txt`.

## Gotchas

- Command pings are avoided in replies (username text, not `<@id>` mentions).
- Rank data comes from live APIs — seasonal downtime or unranked accounts produce "no ranked data", not necessarily a bug.
- Prefer `/dev_report` for smoke tests; use rank check only when signup verification is in scope.
