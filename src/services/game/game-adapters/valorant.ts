import { Effect } from "effect";
import { HenrikApiClient } from "../game-api/val/henrik-api-client.js";
import type { GameAdapter } from "./index.js";

// TODO: implement getRecentMatches via HenrikApiClient.
export const makeValorantGameAdapter = Effect.gen(function* () {
  const henrikClient = yield* HenrikApiClient;

  const adapter: GameAdapter = {
    game: "valorant",
    resolveAccount: henrikClient.getAccountByRiotId,
    getRecentMatches: () =>
      Effect.die("makeValorantGameAdapter.getRecentMatches not implemented"),
  };

  return adapter;
});
