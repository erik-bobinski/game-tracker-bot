#!/usr/bin/env python3
"""Refresh src/fixtures/production-matches.json from production reports."""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from pathlib import Path

PROJECT = os.environ.get("RAILWAY_PROJECT_ID", "b7c45da2-61ef-4c9b-8d46-9a64baaf1f22")
ENV = os.environ.get("RAILWAY_ENVIRONMENT", "8592d056-0e7d-48a7-a334-2320316add60")
SVC = os.environ.get("RAILWAY_SERVICE", "3c97af33-467b-4c28-8e03-4d291cfe501f")
TARGET_EACH = 25
LOL_PER_ACCOUNT = 20
VAL_PER_ACCOUNT = 10
DISCORD_PAGES = 8

RIOT_CLUSTERS = ("americas", "europe", "asia", "sea")
HENRIK_REGIONS = ("na", "eu", "ap", "kr", "latam", "br")

BOLD_RIOT = re.compile(r"\*\*([^*#\n]{1,32})#([^*#\s]{1,16})\*\*")
PLAIN_RIOT = re.compile(r"(?<![#\w])([A-Za-z0-9][A-Za-z0-9 _.\-]{0,30})#([A-Za-z0-9]{2,16})")

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "src/fixtures/production-matches.json"

LOL_DECODE_FIELDS = {
    "metadata": {"matchId": True, "participants": True},
    "info": {
        "gameMode": True,
        "gameDuration": True,
        "gameStartTimestamp": True,
        "queueId": True,
        "platformId": True,
        "participants": {
            "puuid": True,
            "riotIdGameName": True,
            "riotIdTagline": True,
            "teamId": True,
            "championName": True,
            "kills": True,
            "deaths": True,
            "assists": True,
            "win": True,
            "totalMinionsKilled": True,
            "neutralMinionsKilled": True,
            "totalDamageDealtToChampions": True,
            "largestMultiKill": True,
            "gameEndedInSurrender": True,
        },
    },
}

VAL_DECODE_FIELDS = {
    "metadata": {
        "match_id": True,
        "map": {"id": True, "name": True},
        "game_length_in_ms": True,
        "started_at": True,
        "is_completed": True,
        "queue": {"id": True, "name": True, "mode_type": True},
    },
    "players": {
        "puuid": True,
        "name": True,
        "tag": True,
        "team_id": True,
        "agent": {"id": True, "name": True},
        "tier": {"id": True, "name": True},
        "stats": {
            "kills": True,
            "deaths": True,
            "assists": True,
            "score": True,
            "headshots": True,
            "bodyshots": True,
            "legshots": True,
        },
    },
    "teams": {
        "team_id": True,
        "won": True,
        "rounds": {"won": True, "lost": True},
    },
    "rounds": {"result": True},
}


def railway_token() -> str:
    for key in ("RAILWAY_API_TOKEN_PROD", "RAILWAY_TOKEN", "RAILWAY_API_TOKEN"):
        value = os.environ.get(key)
        if value:
            return value
    raise SystemExit(
        "missing railway token (RAILWAY_API_TOKEN_PROD, RAILWAY_TOKEN, or RAILWAY_API_TOKEN)"
    )


def prune(value: object, fields: object) -> object:
    if fields is True:
        return value
    if not isinstance(fields, dict):
        return value
    if isinstance(value, list):
        return [prune(item, fields) for item in value]
    if not isinstance(value, dict):
        return value
    return {
        key: prune(value[key], child)
        for key, child in fields.items()
        if key in value
    }


