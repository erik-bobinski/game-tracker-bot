import { Effect } from "effect";
import { RiotApiClient } from "../game-api/lol/riot-api-client.js";
import type { GameAdapter } from "./index.js";
import type { Puuid } from "../index.js";

// TODO: implement getRecentMatches via RiotApi (Match-V5).
export const makeLolGameAdapter = Effect.gen(function* () {
  const riotClient = yield* RiotApiClient;

  const adapter: GameAdapter = {
    game: "lol",
    resolveAccount: riotClient.getAccountByRiotId,
    getRecentMatches: Effect.fn("GameAdapter.lol.getRecentMatches")(
      function* (puuid: Puuid) {
        return yield* Effect.die(
          "makeLolGameAdapter.getRecentMatches not implemented",
        );
      },
    ),
  };

  return adapter;
});
