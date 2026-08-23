# Account signup

Signup lets a Discord user link a Riot ID so the bot tracks their matches. Dev signup creates fake identities for multi-user testing without pinging real members.

## Sub-features

- `signup-live` registers the caller's real Discord account via `/signup` (hits Riot/Henrik APIs).
- `dev-signup-fake` registers a fake identity via `/dev_signup riot_name:… riot_tag:…`.
- `dev-signup-user` registers on behalf of another server member via `/dev_signup` with the `user` option.

## How to get to it (user POV)

- `/signup riot_name:<name> riot_tag:<tag>` — production path.
- `/dev_signup riot_name:<name> riot_tag:<tag>` — dev path with a synthetic Discord user id.
- `/dev_signup … user:<member>` — dev path tied to a real member (no ping).

## Driving it with control-riot-tracker + Discord

Preconditions:

- `control-riot-tracker doctor` reports ok.
- For `/signup` and live lookups: valid `RIOT_API_KEY` and `HENRIK_API_KEY` in the environment.
- Use a Riot ID known to have recent match history when testing production signup.

- **Dev fake signup.** Run `/dev_signup riot_name:VerifyBot riot_tag:TEST`. Expect deferred reply then `Now tracking **VerifyBot (dev)**; shared matches report as multi-user.` or `Couldn't find recent account data…` if the Riot ID does not resolve.
- **Confirm database.** After success, `control-riot-tracker logs --tail 20` should not show `dev_signup failed`.
- **Proof.** Screenshot the follow-up message; save `bot-log-tail.txt`.
- **Production signup (optional).** Run `/signup` with a real Riot ID. Expect `**<username>** just signed up!` or a not-found message. Hits external APIs — run only when API keys are valid and rate limits allow.

## Gotchas

- `/signup` and `/dev_signup` defer the reply; wait for the webhook follow-up, not just the initial "thinking" state.
- Re-running signup for the same Discord user returns `already signed up`.
- Fake dev identities use discord user ids like `dev-<riot_name>-<riot_tag>` — they do not appear as real Discord members.
- Production signup requires live API access; failures may be environmental, not product bugs.