def railway_vars() -> dict[str, str]:
    payload = {
        "query": """
        query($projectId: String!, $environmentId: String!, $serviceId: String) {
          variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
        }
        """,
        "variables": {
            "projectId": PROJECT,
            "environmentId": ENV,
            "serviceId": SVC,
        },
    }
    req = urllib.request.Request(
        "https://backboard.railway.com/graphql/v2",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "project-access-token": railway_token(),
            "User-Agent": "curl/8",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as err:
        raise SystemExit(f"railway variables request failed status={err.code}") from None
    variables = (data.get("data") or {}).get("variables")
    if not isinstance(variables, dict):
        raise SystemExit("railway variables missing")
    return {str(k): str(v) for k, v in variables.items()}


def http_json(url: str, headers: dict[str, str], timeout: int = 30):
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as err:
        return err.code, None


def discord_messages(bot_token: str, channel_id: str) -> list[dict]:
    headers = {
        "Authorization": f"Bot {bot_token}",
        "User-Agent": "riot-tracker-bot-fixture-dump (https://github.com/syan-alt/riot-tracker-bot)",
    }
    messages: list[dict] = []
    before = None
    for _ in range(DISCORD_PAGES):
        qs = f"?limit=100" + (f"&before={before}" if before else "")
        status, body = http_json(
            f"https://discord.com/api/v10/channels/{channel_id}/messages{qs}",
            headers,
        )
        if status != 200 or not isinstance(body, list):
            print(f"discord messages status={status}", file=sys.stderr)
            break
        if not body:
            break
        messages.extend(body)
        before = body[-1]["id"]
        if len(body) < 100:
            break
        time.sleep(0.3)
    return messages


def extract_riot_ids(messages: list[dict]) -> tuple[list[str], list[str]]:
    tracked: OrderedDict[str, None] = OrderedDict()
    all_ids: OrderedDict[str, None] = OrderedDict()
    for message in messages:
        for embed in message.get("embeds") or []:
            text = "\n".join(
                str(part)
                for part in (embed.get("title"), embed.get("description"), embed.get("footer", {}).get("text"))
                if part
            )
            for name, tag in BOLD_RIOT.findall(text):
                riot_id = f"{name.strip()}#{tag.strip()}"
                tracked[riot_id] = None
                all_ids[riot_id] = None
            for name, tag in PLAIN_RIOT.findall(text):
                riot_id = f"{name.strip()}#{tag.strip()}"
                all_ids[riot_id] = None
    return list(tracked), list(all_ids)


def riot_get(cluster: str, path: str, api_key: str):
    return http_json(
        f"https://{cluster}.api.riotgames.com{path}",
        {"X-Riot-Token": api_key, "User-Agent": "riot-tracker-bot-fixture-dump"},
    )


def lol_matches_for(riot_id: str, api_key: str, want: int) -> list[dict]:
    name, _, tag = riot_id.partition("#")
    enc_name = urllib.parse.quote(name)
    enc_tag = urllib.parse.quote(tag)
    puuid = None
    account_cluster = RIOT_CLUSTERS[0]
    for cluster in RIOT_CLUSTERS:
        status, body = riot_get(
            cluster,
            f"/riot/account/v1/accounts/by-riot-id/{enc_name}/{enc_tag}",
            api_key,
        )
        time.sleep(0.15)
        if status == 200 and isinstance(body, dict) and body.get("puuid"):
            puuid = body["puuid"]
            account_cluster = cluster
            break
    if not puuid:
        return []

    match_ids: list[str] = []
    match_cluster = account_cluster
    for cluster in (account_cluster, *RIOT_CLUSTERS):
        status, body = riot_get(
            cluster,
            f"/lol/match/v5/matches/by-puuid/{urllib.parse.quote(puuid)}/ids?count={LOL_PER_ACCOUNT}",
            api_key,
        )
        time.sleep(0.15)
        if status == 200 and isinstance(body, list) and body:
            match_ids = [str(x) for x in body]
            match_cluster = cluster
            break
    matches = []
    for match_id in match_ids:
        if len(matches) >= want:
            break
        status, body = riot_get(
            match_cluster,
            f"/lol/match/v5/matches/{urllib.parse.quote(match_id)}",
            api_key,
        )
        time.sleep(0.2)
        if status == 200 and isinstance(body, dict) and "metadata" in body:
            matches.append(body)
    return matches


def henrik_get(path: str, api_key: str):
    return http_json(
        f"https://api.henrikdev.xyz{path}",
        {"Authorization": api_key, "User-Agent": "riot-tracker-bot-fixture-dump"},
    )


def val_matches_for(riot_id: str, api_key: str, want: int) -> list[dict]:
    name, _, tag = riot_id.partition("#")
    enc_name = urllib.parse.quote(name)
    enc_tag = urllib.parse.quote(tag)
    status, body = henrik_get(f"/valorant/v2/account/{enc_name}/{enc_tag}", api_key)
    time.sleep(0.2)
    if status != 200 or not isinstance(body, dict):
        return []
    data = body.get("data") or {}
    puuid = data.get("puuid")
    region = (data.get("region") or "na").lower()
    if not puuid:
        return []
    regions = [region, *[r for r in HENRIK_REGIONS if r != region]]
    for candidate in regions:
        status, body = henrik_get(
            f"/valorant/v4/by-puuid/matches/{candidate}/pc/{urllib.parse.quote(puuid)}?size={VAL_PER_ACCOUNT}",
            api_key,
        )
        time.sleep(0.3)
        if status != 200 or not isinstance(body, dict):
            continue
        rows = body.get("data") or []
        completed = [
            row
            for row in rows
            if isinstance(row, dict)
            and (row.get("metadata") or {}).get("is_completed")
        ]
        if completed:
            return completed[:want]
    return []


def main() -> None:
    out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    variables = railway_vars()
    needed = ["DISCORD_BOT_TOKEN", "NOTIFICATION_CHANNEL_ID", "RIOT_API_KEY", "HENRIK_API_KEY"]
    missing = [key for key in needed if not variables.get(key)]
    if missing:
        raise SystemExit(f"missing railway vars: {missing}")

    print(f"railway vars ok keys={len(variables)}")
    messages = discord_messages(variables["DISCORD_BOT_TOKEN"], variables["NOTIFICATION_CHANNEL_ID"])
    tracked, everyone = extract_riot_ids(messages)
    print(f"discord messages={len(messages)} tracked_riot_ids={len(tracked)} all_riot_ids={len(everyone)}")

    riot_ids = tracked + [riot_id for riot_id in everyone if riot_id not in tracked]
    lol_by_id: OrderedDict[str, dict] = OrderedDict()
    val_by_id: OrderedDict[str, dict] = OrderedDict()

    for riot_id in riot_ids:
        if len(lol_by_id) < TARGET_EACH:
            for match in lol_matches_for(riot_id, variables["RIOT_API_KEY"], LOL_PER_ACCOUNT):
                match_id = (match.get("metadata") or {}).get("matchId")
                if match_id and match_id not in lol_by_id:
                    lol_by_id[match_id] = match
                if len(lol_by_id) >= TARGET_EACH:
                    break
        if len(val_by_id) < TARGET_EACH:
            for match in val_matches_for(riot_id, variables["HENRIK_API_KEY"], VAL_PER_ACCOUNT):
                match_id = (match.get("metadata") or {}).get("match_id")
                if match_id and match_id not in val_by_id:
                    val_by_id[match_id] = match
                if len(val_by_id) >= TARGET_EACH:
                    break
        print(f"progress lol={len(lol_by_id)} val={len(val_by_id)}")
        if len(lol_by_id) >= TARGET_EACH and len(val_by_id) >= TARGET_EACH:
            break

    matches = [
        {"game": "lol", "raw": prune(match, LOL_DECODE_FIELDS)} for match in lol_by_id.values()
    ]
    matches += [
        {"game": "valorant", "raw": prune(match, VAL_DECODE_FIELDS)} for match in val_by_id.values()
    ]
    payload = {
        "source": "railway-production",
        "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "counts": {"lol": len(lol_by_id), "valorant": len(val_by_id), "total": len(matches)},
        "matches": matches,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w") as handle:
        json.dump(payload, handle)
    print(f"wrote bytes={out_path.stat().st_size} lol={len(lol_by_id)} val={len(val_by_id)}")


if __name__ == "__main__":
    main()
