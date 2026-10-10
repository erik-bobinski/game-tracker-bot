import { Config, Context, Effect, Layer, Schema } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { HenrikApiClientLive } from "../game-api/val/henrik-api-client.ts";
import { RiotValApiLive } from "../game-api/val/riot-val-client.ts";
import {
  EpochMillis,
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
import { makeLolGameAdapter } from "./lol.ts";
import { makeTftGameAdapter } from "./tft.ts";
import { makeValorantGameAdapter } from "./valorant.ts";
import { makeHenrikValorantAdapter } from "./valorant-henrik.ts";

// How many of an account's newest matches a poll looks at. Nobody is polled
// less than every 15 minutes, too short to finish more than one game.
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

export const enrichOrSkip = (
  adapter: GameAdapter,
  input: Parameters<GameAdapter["enrichMatch"]>[0],
) =>
  adapter
    .enrichMatch(input)
    .pipe(
      Effect.catchTag("GameApiError", (error) =>
        logApiWarning(
          "sending match report without optional enrichment",
          error,
        ).pipe(Effect.as(emptyEnrichment(input.match))),
      ),
    );

// Used at signup and by /refresh. The current matches count as reported, so
// the first poll doesn't repost old games.
export const resolveGameState = (
  adapter: GameAdapter,
  riotName: string,
  riotTag: string,
) =>
  adapter.resolveAccount(riotName, riotTag).pipe(
    Effect.flatMap(({ puuid, region }) =>
      Effect.gen(function* () {
        const matchIds = yield* adapter
          .getRecentMatchIds(puuid, region)
          .pipe(
            Effect.catchTag("GameApiError", (error) =>
              adapter.requiresMatchHistory
                ? Effect.fail(error)
                : logApiWarning("baseline match fetch failed", error).pipe(
                    Effect.as([]),
                  ),
            ),
          );
        if (adapter.requiresMatchHistory && matchIds.length === 0) {
          return undefined;
        }

        // only the newest match is fetched: its date is when they last
        // played, which sets how often they're polled
        const newest = matchIds[0]
          ? yield* adapter
              .getMatch(matchIds[0], region)
              .pipe(
                Effect.catchTag("GameApiError", (error) =>
                  logApiWarning("baseline match fetch failed", error).pipe(
                    Effect.as(undefined),
                  ),
                ),
              )
          : undefined;
        const date = newest?.date ?? EpochMillis.make(0);

        return {
          puuid,
          reportedMatches: matchIds.map((matchId) => ({ matchId, date })),
          // matches carry the platformId they were played on, which covers
          // accounts the region lookup couldn't resolve
          region: region ?? newest?.routingRegion,
          rankSnapshots: {},
        };
      }),
    ),
  );

export class GameAdapters extends Context.Service<
  GameAdapters,
  {
    readonly all: ReadonlyArray<GameAdapter>;
  }
>()("app/GameAdapters") {}

class ValorantAdapter extends Context.Service<ValorantAdapter, GameAdapter>()(
  "app/ValorantAdapter",
) {}

// VALORANT comes from riot's own api once a VALORANT product key is set, and
// from HenrikDev's unofficial one until riot approves that key. Riot encrypts
// puuids per key, so accounts signed up through henrik have to /link again.
const ValorantAdapterLive = Layer.unwrap(
  Config.string("RIOT_VAL_API_KEY").pipe(
    Config.withDefault(""),
    Effect.map((key) =>
      key
        ? Layer.effect(ValorantAdapter, makeValorantGameAdapter).pipe(
            Layer.provide(RiotValApiLive),
          )
        : Layer.effect(ValorantAdapter, makeHenrikValorantAdapter).pipe(
            Layer.provide(HenrikApiClientLive),
          ),
    ),
  ),
);

export const GameAdaptersLive = Layer.effect(
  GameAdapters,
  Effect.gen(function* () {
    const all: ReadonlyArray<GameAdapter> = [
      yield* makeLolGameAdapter,
      yield* ValorantAdapter,
      yield* makeTftGameAdapter,
    ];

    return GameAdapters.of({ all });
  }),
).pipe(Layer.provide(ValorantAdapterLive));
