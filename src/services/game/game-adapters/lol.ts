import { Effect } from "effect";
import { RiotApiClient } from "../game-api/lol/riot-api-client.ts";
import { GameApiError, RECENT_MATCH_COUNT, type GameAdapter } from "./index.ts";
import type { MatchCandidate, Puuid } from "../index.ts";

export const makeLolGameAdapter = Effect.gen(function* () {
  const riotClient = yield* RiotApiClient;

  const adapter: GameAdapter = {
    game: "lol",
    resolveAccount: Effect.fn("GameAdapter.lol.resolveAccount")(function* (
      name: string,
      tag: string,
    ) {
      return yield* riotClient.getAccountByRiotId(name, tag);
    }),
    getRecentMatches: Effect.fn("GameAdapter.lol.getRecentMatches")(
      function* (puuid: Puuid) {
        const matches = yield* riotClient.getRecentMatches(
          puuid,
          RECENT_MATCH_COUNT,
        );
        return matches.map(
          (match): MatchCandidate => ({
            matchId: match.metadata.matchId,
            game: "lol",
            date: match.info.gameStartTimestamp,
          }),
        );
      },
      Effect.mapError(
        (cause) =>
          new GameApiError({
            game: "lol",
            operation: "getRecentMatches",
            cause,
          }),
      ),
    ),
  };

  return adapter;
});
