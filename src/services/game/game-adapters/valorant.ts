import { Effect } from "effect";
import { RiotValApiClient } from "../game-api/val/riot-val-client.ts";
import type {
  ValContent,
  ValMatch,
} from "../game-api/val/riot-match-schema.ts";
import {
  GameApiError,
  RECENT_MATCH_COUNT,
  emptyEnrichment,
  type GameAdapter,
} from "./index.ts";
import type {
  MatchDetails,
  MatchId,
  MatchPlayerIdentity,
  MatchTeam,
  Puuid,
  RankInfo,
  RankSnapshots,
  RankUpdate,
  Region,
  VersusPlayer,
} from "../index.ts";

// A match ranks each player by competitiveTier: iron 1 is 3, every tier has
// three divisions, and radiant is 27.
const tierNames = new Map<number, string>([
  ...(
    [
      ["Iron", 3],
      ["Bronze", 6],
      ["Silver", 9],
      ["Gold", 12],
      ["Platinum", 15],
      ["Diamond", 18],
      ["Ascendant", 21],
      ["Immortal", 24],
    ] as const
  ).flatMap(([tier, first]) =>
    [1, 2, 3].map(
      (division) => [first + division - 1, `${tier} ${division}`] as const,
    ),
  ),
  [27, "Radiant"] as const,
]);

// "Gold 2" -> "gold_2", the key of its icon
export const valorantRankIconKey = (rank: string) => {
  const key = rank.toLowerCase().replaceAll(" ", "_");
  return key && key !== "unrated" ? key : undefined;
};

const tierSet = "03621f52-342b-cf4e-4f86-9350a49c6d04";
export const valorantRankIcons = [...tierNames].map(([tier, name]) => ({
  key: name.toLowerCase().replaceAll(" ", "_"),
  url: `https://media.valorant-api.com/competitivetiers/${tierSet}/${tier}/smallicon.png`,
}));

export const valorantIconUrl = new URL(
  "../../../../assets/logo-valorant.png",
  import.meta.url,
).href;

const queueNames: Record<string, string> = {
  competitive: "Competitive",
  unrated: "Unrated",
  swiftplay: "Swiftplay",
  spikerush: "Spike Rush",
  deathmatch: "Deathmatch",
  hurm: "Team Deathmatch",
  ggteam: "Escalation",
  onefa: "Replication",
  premier: "Premier",
  snowball: "Snowball Fight",
  newmap: "New Map",
  "": "Custom Game",
};

const COMPETITIVE = "competitive";

