import { Context, Effect, Layer } from "effect";
import type { GameAdapter, GameId } from "./contract.js";

export class GameAdapters extends Context.Service<
  GameAdapters,
  {
    readonly all: ReadonlyArray<GameAdapter>;
    readonly get: (game: GameId) => Effect.Effect<GameAdapter, Error>;
  }
>()("app/GameAdapters") {}

// TODO: Replace this placeholder with the LoL and Valorant adapter registry.
export const GameAdaptersLive = Layer.succeed(
  GameAdapters,
  GameAdapters.of({
    all: [],
    get: (game) => Effect.fail(new Error(`Game adapter not registered: ${game}`)),
  }),
);
