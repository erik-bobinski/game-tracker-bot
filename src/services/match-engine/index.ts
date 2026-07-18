import { Context, Effect, Layer } from "effect";
import { Database } from "../database/index.js";
import { GameAdapters } from "../game/game-adapters/index.js";

export class MatchEngine extends Context.Service<
  MatchEngine,
  {
    // Performs one polling cycle
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

        // gameState.reportedMatchIds is the ring buffer for this game.
        // TODO: Ask the adapter for recent matches.
        // TODO: Compare candidates with reportedMatchIds.
        // TODO: Send notifications through Discord.
        // TODO: Mark matches as reported only after successful delivery.
        yield* Effect.logDebug(
          `Polling ${account.discordUserId} for ${adapter.game} ` +
            `(${gameState.reportedMatchIds.length} reported)`,
        );
      }
    }
  });

  return MatchEngine.of({ pollOnce: () => pollOnce });
});

export const MatchEngineLive = Layer.effect(MatchEngine, makeMatchEngine);
