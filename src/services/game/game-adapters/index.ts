// Base game adapter service and contract to fulfill on game's impl
import { Context, Effect, Layer, Schema } from "effect";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import {
  GameId,
  type MatchDetails,
  type Puuid,
  type RankInfo,
  type Region,
  type ResolvedAccount,
} from "../index.ts";
import { makeLolGameAdapter } from "./lol.ts";
import { makeValorantGameAdapter } from "./valorant.ts";

// Cap per-poll fetches; we poll every minute so 3 is plenty.
export const RECENT_MATCH_COUNT = 3;

export class GameApiError extends Schema.TaggedError<GameApiError>()(
  "GameApiError",
  { game: GameId, operation: Schema.String, cause: Schema.Defect() },
) {}

export interface GameAdapter {
  readonly game: GameId;
  readonly rankIcons: ReadonlyArray<RankIcon>;

  readonly resolveAccount: (
    // discord id will come from the discord /signup command
    name: string,
    tag: string,
  ) => Effect.Effect<
    ResolvedAccount,
    HttpClientError.HttpClientError | Schema.SchemaError
  >;

  readonly getRecentMatches: (
    puuid: Puuid,
    region: Region | undefined,
  ) => Effect.Effect<ReadonlyArray<MatchDetails>, GameApiError>;

  readonly enrichMatch: (
    match: MatchDetails,
  ) => Effect.Effect<MatchDetails, GameApiError>;

  // undefined means the account is unranked, not that the lookup failed
  readonly getRank: (
    puuid: Puuid,
    region: Region | undefined,
  ) => Effect.Effect<RankInfo | undefined, GameApiError>;
}

export interface RankIcon {
  readonly key: string;
  readonly url: string;
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
