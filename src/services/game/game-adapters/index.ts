import { Context, Effect, Layer, Schema } from "effect";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import {
  GameId,
  type MatchDetails,
  type Puuid,
  type RankInfo,
  type RankSnapshots,
  type RankUpdate,
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

  readonly enrichMatch: (input: {
    readonly match: MatchDetails;
    readonly trackedPlayers: ReadonlyArray<{
      readonly puuid: Puuid;
      readonly region: Region | undefined;
      readonly previousRankSnapshots: RankSnapshots;
    }>;
  }) => Effect.Effect<
    {
      readonly match: MatchDetails;
      readonly rankUpdates: ReadonlyMap<Puuid, RankUpdate>;
      readonly updatedRankSnapshots: ReadonlyMap<Puuid, RankSnapshots>;
    },
    GameApiError
  >;

  // undefined means the account is unranked, not that the lookup failed
  readonly getRank: (
    puuid: Puuid,
    region: Region | undefined,
  ) => Effect.Effect<RankInfo | undefined, GameApiError>;
}

export interface RankIcon {
  readonly key: string;
  readonly url: string;
  // emoji-sized art is too small to fill an embed, which is what centers it
  readonly largeUrl?: string;
}

export const emptyEnrichment = (match: MatchDetails) => ({
  match,
  rankUpdates: new Map<Puuid, RankUpdate>(),
  updatedRankSnapshots: new Map<Puuid, RankSnapshots>(),
});

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
