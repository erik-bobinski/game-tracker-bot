import { Context, Effect, Layer, Schema } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
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
import { makeTftGameAdapter } from "./tft.ts";
import { makeValorantGameAdapter } from "./valorant.ts";

// Cap per-poll fetches; we poll every minute so 3 is plenty.
export const RECENT_MATCH_COUNT = 3;

export class GameApiError extends Schema.TaggedError<GameApiError>()(
  "GameApiError",
  { game: GameId, operation: Schema.String, cause: Schema.Defect() },
) {}

const apiErrorAnnotations = (error: unknown) =>
  Effect.gen(function* () {
    const cause = error instanceof GameApiError ? error.cause : error;
    if (!HttpClientError.isHttpClientError(cause)) {
      return {
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }

    const responseBody = cause.response
      ? yield* cause.response.text.pipe(
          Effect.map((body) => body.slice(0, 1_000)),
          Effect.catch(() => Effect.succeed(undefined)),
        )
      : undefined;

    return {
      error: cause.message,
      httpMethod: cause.request.method,
      httpUrl: cause.request.url,
      ...(cause.response ? { httpStatus: cause.response.status } : {}),
      ...(responseBody ? { responseBody } : {}),
    };
  });

export const logApiWarning = (message: string, error: unknown) =>
  apiErrorAnnotations(error).pipe(
    Effect.flatMap((annotations) =>
      Effect.logWarning(message).pipe(Effect.annotateLogs(annotations)),
    ),
  );

export const logApiError = (message: string, error: unknown) =>
  apiErrorAnnotations(error).pipe(
    Effect.flatMap((annotations) =>
      Effect.logError(message).pipe(Effect.annotateLogs(annotations)),
    ),
  );

export interface GameAdapter {
  readonly game: GameId;
  readonly requiresMatchHistory: boolean;
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

const toGameState = (
  puuid: Puuid,
  region: Region | undefined,
  matches: ReadonlyArray<MatchDetails>,
) => ({
  puuid,
  reportedMatches: matches.map((match) => ({
    matchId: match.matchId,
    date: match.date,
  })),
  // matches carry the platformId they were played on, which covers
  // accounts the region lookup couldn't resolve
  region: region ?? matches[0]?.routingRegion,
  rankSnapshots: {},
});

// Used at signup and by /refresh.
export const resolveGameState = (
  adapter: GameAdapter,
  riotName: string,
  riotTag: string,
) =>
  adapter.resolveAccount(riotName, riotTag).pipe(
    Effect.flatMap(({ puuid, region }) => {
      const recent = adapter.getRecentMatches(puuid, region);
      if (!adapter.requiresMatchHistory) {
        return recent.pipe(
          Effect.catchTag("GameApiError", (error) =>
            logApiWarning("baseline match fetch failed", error).pipe(
              Effect.as([]),
            ),
          ),
          Effect.map((matches) => toGameState(puuid, region, matches)),
        );
      }

      return recent.pipe(
        Effect.map((matches) =>
          matches.length === 0
            ? undefined
            : toGameState(puuid, region, matches),
        ),
      );
    }),
  );

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
      yield* makeTftGameAdapter,
    ];

    return GameAdapters.of({ all });
  }),
);
