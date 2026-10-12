import { Cache, Config, Context, Effect, Exit, Layer, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { MatchId, Puuid } from "../../index.ts";
import { makeRiotHttpClient, RiotRateLimiterLive } from "../riot/http.ts";
import {
  ValActiveShard,
  ValContent,
  ValMatch,
  ValMatchlist,
} from "./riot-match-schema.ts";

export class RiotValApiClient extends Context.Service<
  RiotValApiClient,
  {
    getAccountByRiotId: (
      name: string,
      tag: string,
    ) => Effect.Effect<
      Puuid,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    // the shard ("na", "eu", "ap", ...) an account's matches are kept on
    getActiveShard: (
      puuid: Puuid,
    ) => Effect.Effect<
      string,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    getMatchlist: (
      puuid: Puuid,
      shard: string,
    ) => Effect.Effect<
      (typeof ValMatchlist.Type)["history"],
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    // undefined when the match doesn't decode
    getMatch: (
      matchId: MatchId,
      shard: string,
    ) => Effect.Effect<ValMatch | undefined, HttpClientError.HttpClientError>;
    // the names of agents and maps, which matches only reference by id
    getContent: () => Effect.Effect<
      ValContent,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
  }
>()("app/RiotValApiClient") {}

export const RiotValApiLive = Layer.effect(
  RiotValApiClient,
  Effect.gen(function* () {
    const cluster = yield* Config.string("RIOT_REGION").pipe(
      Config.withDefault("americas"),
    );
    // a key of a VALORANT product; riot encrypts puuids per key, so accounts
    // are looked up under it too
    const http = yield* makeRiotHttpClient(
      "val",
      yield* Config.redacted("RIOT_VAL_API_KEY"),
      cluster,
    );
    const onShard = (shard: string, path: string) =>
      http
        .pipe(
          HttpClient.mapRequest(
            HttpClientRequest.setUrl(
              `https://${shard}.api.riotgames.com${path}`,
            ),
          ),
        )
        .get("");

    const getAccountByRiotId = Effect.fn("RiotValApi.getAccountByRiotId")(
      function* (name: string, tag: string) {
        const res = yield* http.get(
          `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
        );
        const { puuid } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ puuid: Puuid }),
        )(yield* res.json);
        return puuid;
      },
    );

    const getActiveShard = Effect.fn("RiotValApi.getActiveShard")(function* (
      puuid: Puuid,
    ) {
      const res = yield* http.get(
        `/riot/account/v1/active-shards/by-game/val/by-puuid/${encodeURIComponent(puuid)}`,
      );
      const { activeShard } = yield* Schema.decodeUnknownEffect(ValActiveShard)(
        yield* res.json,
      );
      return activeShard.toLowerCase();
    });

    const getMatchlist = Effect.fn("RiotValApi.getMatchlist")(function* (
      puuid: Puuid,
      shard: string,
    ) {
      const res = yield* onShard(
        shard,
        `/val/match/v1/matchlists/by-puuid/${encodeURIComponent(puuid)}`,
      );
      const { history } = yield* Schema.decodeUnknownEffect(ValMatchlist)(
        yield* res.json,
      );
      return history;
    });

    const getMatch = Effect.fn("RiotValApi.getMatch")(function* (
      matchId: MatchId,
      shard: string,
    ) {
      const res = yield* onShard(shard, `/val/match/v1/matches/${matchId}`);
      return yield* Schema.decodeUnknownEffect(ValMatch)(yield* res.json).pipe(
        Effect.catchTag("SchemaError", (error) =>
          Effect.logWarning("skipping undecodable valorant match").pipe(
            Effect.annotateLogs({ matchId, error }),
            Effect.as(undefined),
          ),
        ),
      );
    });

    // the catalog only changes with patches; any shard serves it
    const content = yield* Cache.makeWith(
      (locale: string) =>
        onShard("na", `/val/content/v1/contents?locale=${locale}`).pipe(
          Effect.flatMap((res) => res.json),
          Effect.flatMap(Schema.decodeUnknownEffect(ValContent)),
        ),
      {
        capacity: 1,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? "1 day" : "0 millis"),
      },
    );

    return RiotValApiClient.of({
      getAccountByRiotId,
      getActiveShard,
      getMatchlist,
      getMatch,
      getContent: () => Cache.get(content, "en-US"),
    });
  }),
).pipe(Layer.provide(RiotRateLimiterLive));
