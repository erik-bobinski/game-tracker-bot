#!/usr/bin/env bash
# Run the bot locally and make it report real, recent matches to the test
# channel right away, without waiting for anyone to finish a game.
#
# How it works: seeds a throwaway accounts DB (accounts.test.json) with the
# given riot accounts, pre-filling each account's "already reported" ring with
# its current match window EXCEPT the newest SKIP_N matches per game. The
# polling loop then sees those omitted matches as new on its first tick and
# reports them through the normal pipeline (dedup, multi-user naming, RR/LP
# lookups, embed building). Matches shared by several seeded accounts come out
# as one multi-user report.
#
# Usage:
#   scripts/test-local.sh                        # defaults to Jerbear#6519 Zuccdaddy#NA1
#   scripts/test-local.sh "Name#Tag" ["Name#Tag" ...]
#   SKIP_N=2 scripts/test-local.sh               # report the 2 newest matches per game
#
# Needs .env.local in the repo root with the LOCAL bot's DISCORD_TOKEN,
# GUILD_ID, NOTIFICATION_CHANNEL_ID (test server), HENRIK_API_KEY, RIOT_API_KEY.
# Ctrl-C stops the bot. Rerunning reseeds, so the same matches report again.
set -euo pipefail

cd "$(dirname "$0")/.."

for tool in curl jq cargo; do
  command -v "$tool" >/dev/null || { echo "error: $tool not installed" >&2; exit 1; }
done
[ -f .env.local ] || { echo "error: .env.local not found in repo root" >&2; exit 1; }

set -a
# shellcheck disable=SC1091
source .env.local
set +a
: "${DISCORD_TOKEN:?}" "${NOTIFICATION_CHANNEL_ID:?}" "${HENRIK_API_KEY:?}" "${RIOT_API_KEY:?}"

SKIP_N="${SKIP_N:-1}"
DB_FILE="accounts.test.json"

if [ $# -eq 0 ]; then
  set -- "Jerbear#6519" "Zuccdaddy#NA1"
fi

accounts="[]"
discord_user_id=1000

for riot_id in "$@"; do
  name="${riot_id%%#*}"
  tag="${riot_id##*#}"
  # riot names may contain spaces etc.; they travel in url path segments
  enc_name=$(jq -rn --arg s "$name" '$s|@uri')
  enc_tag=$(jq -rn --arg s "$tag" '$s|@uri')

  # --- valorant: henrik resolves puuid + region in one lookup ---
  val_puuid=""
  val_region=""
  val_ring="[]"
  val_account=$(curl -s -H "Authorization: $HENRIK_API_KEY" \
    "https://api.henrikdev.xyz/valorant/v2/account/$enc_name/$enc_tag")
  if [ "$(jq -r '.status // 0' <<<"$val_account")" = "200" ]; then
    val_puuid=$(jq -r '.data.puuid' <<<"$val_account")
    val_region=$(jq -r '.data.region' <<<"$val_account")
    # current window, newest first, minus the SKIP_N matches we want re-reported
    val_ring=$(curl -s -H "Authorization: $HENRIK_API_KEY" \
      "https://api.henrikdev.xyz/valorant/v3/by-puuid/matches/$val_region/$val_puuid" \
      | jq --argjson n "$SKIP_N" \
        '[.data // [] | .[] | select(.is_available) | .metadata.matchid | ascii_downcase] | .[$n:]')
  fi

  # --- lol: account-v1 for the puuid, then probe clusters for the region ---
  lol_puuid=$(curl -s -H "X-Riot-Token: $RIOT_API_KEY" \
    "https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/$enc_name/$enc_tag" \
    | jq -r '.puuid // empty')
  lol_region=""
  lol_ring="[]"
  if [ -n "$lol_puuid" ]; then
    for region in americas asia europe sea; do
      ids=$(curl -s -H "X-Riot-Token: $RIOT_API_KEY" \
        "https://$region.api.riotgames.com/lol/match/v5/matches/by-puuid/$lol_puuid/ids")
      if [ "$(jq 'if type == "array" then length else 0 end' <<<"$ids")" -gt 0 ]; then
        lol_region="$region"
        lol_ring=$(jq --argjson n "$SKIP_N" 'map(ascii_downcase) | .[$n:]' <<<"$ids")
        break
      fi
    done
  fi

  if [ -z "$val_puuid" ] && [ -z "$lol_puuid" ]; then
    echo "warning: $riot_id resolved in neither game, skipping" >&2
    continue
  fi
  # an empty ring makes the poller baseline instead of report (see polling.rs)
  if [ "$val_ring" = "[]" ] && [ "$lol_ring" = "[]" ]; then
    echo "warning: $riot_id has too little match history to seed a ring, nothing will be reported for it" >&2
  fi

  echo "seeded $riot_id  (val: ${val_region:-none}, lol: ${lol_region:-none})"

  accounts=$(jq \
    --argjson id "$discord_user_id" \
    --arg discord_name "$(tr '[:upper:]' '[:lower:]' <<<"$name")-test" \
    --arg name "$name" --arg tag "$tag" \
    --arg val_puuid "$val_puuid" --arg val_region "$val_region" \
    --arg lol_puuid "$lol_puuid" --arg lol_region "$lol_region" \
    --argjson val_ring "$val_ring" --argjson lol_ring "$lol_ring" \
    --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '. + [{
      discord_user_id: $id,
      discord_name: $discord_name,
      riot_name: $name,
      riot_tag: $tag,
      val_puuid: $val_puuid,
      val_region: (if $val_region == "" then null else $val_region end),
      reported_val_match_ids: $val_ring,
      lol_puuid: $lol_puuid,
      lol_region: (if $lol_region == "" then null else $lol_region end),
      reported_lol_match_ids: $lol_ring,
      lol_rank_snapshots: {},
      added_at: $now
    }]' <<<"$accounts")
  discord_user_id=$((discord_user_id + 1))
done

if [ "$accounts" = "[]" ]; then
  echo "error: no accounts could be seeded" >&2
  exit 1
fi

jq -n --argjson accounts "$accounts" \
  '{schema_version: 1, accounts: $accounts}' > "$DB_FILE"

echo
echo "wrote $DB_FILE; starting bot — the $SKIP_N newest match(es) per game per"
echo "account will be reported to channel $NOTIFICATION_CHANNEL_ID within seconds."
echo "ctrl-c to stop."
echo

DB_PATH="$DB_FILE" exec cargo run
