import { Effect } from "effect";
import { HenrikApiClient } from "../game-api/val/henrik-api-client.ts";
import {
  GameApiError,
  RECENT_MATCH_COUNT,
  emptyEnrichment,
  logApiWarning,
  type GameAdapter,
} from "./index.ts";
import {
  EpochMillis,
  type MatchDetails,
  type MatchTeam,
  type Puuid,
  type RankInfo,
  type Region,
  type VersusPlayer,
} from "../index.ts";
import {
  valMatchMode,
  type ValRawMatch,
} from "../game-api/val/match-schema.ts";

const rankIconKey = (rank: string) => {
  const key = rank.toLowerCase().replaceAll(" ", "_");
  return key && key !== "unrated" ? key : undefined;
};

const valorantTierSet = "03621f52-342b-cf4e-4f86-9350a49c6d04";
const rankIcons = [
  ["iron", 3],
  ["bronze", 6],
  ["silver", 9],
  ["gold", 12],
  ["platinum", 15],
  ["diamond", 18],
  ["ascendant", 21],
  ["immortal", 24],
]
  .flatMap(([tier, firstLevel]) =>
    [1, 2, 3].map((division, offset) => ({
      key: `${tier}_${division}`,
      url: `https://media.valorant-api.com/competitivetiers/${valorantTierSet}/${Number(firstLevel) + offset}/smallicon.png`,
    })),
  )
  .concat({
    key: "radiant",
    url: `https://media.valorant-api.com/competitivetiers/${valorantTierSet}/27/smallicon.png`,
  });

