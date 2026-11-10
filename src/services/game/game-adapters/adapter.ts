import { Effect, Schema } from "effect";
import * as HttpClientError from "effect/http/HttpClientError";
import {
  GameId,
  type MatchDetails,
  type MatchId,
  type Puuid,
  type RankInfo,
  type RankSnapshots,
  type RankUpdate,
  type Region,
  type ResolvedAccount,
} from "../index.ts";

// How many of an account's newest matches a poll looks at. Everyone is polled
// every 3 minutes, too short to finish more than one game.
export const RECENT_MATCH_COUNT = 3;

export class GameApiError extends Schema.TaggedError<GameApiError>()(
  "GameApiError",
  { game: GameId, operation: Schema.String, cause: Schema.Defect() },
) {}

// what a game api call can fail with: the adapter's own error, or the http
// and decoding errors of the api clients beneath it
type ApiError =
  GameApiError | HttpClientError.HttpClientError | Schema.SchemaError;

const apiErrorAnnotations = (error: ApiError) =>
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
      httpStatus: cause.response?.status,
      responseBody,
    };
  });

export const logApiWarning = (message: string, error: ApiError) =>
  apiErrorAnnotations(error).pipe(
    Effect.flatMap((annotations) =>
      Effect.logWarning(message).pipe(Effect.annotateLogs(annotations)),
    ),
  );

export const logApiError = (message: string, error: ApiError) =>
  apiErrorAnnotations(error).pipe(
    Effect.flatMap((annotations) =>
      Effect.logError(message).pipe(Effect.annotateLogs(annotations)),
    ),
  );

export interface GameAdapter {
  readonly game: GameId;
  // A game riot only shares a player's data for once they've signed in with
  // riot (RSO) to opt in. Signing up by riot id skips it; /link adds it.
  readonly requiresOptIn: boolean;
  readonly iconUrl: string;
  readonly rankIcons: ReadonlyArray<RankIcon>;

  readonly resolveAccount: (
    name: string,
    tag: string,
  ) => Effect.Effect<
    ResolvedAccount,
    HttpClientError.HttpClientError | Schema.SchemaError
  >;

  // Newest first. Every poll calls this, so it should cost one request; the
  // match itself is only fetched once it turns out to be new.
  readonly getRecentMatchIds: (
    puuid: Puuid,
    region: Region | undefined,
  ) => Effect.Effect<ReadonlyArray<MatchId>, GameApiError>;

  // undefined for a match that can't be decoded, which a retry won't fix
  readonly getMatch: (
    matchId: MatchId,
    region: Region | undefined,
  ) => Effect.Effect<MatchDetails | undefined, GameApiError>;

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