export const riotValMatchToDetails = (
  match: ValMatch,
  content: ValContent,
): MatchDetails => {
  const { matchInfo } = match;
  // observers and coaches sit in the player list without stats
  const players = match.players.flatMap(({ stats, ...player }) =>
    stats && !player.isObserver ? [{ ...player, stats }] : [],
  );
  const rounds = match.roundResults ?? [];
  const agents = new Map(
    content.characters.map((agent) => [agent.id.toLowerCase(), agent.name]),
  );
  // the asset path's last part is an internal codename ("Triad" for Haven),
  // only better than nothing
  const map =
    content.maps.find((candidate) => candidate.assetPath === matchInfo.mapId)
      ?.name ?? matchInfo.mapId.split("/").at(-1);
  const base = {
    matchId: matchInfo.matchId,
    game: "valorant",
    date: matchInfo.gameStartMillis,
    mode:
      queueNames[matchInfo.queueId] ??
      matchInfo.queueId.charAt(0).toUpperCase() + matchInfo.queueId.slice(1),
    ...(map ? { map } : {}),
    durationSeconds: Math.floor((matchInfo.gameLengthMillis ?? 0) / 1_000),
  } as const;
  const identity = (player: (typeof players)[number]) => {
    const rank = tierNames.get(player.competitiveTier);
    const rankIconKey = rank && valorantRankIconKey(rank);
    return {
      puuid: player.puuid,
      riotName: player.gameName,
      riotTag: player.tagLine,
      ...(rank ? { rank } : {}),
      ...(rankIconKey ? { rankIconKey } : {}),
    };
  };

  const freeForAll = players.every((player) => player.teamId === player.puuid);
  if (freeForAll) {
    const winners = new Set(
      (match.teams ?? []).filter((team) => team.won).map((team) => team.teamId),
    );
    return {
      ...base,
      kind: "placement",
      players: [...players]
        .sort(
          (a, b) =>
            Number(winners.has(b.puuid)) - Number(winners.has(a.puuid)) ||
            b.stats.kills - a.stats.kills ||
            b.stats.score - a.stats.score,
        )
        .map((player, index) => ({
          ...identity(player),
          placement: index + 1,
          won: winners.has(player.puuid),
          stat: `${player.stats.kills} / ${player.stats.deaths} / ${player.stats.assists}`,
        })),
    };
  }

  // shots a player landed, from every round's damage events
  const shots = new Map<Puuid, { head: number; all: number }>();
  for (const round of rounds) {
    for (const { puuid, damage } of round.playerStats) {
      const tally = shots.get(puuid) ?? { head: 0, all: 0 };
      for (const hit of damage) {
        tally.head += hit.headshots;
        tally.all += hit.headshots + hit.bodyshots + hit.legshots;
      }
      shots.set(puuid, tally);
    }
  }

  // team deathmatch is played as a single round
  const roundBased = rounds.length > 1;
  const versusPlayers: Array<VersusPlayer> = players.map((player) => {
    const acs = roundBased
      ? Math.floor(player.stats.score / rounds.length)
      : undefined;
    const tally = shots.get(player.puuid);
    const agentId = player.characterId?.toLowerCase();
    return {
      ...identity(player),
      team: player.teamId.toLowerCase(),
      character: (agentId && agents.get(agentId)) ?? "Unknown agent",
      ...(agentId
        ? {
            characterIconUrl: `https://media.valorant-api.com/agents/${agentId}/displayicon.png`,
          }
        : {}),
      kills: player.stats.kills,
      deaths: player.stats.deaths,
      assists: player.stats.assists,
      stat: [
        acs === undefined ? undefined : `${acs} ACS`,
        tally && tally.all > 0
          ? `${Math.floor((tally.head * 100) / tally.all)}% HS`
          : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(" · "),
      sortKey: acs ?? player.stats.kills,
    };
  });

  const teams: Array<MatchTeam> = (match.teams ?? []).map((team) => {
    const lost = team.roundsPlayed - team.roundsWon;
    return {
      id: team.teamId.toLowerCase(),
      ...(team.roundsWon !== lost ? { won: team.won } : {}),
      score: [team.roundsWon, lost],
    };
  });

  return {
    ...base,
    kind: "versus",
    surrendered: rounds.some(
      (round) =>
        round.roundResultCode === "Surrendered" ||
        round.roundResult === "Surrendered",
    ),
    players: versusPlayers,
    teams,
  };
};

// Riot doesn't let a VALORANT player's data reach other players unless they
// opted in, so everyone in the match who isn't tracked is shown by their agent
// alone, without name or rank.
const anonymous = <P extends MatchPlayerIdentity>({
  rank,
  rankIconKey,
  rankDivision,
  ...player
}: P) => ({ ...player, riotName: "", riotTag: "" });

const onlyOptedInNamed = (
  match: MatchDetails,
  trackedPlayers: ReadonlyArray<{ readonly puuid: Puuid }>,
): MatchDetails => {
  const optedIn = new Set(trackedPlayers.map((player) => player.puuid));
  switch (match.kind) {
    case "versus":
      return {
        ...match,
        players: match.players.map((player) =>
          optedIn.has(player.puuid) ? player : anonymous(player),
        ),
      };
    case "placement":
      return {
        ...match,
        players: match.players.map((player) =>
          optedIn.has(player.puuid) ? player : anonymous(player),
        ),
      };
  }
};

export const makeValorantGameAdapter = Effect.gen(function* () {
  const client = yield* RiotValApiClient;
  // an account's shard comes from riot at signup, so this only covers rows
  // stored without one
  const shardOf = (region: Region | undefined) => region ?? "na";

  const adapter: GameAdapter = {
    game: "valorant",
    requiresMatchHistory: false,
    // riot only lets a VALORANT player's data be shown once they sign in with
    // riot to opt in, so signing up by riot id alone doesn't track it
    requiresOptIn: true,
    iconUrl: valorantIconUrl,
    rankIcons: valorantRankIcons,
    resolveAccount: Effect.fn("GameAdapter.valorant.resolveAccount")(function* (
      name: string,
      tag: string,
    ) {
      const puuid = yield* client.getAccountByRiotId(name, tag);
      return { puuid, region: yield* client.getActiveShard(puuid) };
    }),
    getRecentMatchIds: Effect.fn("GameAdapter.valorant.getRecentMatchIds")(
      function* (puuid: Puuid, region: Region | undefined) {
        const history = yield* client.getMatchlist(puuid, shardOf(region));
        return history
          .slice(0, RECENT_MATCH_COUNT)
          .map((entry) => entry.matchId);
      },
      Effect.mapError(
        (cause) =>
          new GameApiError({
            game: "valorant",
            operation: "getRecentMatchIds",
            cause,
          }),
      ),
    ),
    getMatch: Effect.fn("GameAdapter.valorant.getMatch")(
      function* (matchId: MatchId, region: Region | undefined) {
        const match = yield* client.getMatch(matchId, shardOf(region));
        if (!match) return undefined;
        // fails rather than skips, so the next poll picks it up when it's done
        if (!match.matchInfo.isCompleted) {
          return yield* Effect.fail(new Error("match still in progress"));
        }
        return riotValMatchToDetails(match, yield* client.getContent());
      },
      Effect.mapError(
        (cause) =>
          new GameApiError({ game: "valorant", operation: "getMatch", cause }),
      ),
    ),
    // There's no RR in riot's api, only the tier a match was played at, so a
    // competitive match reports how many tiers that moved since the last one.
    enrichMatch: Effect.fn("GameAdapter.valorant.enrichMatch")(function* ({
      match,
      trackedPlayers,
    }) {
      const enrichment = emptyEnrichment(
        onlyOptedInNamed(match, trackedPlayers),
      );
      if (match.mode !== queueNames[COMPETITIVE]) return enrichment;
      const levels = new Map(
        [...tierNames].map(([tier, name]) => [name, tier] as const),
      );
      for (const tracked of trackedPlayers) {
        const rank = match.players.find(
          (player) => player.puuid === tracked.puuid,
        )?.rank;
        const tier = rank === undefined ? undefined : levels.get(rank);
        if (rank === undefined || tier === undefined) continue;
        const previous = tracked.previousRankSnapshots[COMPETITIVE];
        if (previous && previous.points !== tier) {
          enrichment.rankUpdates.set(tracked.puuid, {
            delta: tier - previous.points,
            current: rank,
            unit: "tier",
          } satisfies RankUpdate);
        }
        enrichment.updatedRankSnapshots.set(tracked.puuid, {
          ...tracked.previousRankSnapshots,
          [COMPETITIVE]: { standing: rank, points: tier },
        } satisfies RankSnapshots);
      }
      return enrichment;
    }),
    // the tier of their newest competitive match, the only rank riot shares
    getRank: Effect.fn("GameAdapter.valorant.getRank")(
      function* (puuid: Puuid, region: Region | undefined) {
        const history = yield* client.getMatchlist(puuid, shardOf(region));
        const latest = history.find((entry) => entry.queueId === COMPETITIVE);
        if (!latest) return undefined;
        const match = yield* client.getMatch(latest.matchId, shardOf(region));
        const tier = match?.players.find(
          (player) => player.puuid === puuid,
        )?.competitiveTier;
        const rank = tier === undefined ? undefined : tierNames.get(tier);
        if (!rank) return undefined;
        const iconKey = valorantRankIconKey(rank);
        return {
          tier: rank,
          detail: `as of <t:${Math.floor(latest.gameStartTimeMillis / 1000)}:R>`,
          ...(iconKey ? { iconKey } : {}),
        } satisfies RankInfo;
      },
      Effect.mapError(
        (cause) =>
          new GameApiError({ game: "valorant", operation: "getRank", cause }),
      ),
    ),
  };

  return adapter;
});
