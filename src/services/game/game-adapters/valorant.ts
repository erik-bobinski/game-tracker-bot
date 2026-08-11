import { Effect } from "effect";
import { HenrikApiClient } from "../game-api/val/henrik-api-client.ts";
import {
  GameApiError,
  RECENT_MATCH_COUNT,
  emptyEnrichment,
  type GameAdapter,
} from "./index.ts";
import {
  EpochMillis,
  type MatchDetails,
  type MatchPlayer,
  type MatchTeam,
  type Puuid,
  type RankInfo,
  type Region,
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

export const valMatchToDetails = (match: ValRawMatch): MatchDetails => {
  const rounds = Math.max(match.rounds.length, 1);
  const players: Array<MatchPlayer> = match.players.map((player) => {
    const shots =
      player.stats.headshots + player.stats.bodyshots + player.stats.legshots;
    const acs = Math.floor(player.stats.score / rounds);
    const iconKey = rankIconKey(player.tier.name);
    return {
      puuid: player.puuid,
      team: player.team_id.toLowerCase(),
      riotName: player.name,
      riotTag: player.tag,
      character: player.agent.name,
      kills: player.stats.kills,
      deaths: player.stats.deaths,
      assists: player.stats.assists,
      stat:
        shots > 0
          ? `${acs} ACS · ${Math.floor((player.stats.headshots * 100) / shots)}% HS`
          : `${acs} ACS`,
      sortKey: acs,
      ...(player.tier.name && player.tier.name !== "Unrated"
        ? { rank: player.tier.name }
        : {}),
      ...(iconKey ? { rankIconKey: iconKey } : {}),
    };
  });

  const teams: Array<MatchTeam> = match.teams.map((team) => ({
    id: team.team_id.toLowerCase(),
    won: team.won,
    score: [team.rounds.won, team.rounds.lost],
  }));

  return {
    matchId: match.metadata.match_id,
    game: "valorant",
    date: EpochMillis.make(Date.parse(match.metadata.started_at)),
    mode: valMatchMode(match.metadata),
    map: match.metadata.map.name,
    durationSeconds: Math.floor(match.metadata.game_length_in_ms / 1_000),
    surrendered: match.rounds.some(
      (round) => round.result.toLowerCase() === "surrendered",
    ),
    players,
    teams,
  };
};

export const makeValorantGameAdapter = Effect.gen(function* () {
  const henrikClient = yield* HenrikApiClient;

  const adapter: GameAdapter = {
    game: "valorant",
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
        return matches
          .filter((match) => match.metadata.is_completed)
          .map(valMatchToDetails);
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
      const enrichment = emptyEnrichment(match);
      if (match.mode !== "Competitive") return enrichment;

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
              Effect.logWarning("valorant RR unavailable", error).pipe(
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
