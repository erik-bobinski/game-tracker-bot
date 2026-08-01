import { Effect } from "effect";
import { HenrikApiClient } from "../game-api/val/henrik-api-client.ts";
import { GameApiError, RECENT_MATCH_COUNT, type GameAdapter } from "./index.ts";
import {
  EpochMillis,
  type MatchDetails,
  type MatchPlayer,
  type MatchTeam,
  type Puuid,
} from "../index.ts";
import { valMatchMode } from "../game-api/val/match-schema.ts";

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
      function* (puuid: Puuid) {
        const matches = yield* henrikClient.getRecentMatches(
          puuid,
          RECENT_MATCH_COUNT,
        );
        const candidates: Array<MatchDetails> = [];
        for (const match of matches) {
          if (!match.metadata.is_completed) continue;

          const rounds = Math.max(match.rounds.length, 1);
          const players: Array<MatchPlayer> = match.players.map((player) => {
            const shots =
              player.stats.headshots +
              player.stats.bodyshots +
              player.stats.legshots;
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
              thumbnailUrl: `https://media.valorant-api.com/agents/${encodeURIComponent(player.agent.id)}/displayicon.png`,
            };
          });

          const teams: Array<MatchTeam> = match.teams.map((team) => ({
            id: team.team_id.toLowerCase(),
            won: team.won,
            score: [team.rounds.won, team.rounds.lost],
          }));

          candidates.push({
            matchId: match.metadata.match_id,
            game: "valorant",
            date: EpochMillis.make(Date.parse(match.metadata.started_at)),
            mode: valMatchMode(match.metadata),
            map: match.metadata.map.name,
            durationSeconds: Math.floor(
              match.metadata.game_length_in_ms / 1_000,
            ),
            surrendered: match.rounds.some(
              (round) => round.result.toLowerCase() === "surrendered",
            ),
            players,
            teams,
          });
        }
        return candidates;
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
    enrichMatch: Effect.fn("GameAdapter.valorant.enrichMatch")(
      (match: MatchDetails) => Effect.succeed(match),
    ),
  };

  return adapter;
});
