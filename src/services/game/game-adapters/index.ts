import { Context, Effect, Layer, Schema } from "effect";
import {
  GameId,
  type MatchDetails,
  type RankSummary,
  type ResolvedGameAccount,
  type TrackedGameAccount,
} from "../index.ts";
import { makeLolGameAdapter } from "./lol.ts";
import { makeValorantGameAdapter } from "./valorant.ts";

export const RECENT_MATCH_COUNT = 3;

export class AccountNotFound extends Schema.TaggedErrorClass<AccountNotFound>()(
  "AccountNotFound",
  { game: GameId },
) {}

export class GameApiError extends Schema.TaggedErrorClass<GameApiError>()(
  "GameApiError",
  { game: GameId, operation: Schema.String, cause: Schema.Defect() },
) {}

export interface GameAdapter {
  readonly game: GameId;
  readonly rankIcons: ReadonlyArray<RankIcon>;
  readonly resolveAccount: (
    name: string,
    tag: string,
  ) => Effect.Effect<ResolvedGameAccount, AccountNotFound | GameApiError>;
  readonly getRecentMatches: (
    account: TrackedGameAccount,
  ) => Effect.Effect<ReadonlyArray<MatchDetails>, GameApiError>;
  readonly getRanks: (
    account: TrackedGameAccount,
  ) => Effect.Effect<ReadonlyArray<RankSummary>, GameApiError>;
  readonly enrichMatch: (
    match: MatchDetails,
  ) => Effect.Effect<MatchDetails, GameApiError>;
}

export interface RankIcon {
  readonly key: string;
  readonly url: string;
}

export class GameAdapters extends Context.Service<
  GameAdapters,
  { readonly all: ReadonlyArray<GameAdapter> }
>()("app/GameAdapters") {}

export const GameAdaptersLive = Layer.effect(
  GameAdapters,
  Effect.gen(function* () {
    return GameAdapters.of({
      all: [yield* makeLolGameAdapter, yield* makeValorantGameAdapter],
    });
  }),
);
