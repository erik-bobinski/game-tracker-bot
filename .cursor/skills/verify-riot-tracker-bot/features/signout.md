# Sign out

Sign out removes a tracked account and deletes its stored match history from the disposable database.

## Sub-features

- `signout-self` removes the caller's account via `/signout`.
- `dev-signout-user` removes a member's account via `/dev_signout user:<member>`.
- `dev-signout-fake` removes a fake dev identity via `/dev_signout riot_name:… riot_tag:…`.

## How to get to it (user POV)

- `/signout` — removes your own tracked account.
- `/dev_signout user:<member>` or `/dev_signout riot_name:… riot_tag:…` — dev variants.

## Driving it with control-riot-tracker + Discord

Preconditions:

- Target account was previously signed up (see [signup](./signup.md)).
- `control-riot-tracker doctor` reports ok.

- **Sign out when not registered.** Run `/signout` on a fresh disposable DB. Expect `You're not signed up.`
- **Sign out after dev signup.** Run `/dev_signup` then `/dev_signout riot_name:… riot_tag:…` with the same Riot id. Expect `**<name>** signed out, all data deleted.`
- **Proof.** Screenshot replies; save `bot-log-tail.txt`.

## Gotchas

- `/dev_signout` requires either `user` or both `riot_name` and `riot_tag`.
- Signout is destructive for that account's rows in the current `DB_PATH` only.
- Production `/signout` affects the shared database if not using an isolated verification instance — always use `control-riot-tracker launch` first.