export const valMatchToDetails = (
  match: ValRawMatch,
  performanceScores?: ReadonlyMap<Puuid, number>,
): MatchDetails => {
  const base = {
    matchId: match.metadata.match_id,
    game: "valorant",
    date: EpochMillis.make(Date.parse(match.metadata.started_at)),
    mode: valMatchMode(match.metadata),
    map: match.metadata.map.name,
    durationSeconds: Math.floor(match.metadata.game_length_in_ms / 1_000),
  } as const;
  const identity = (player: ValRawMatch["players"][number]) => {
    const iconKey = rankIconKey(player.tier.name);
    return {
      puuid: player.puuid,
      riotName: player.name,
      riotTag: player.tag,
      ...(player.tier.name && player.tier.name !== "Unrated"
        ? { rank: player.tier.name }
        : {}),
      ...(iconKey ? { rankIconKey: iconKey } : {}),
    };
  };

  const freeForAll = match.players.every(
    (player) => player.team_id === player.puuid,
  );
  if (freeForAll) {
    const winners = new Set(
      match.teams.filter((team) => team.won).map((team) => team.team_id),
    );
    return {
      ...base,
      kind: "placement",
      players: [...match.players]
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

  // Henrik reports team deathmatch as a single round
  const roundBased = match.rounds.length > 1;
  const players: Array<VersusPlayer> = match.players.map((player) => {
    const shots =
      player.stats.headshots + player.stats.bodyshots + player.stats.legshots;
    const score = performanceScores?.get(player.puuid);
    const impact = !roundBased
      ? undefined
      : score === undefined
        ? {
            value: Math.floor(player.stats.score / match.rounds.length),
            unit: "ACS",
          }
        : { value: score, unit: "PS" };
    return {
      ...identity(player),
      team: player.team_id.toLowerCase(),
      character: player.agent.name,
      characterIconUrl: `https://media.valorant-api.com/agents/${player.agent.id}/displayicon.png`,
      kills: player.stats.kills,
      deaths: player.stats.deaths,
      assists: player.stats.assists,
      stat: [
        impact && `${impact.value} ${impact.unit}`,
        shots > 0
          ? `${Math.floor((player.stats.headshots * 100) / shots)}% HS`
          : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(" · "),
      sortKey: impact?.value ?? player.stats.kills,
    };
  });

  const teams: Array<MatchTeam> = match.teams.map((team) => ({
    id: team.team_id.toLowerCase(),
    ...(team.rounds.won !== team.rounds.lost ? { won: team.won } : {}),
    score: [team.rounds.won, team.rounds.lost],
  }));

  return {
    ...base,
    kind: "versus",
    surrendered: match.rounds.some(
      (round) => round.result.toLowerCase() === "surrendered",
    ),
    players: players.sort((a, b) => b.sortKey - a.sortKey),
    teams,
  };
};

export const makeValorantGameAdapter = Effect.gen(function* () {
  const henrikClient = yield* HenrikApiClient;
  // henrik's single match endpoint, asked right after a match ends, can return
  // names blank that the polled match history already has, so reports are
  // scored from the polled record
  const polledHistories = new Map<Puuid, ReadonlyArray<ValRawMatch>>();

  const adapter: GameAdapter = {
    game: "valorant",
    requiresMatchHistory: false,
    iconUrl: new URL("../../../../assets/logo-valorant.png", import.meta.url)
      .href,
    rankIcons,
    resolveAccount: Effect.fn("GameAdapter.valorant.resolveAccount")(function* (
      name: string,
      tag: string,
    ) {
      return yield* henrikClient.getAccountByRiotId(name, tag);
    }),
    getRecentMatches: Effect.fn("GameAdapter.valorant.getRecentMatches")(
      function* (puuid: Puuid, region: Region | undefined) {
        const matches = yield* henrikClient.getRecentMatches(
          puuid,
          region,
          RECENT_MATCH_COUNT,
        );
        polledHistories.set(puuid, matches);
        return matches
          .filter((match) => match.metadata.is_completed)
          .map((match) => valMatchToDetails(match));
      },
      Effect.mapError(
        (cause) =>
          new GameApiError({
            game: "valorant",
            operation: "getRecentMatches",
            cause,
          }),
      ),
    ),
    enrichMatch: Effect.fn("GameAdapter.valorant.enrichMatch")(function* ({
      match,
      trackedPlayers,
    }) {
      if (match.kind !== "versus") return emptyEnrichment(match);
      const region = trackedPlayers[0]?.region;
      const polled = trackedPlayers
        .flatMap(({ puuid }) => polledHistories.get(puuid) ?? [])
        .find(
          (raw) =>
            raw.metadata.is_completed &&
            raw.metadata.match_id === match.matchId,
        );
      const scored =
        polled === undefined
          ? match
          : yield* henrikClient
              .getPerformanceScores(match.matchId, region)
              .pipe(
                Effect.map((scores) => valMatchToDetails(polled, scores)),
                Effect.catch((error) =>
                  logApiWarning(
                    "valorant performance scores unavailable",
                    error,
                  ).pipe(
                    Effect.annotateLogs({ matchId: match.matchId }),
                    Effect.as(match),
                  ),
                ),
              );
      const enrichment = emptyEnrichment(scored);
      if (scored.mode !== "Competitive") return enrichment;

      yield* Effect.forEach(
        trackedPlayers,
        ({ puuid, region }) =>
          henrikClient.getMmrHistory(puuid, region).pipe(
            Effect.map((history) => {
              const entry = history.find(
                (candidate) =>
                  candidate.matchId.toLowerCase() ===
                  match.matchId.toLowerCase(),
              );
              if (entry)
                enrichment.rankUpdates.set(puuid, {
                  delta: entry.delta,
                  current: entry.current,
                  unit: "RR",
                });
            }),
            Effect.catch((error) =>
              logApiWarning("valorant RR unavailable", error).pipe(
                Effect.annotateLogs({ puuid, matchId: match.matchId }),
              ),
            ),
          ),
        { concurrency: 3 },
      );

      return enrichment;
    }),
    getRank: Effect.fn("GameAdapter.valorant.getRank")(
      function* (puuid: Puuid, region: Region | undefined) {
        const rank = yield* henrikClient.getRank(puuid, region);
        if (!rank || rank.tier === "Unrated") return undefined;

        const iconKey = rankIconKey(rank.tier);
        const record =
          rank.wins !== undefined && rank.losses !== undefined
            ? ` · ${rank.wins}W ${rank.losses}L`
            : "";
        return {
          tier: rank.tier,
          detail: `${rank.rr} RR${record}`,
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
