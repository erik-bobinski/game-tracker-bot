import { Context, Effect, Layer } from "effect";
import { Database } from "../database/index.js";
import {
  GameAdapters,
  type MatchCandidate,
} from "../game/game-adapters/index.js";

export class MatchEngine extends Context.Service<
  MatchEngine,
  {
    readonly pollOnce: () => Effect.Effect<void, unknown>;
  }
>()("app/MatchEngine") {}

const makeMatchEngine = Effect.gen(function* () {
  const database = yield* Database;
  const gameAdapters = yield* GameAdapters;

  const pollOnce = Effect.gen(function* () {
    const accounts = yield* database.getAccounts();

    for (const account of accounts) {
      for (const adapter of gameAdapters.all) {
        const gameState = account.games[adapter.game];
        if (!gameState) continue;

        const storedMatchIds = new Set(
          gameState.reportedMatches.map((m) => m.matchId),
        );
        const latestStoredDate = gameState.reportedMatches.reduce(
          (max, m) => (m.date > max ? m.date : max),
          0,
        );

        const recentMatches = yield* adapter.getRecentMatches(gameState.puuid);
        const matchesToReport = recentMatches.filter(
          (rm) => !storedMatchIds.has(rm.matchId) && rm.date > latestStoredDate,
        );

        // TODO: Send notifications through Discord.
        // TODO: Mark matches as reported only after successful delivery.
      }
    }
  });

  return MatchEngine.of({ pollOnce: () => pollOnce });
});

export const MatchEngineLive = Layer.effect(MatchEngine, makeMatchEngine);
