# Live verification

Use a small, approved sample of real production account identities in an isolated
dev environment, and call the real game APIs. Mock-only tests do not establish
that credentials, provider schemas, enrichment or Discord delivery work together.
Never replay every production account or copy the production database for this.

## Local command and CI

`bun run check` stays offline with respect to game APIs and Discord (`audit` still
uses the package registry). Run `bun run test:live` once after the checks pass for
changes to account resolution, adapters, enrichment, cards, delivery or polling.
`bun run verify` is an alias. Neither command launches a gateway/polling daemon,
syncs commands, reads Railway, nor leaves a bot running.

Set these non-secret values outside the repo:

```sh
export LIVE_RIOT_ID='name#tag'  # one owner-approved real account with a completed recent match
export LIVE_GAME=valorant     # lol, valorant or tft; run only the affected game
export LIVE_DISCORD_APPLICATION_ID='<dedicated-dev-application-id>'
export DEV_GUILD_ID='<riot-tracker-testing-server-id>'
export NOTIFICATION_CHANNEL_ID='<riot-tracker-dev-channel-id>'
infisical run --projectId '<project-id>' --env dev --path /live-testing -- \
  env DEV_MODE=true bun run test:live
```

Infisical `dev /live-testing` should contain only the dev bot token and API
credentials needed by the adapters (`DISCORD_BOT_TOKEN`, `RIOT_API_KEY`,
`RIOT_TFT_API_KEY`, `HENRIK_API_KEY`, optional region/platform settings). The
current adapter layer reads all three provider keys even when only one game is
exercised. Do not grant CI the root folder containing other automation secrets,
1Password tokens, Railway credentials or production bot credentials.

Select the account once from an owner-approved production user or ask its owner;
store only the Riot ID as configuration. Do not enumerate the production servers
or users on each run. A recent completed match is required; no data is a failure,
not a passing test. Riot's consent-based adapter needs the manual `/link` flow;
the automated check refuses to invent consent or import production refresh tokens.

The command exercises real account lookup → fresh SQLite migrations and signup
state → one match discovery → enrichment → PNG rendering → Discord posting and
read-back → second poll with no duplicate → subscription removal. It uses the
production adapters, match engine and report posting function. The adapter's
history read is capped at one match; no match responses are mocked. It tests the
reporting pipeline, not gateway startup or slash-command routing.

Isolation and load bounds are fixed in code:

- A dedicated dev application ID, exactly one guild, and channel ownership are
  verified before any post. Copy IDs from the actual test channel; do not reuse
  a notification channel ID from a production configuration.
- One account, one game, one recent match, two finite polls, at most one Discord
  message POST attempt. No retries of an ambiguous Discord post.
- At most 24 API request attempts (Discord included), spaced at least two seconds
  apart, and 40 static asset attempts. Retries consume the same budget.
- A 401, 403 or 429 stops the run immediately, including optional enrichment.
  No immediate rerun after throttling; investigate credentials or wait for the
  provider's reset window. Never loop games/accounts until something passes.
- A three-minute deadline, a shared local lock across worktrees, and a fresh
  temporary SQLite directory which is removed on success or failure. If a
  machine crash leaves `/tmp/game-tracker-live.lock`, confirm no run is active
  before removing it. The artifact directory must be writable.

These are per-run bounds, not a distributed reservation of production quota.
Prefer separate dev API keys with independent quotas where providers allow it.
If a key/quota is shared with production, coordinate live runs, avoid busy periods
and stop on throttling. CI's lock does not cover local machines. At larger scale,
use dedicated quotas or a shared limiter before scheduling unattended checks;
do not claim a small run is guaranteed harmless to an already saturated key.

Evidence is `artifacts/live/results.json` (stage, request counts, last HTTP status and message IDs)
and `report.png`. CI retains only the summary for seven days because this repo
is public. Inspect real-player cards in the dev Discord channel; do not upload
them as public CI artifacts. Delete local PNG evidence after review. Raw provider
responses, tokens and production databases are not saved. A failed run exits nonzero and
does not silently count optional-enrichment authentication failures as success.

## GitHub Actions setup

`.github/workflows/live.yml` is manual-only; it does not run on PR pushes or
forks. It runs this same command and serializes all branches with one concurrency
group. Do not add a matrix or automatic reruns. GitHub may coalesce queued manual
runs; this is intentional protection from a burst of API checks.

Create a protected GitHub environment `live-testing` with a required reviewer and
trusted branch restrictions. Set its variables to the names shown above, plus
`INFISICAL_PROJECT_ID` and `INFISICAL_IDENTITY_ID`. Configure an Infisical machine
identity with OIDC, read access only to `dev /live-testing`, issuer
`https://token.actions.githubusercontent.com`, audience `infisical`, and subject
`repo:erik-bobinski/game-tracker-bot:environment:live-testing`. Follow the
[Infisical GitHub OIDC guide](https://infisical.com/docs/documentation/platform/identities/oidc-auth/github).
No persistent GitHub secret or production/Railway access is needed. Review the
selected code before approving a run: it will receive dev credentials.

The workflow is only usable after this one-time environment/identity setup and
the workflow is available in GitHub. Committing YAML alone does not configure
the external permissions. Keep regular CI mandatory; live checks are additional
evidence and may fail due to provider outages or an expired development key.

## Desktop Discord checklist for agents

Use the dedicated `agent` test account in **riot-tracker-testing →
#riot-tracker-dev** only. Never automate the owner's personal account. Read the
current status and verify the dev bot/application and server before interacting.
Use Infisical CLI for secrets. If needed on Ciaran, the scoped 1Password service
account reads only the agent's Discord and Google login items in `Agent Testing`;
do not grant the live CI identity access to that token. Stop for a human on
captcha, email verification or 2FA rather than bypassing it.

1. `/status`: private reply, truthful account/subscription/games/channel/pause and
   actionable steps. Copy the channel link if it shows `#unknown`.
2. `/signup`: real approved Riot ID; repeat signup; replacement warning without
   `replace_account`, then explicit confirmation. Check scope in each reply.
   Test nonexistent-ID and unavailable-provider cases separately: one provider's
   401 means existence cannot be ruled out even if the others return 404.
3. `/track`, `/rank_check` for the affected game. With fresh dev data, replay only
   one match via the bounded command above. Check readable PNG and summary.
4. `/untrack`, `/signout`, `/status`: verify removal and private next steps. Remove
   temporary fake identities created with `/dev_signup` using `/dev_signout`.
5. With Manage Server permission, `/setup`, `/pause`, `/resume`; verify that paused
   reports stay queued. Without that permission, confirm the commands are hidden
   and record the UI coverage limit; do not elevate the test user automatically.
6. `/link` only when dev RSO is configured with a dev callback and approved
   consent flow. Never route dev sign-in through the production callback.

`/dev_report` exercises mock cards without game API reads. Use it for relevant
games when needed. `/dev_clear` clears everyone's discovery history in that dev
database, so do not use it as a routine CI trigger: a busy dev bot could replay
many accounts. Prefer the one-account, one-match command. For a targeted manual
retry test, use isolated dev state, introduce one controlled delivery failure,
restore the channel, and verify success once plus no duplicate on the next poll.
Also cover revocation/retracking before pending rows drain—the regression which
previously let an empty cancelled row swallow a fresh delivery.

Never run a second bot gateway with the same application token. Capture the
result, failed cases and omissions; check the final queue/subscription state and
leave the existing dev service in its agreed state. Do not redeploy production.
