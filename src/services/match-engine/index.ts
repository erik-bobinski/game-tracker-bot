import { Context, Effect, Layer } from "effect";
import { Database } from "../database/index.ts";
import {
  GameAdapters,
  type MatchCandidate,
} from "../game/game-adapters/index.ts";
import { GameId, MatchId } from "../game/index.ts";

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
    const accounts = yield* database.getAccounts(); // retrieve fresh accts from DB per-poll

    // unreported matches, grouped by game, grouped by matchId
    const matchesToReport = new Map<GameId, Map<MatchId, MatchCandidate>>();
    for (const adapter of gameAdapters.all) {
      const matchesPerGame = new Map<MatchId, MatchCandidate>();
      for (const account of accounts) {
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
        const unreportedMatches = recentMatches.filter(
          (m) => !storedMatchIds.has(m.matchId) && m.date > latestStoredDate,
        );
        for (const m of unreportedMatches) matchesPerGame.set(m.matchId, m);
      }
      matchesToReport.set(adapter.game, matchesPerGame);
    }

    // TODO: Send notifications through Discord.
    // TODO: Mark matches as reported only after successful delivery.
  });

  return MatchEngine.of({ pollOnce: () => pollOnce });
});

export const MatchEngineLive = Layer.effect(MatchEngine, makeMatchEngine);
