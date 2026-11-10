import { Config, Context, Effect, Layer } from "effect";
import { HenrikApiClientLive } from "../game-api/val/henrik-api-client.ts";
import { RiotValApiLive } from "../game-api/val/riot-val-client.ts";
import { EpochMillis } from "../index.ts";
import { type GameAdapter, logApiWarning, emptyEnrichment } from "./adapter.ts";
import { LolAdapter, LolAdapterLive } from "./lol.ts";
import { TftAdapter, TftAdapterLive } from "./tft.ts";
import { RiotValorantAdapterLive, ValorantAdapter } from "./valorant.ts";
import { HenrikValorantAdapterLive } from "./valorant-henrik.ts";

// the adapter contract, for code outside the adapters
export * from "./adapter.ts";

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

// Used by /track. The current matches count as reported, so the first poll
// doesn't repost old games.
export const resolveGameState = (
  adapter: GameAdapter,
  riotName: string,
  riotTag: string,
) =>
  adapter.resolveAccount(riotName, riotTag).pipe(
    Effect.flatMap(({ puuid, region }) =>
      Effect.gen(function* () {
        // an empty baseline would report every recent match as new, so a
        // failed fetch fails the lookup
        const matchIds = yield* adapter.getRecentMatchIds(puuid, region);

        // only the newest match is fetched: its date is when they last
        // played, so an older match that shows up later isn't reported
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

// VALORANT comes from riot's own api once a VALORANT product key is set, and
// from HenrikDev's unofficial one until riot approves that key. Riot encrypts
// puuids per key, so accounts signed up through henrik have to /link again.
const ValorantAdapterLive = Layer.unwrap(
  Config.String("RIOT_VAL_API_KEY").pipe(
    Config.withDefault(""),
    Effect.map((key) =>
      key
        ? RiotValorantAdapterLive.pipe(Layer.provide(RiotValApiLive))
        : HenrikValorantAdapterLive.pipe(Layer.provide(HenrikApiClientLive)),
    ),
  ),
);

export const GameAdaptersLive = Layer.effect(
  GameAdapters,
  Effect.gen(function* () {
    const all: ReadonlyArray<GameAdapter> = [
      yield* LolAdapter,
      yield* ValorantAdapter,
      yield* TftAdapter,
    ];

    return GameAdapters.of({ all });
  }),
).pipe(Layer.provide([LolAdapterLive, ValorantAdapterLive, TftAdapterLive]));
