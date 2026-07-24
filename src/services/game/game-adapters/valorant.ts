import { Effect } from "effect";
import { HenrikApiClient } from "../game-api/val/henrik-api-client.ts";
import { GameApiError, RECENT_MATCH_COUNT, type GameAdapter } from "./index.ts";
import { EpochMillis, type MatchCandidate, type Puuid } from "../index.ts";

export const makeValorantGameAdapter = Effect.gen(function* () {
  const henrikClient = yield* HenrikApiClient;

  const adapter: GameAdapter = {
    game: "valorant",
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
        const candidates: Array<MatchCandidate> = [];
        for (const match of matches) {
          if (!match.is_available || match.metadata === null) continue;
          candidates.push({
            matchId: match.metadata.matchid,
            game: "valorant",
            date: EpochMillis.make(match.metadata.game_start * 1000),
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
  };

  return adapter;
});
