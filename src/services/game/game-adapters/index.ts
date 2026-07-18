// Base game adapter service and contract to fulfill on game's impl
import { Context, Effect, Layer, type Schema } from "effect";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type { GameId, Puuid } from "../index.js";
import { makeLolGameAdapter } from "./lol.js";
import { makeValorantGameAdapter } from "./valorant.js";

export interface MatchCandidate {
  readonly matchId: string;
  readonly game: GameId;
  readonly date: string; // TODO: need better type for this prob
}

export interface GameAdapter {
  readonly game: GameId;

  readonly resolveAccount: (
    // discord id will come from the discord /signup command
    name: string,
    tag: string,
  ) => Effect.Effect<
    Puuid,
    HttpClientError.HttpClientError | Schema.SchemaError
  >;

  readonly getRecentMatches: (
    puuid: Puuid,
  ) => Effect.Effect<ReadonlyArray<MatchCandidate>>;
}

export class GameAdapters extends Context.Service<
  GameAdapters,
  {
    readonly all: ReadonlyArray<GameAdapter>;
  }
>()("app/GameAdapters") {}

export const GameAdaptersLive = Layer.effect(
  GameAdapters,
  Effect.gen(function* () {
    const all: ReadonlyArray<GameAdapter> = [
      yield* makeLolGameAdapter,
      yield* makeValorantGameAdapter,
    ];

    return GameAdapters.of({ all });
  }),
);
