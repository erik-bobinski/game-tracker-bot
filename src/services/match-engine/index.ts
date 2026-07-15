import { Context, Effect, Layer } from "effect";
import { Database } from "../database/index.js";
import { GameAdapters } from "../game-adapters/index.js";

export class MatchEngine extends Context.Service<
  MatchEngine,
  {
    /** Performs one finite polling cycle. */
    readonly pollOnce: () => Effect.Effect<void, unknown>;
  }
>()("app/MatchEngine") {}

const makeMatchEngine = Effect.gen(function* () {
  const database = yield* Database;
  const gameAdapters = yield* GameAdapters;

  const pollOnce = Effect.gen(function* () {
    // TODO: Load tracked accounts.
    const accounts = yield* database.getAccounts();

    for (const account of accounts) {
      // TODO: Select the games associated with this account.
      // TODO: Ask the relevant adapters for recent matches.
      // TODO: Compare candidates with persisted match state.
      // TODO: Send notifications through Discord.
      // TODO: Mark matches as reported only after successful delivery.
      yield* Effect.logDebug(
        `Polling account ${account.discordUserId} with ${gameAdapters.all.length} adapters`,
      );
    }
  });

  return MatchEngine.of({ pollOnce: () => pollOnce });
});

/** The engine still requires Database and GameAdapters to be provided. */
export const MatchEngineLive = Layer.effect(MatchEngine, makeMatchEngine);
