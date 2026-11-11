---
name: verify-game-tracker-bot
description: Verify account, adapter, enrichment, card, delivery and polling changes with bounded real-data API tests and dev Discord UI checks.
---

# Verify game-tracker-bot

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

The dedicated Infisical **Game Tracker Live Testing** project, `dev /live-testing`,
contains only the dev bot token and API
credentials needed by the adapters (`DISCORD_BOT_TOKEN`, `RIOT_API_KEY`,
`RIOT_TFT_API_KEY`, `HENRIK_API_KEY`, optional region/platform settings). The
current adapter layer reads all three provider keys even when only one game is
exercised. CI has a read-only Viewer identity in this isolated project and no
organization access. The regular app project's root contains other automation
secrets; never grant that project to this identity. Folder-scoped custom roles
require a paid Infisical plan, so project isolation provides the boundary here.

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

## CI trust and manual opt-in

This follows T3 Code's [PR Vouch](https://github.com/pingdotgg/t3code/blob/main/.github/workflows/pr-vouch.yml)
and [one-use fork preview label](https://github.com/pingdotgg/t3code/blob/main/.github/workflows/mobile-eas-preview-fork.yml)
patterns, adapted to real API tests:

- Normal CI runs format, lint, typecheck, offline tests and audit for public PRs.
- The trusted `live-gate.yml` workflow reads GitHub metadata to determine whether
  runtime `src/`, dependencies, dependency patches, Dockerfile, trust policy or
  CI/live workflows changed. Docs and test-only changes need no API call.
  Single-game changes select that game; shared changes use the configured game.
- The gate covers only open PRs into the default branch. The status is one per
  commit, so a PR into any other branch never sets it, spends a label or runs
  live tests, even at the same SHA. PR-number dispatch has the same restriction.
- Write collaborators, including the repository owner, and contributors in the
  default branch's `.github/VOUCHED.td` get relevant live tests automatically,
  but only when the PR's head is an upstream branch or a fork owned by the PR
  author. A trusted author's PR from anyone else's fork, including an
  organization's, needs **live:verify**. A deleted head repository never runs.
  Vouch is checked with the same pinned `mitchellh/vouch` action T3 Code uses.
  Arbitrary bot accounts are not automatically trusted for test credentials.
- To give another contributor the bypass, add `github:username` to VOUCHED.td
  and merge it after review. Do not copy another project's trusted usernames.
  The action reads the default branch's list, so a PR cannot vouch for itself.
  Trust grants use of dev test credentials for future code; it is not a cosmetic
  label. No new identity or per-person workflow edits are needed.
- For anyone else, a write maintainer reviews the code and applies **live:verify**
  in the PR's **Labels** menu. The workflow checks the labeler's repository
  permission, consumes the label, and pins the approved head SHA before running.
  Removing the label first cancels that approval. A new push needs a new label;
  an old label/event never approves new code. This is the direct PR-UI trigger.

The controller never checks out contributor code or reads game credentials.
Only after trust or explicit one-commit approval does it call the shared live
workflow. That workflow runs normal checks on the pinned code, then the bounded
pipeline. No further environment approval is required: the trust/label decision
is the approval. Do not run unreviewed foreign code with dev credentials.

For an explicit rerun, Actions → **Live pipeline verification** → **Run workflow**
on the default branch also accepts a PR number and game. The regular CI workflow
retains a manual `run_live` fallback for an allowed trusted branch. Its **Manual
live verification** job is normally skipped; automatic selection happens in
**Live verification gate**, not that manual job.

The separate required **Live verification gate** commit status remains pending
when live testing is needed but not authorized. It passes only after the exact
commit's test succeeds. Unrelated changes pass without an API call. Failed or
cancelled runs cannot pass it. `master` requires this status and `check` from
GitHub Actions, branches up to date, with admin enforcement. Never mark it passed
based on local evidence or an older SHA. Gate updates and result publication
serialize per SHA; all API runs share one concurrency group. No automatic reruns
or game matrix. GitHub may coalesce queued runs to limit bursts.

The controller uses `pull_request_target` solely for metadata/trust selection;
its definition and trust list must come from the protected default branch.
Never add PR checkout or dependency scripts to the privileged selection job.
The later live job deliberately executes the trusted/reviewed PR with read-only
dev secrets, without a persisted GitHub token; status publication uses a separate
runner. The controller activates after its workflow reaches the base branch.
A missing required status is blocking during initial setup too.

The single `live-testing` environment has no extra required reviewer. Restrict
its deployment policy to the trusted default branch. Store its non-secret test
configuration plus `INFISICAL_PROJECT_ID` and `INFISICAL_IDENTITY_ID` as environment
variables. The Infisical identity has no organization access and Viewer access
only in **Game Tracker Live Testing**, not the regular app project. Its token
lives for three minutes. It trusts issuer `https://token.actions.githubusercontent.com`,
audience `infisical`, and the exact immutable environment subject. Obtain the
repository prefix with:

```sh
gh api repos/<owner>/<repo>/actions/oidc/customization/sub
```

Append `:environment:live-testing` to `sub_claim_prefix`; don't use the older
name-only format or a wildcard subject. Bound claims restrict the exact upstream
repository, repository/owner IDs, the `workflow_dispatch` and `pull_request_target`
events, and only `ci.yml`, `live.yml`, `live-gate.yml` workflow refs on the default
branch. Infisical accepts comma-separated allowed claim values. This trusts the
upstream workflow definitions, not arbitrary fork workflow edits. Keep fork
GITHUB_TOKEN permissions read-only. No persistent GitHub secret, Railway access,
per-contributor identity or production bot token is needed. See the
[Infisical GitHub OIDC guide](https://infisical.com/docs/documentation/platform/identities/oidc-auth/github).

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
