import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientError from "effect/http/HttpClientError";
import { RateLimiter } from "effect/persistence";
import { RiotRateLimiterLive } from "../riot/http.ts";
import { Puuid, type MatchId, type ResolvedAccount } from "../../index.ts";
import {
  ValAccountResponse,
  ValMatchesResponse,
  ValMmrHistoryResponse,
  ValMmrResponse,
  ValPerformanceScoresResponse,
  type ValMmrHistoryEntry,
  type ValRawMatch,
} from "./match-schema.ts";

export interface ValRank {
  readonly tier: string;
  readonly rr: number;
  readonly wins: number | undefined;
  readonly games: number | undefined;
}

export class HenrikApiClient extends Context.Service<
  HenrikApiClient,
  {
    getAccountByRiotId: (
      name: string,
      tag: string,
    ) => Effect.Effect<
      ResolvedAccount,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    getRecentMatches: (
      puuid: Puuid,
      region: string | undefined,
      count: number,
    ) => Effect.Effect<
      ReadonlyArray<ValRawMatch>,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    getPerformanceScores: (
      matchId: MatchId,
      region: string | undefined,
    ) => Effect.Effect<
      ReadonlyMap<Puuid, number>,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    getRank: (
      puuid: Puuid,
      region: string | undefined,
    ) => Effect.Effect<
      ValRank | undefined,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    getMmrHistory: (
      puuid: Puuid,
      region: string | undefined,
    ) => Effect.Effect<
      ReadonlyArray<ValMmrHistoryEntry>,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
  }
>()("app/HenrikApiClient") {}

export const HenrikApiClientLive = Layer.effect(
  HenrikApiClient,
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("HENRIK_API_KEY");
    // the region an account plays in; only used when signup couldn't store one
    const defaultRegion = yield* Config.String("VAL_REGION").pipe(
      Config.withDefault("na"),
    );
    // henrik's "platform" is pc/console, unlike riot's, which is a shard
    const platform = yield* Config.String("VAL_PLATFORM").pipe(
      Config.withDefault("pc"),
    );
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        HttpClientRequest.prependUrl("https://api.henrikdev.xyz"),
      ),
      HttpClient.mapRequest(
        // HenrikDev takes the raw key in Authorization (no "Bearer" prefix).
        HttpClientRequest.setHeader("Authorization", Redacted.value(apiKey)),
      ),
      HttpClient.filterStatusOk,
      // every player is polled at once, so requests wait their turn under the
      // key's per-minute limit, which henrik states on each response
      HttpClient.withRateLimiter({
        limiter: yield* RateLimiter.RateLimiter,
        key: "henrik",
        limit: 30,
        window: "1 minute",
        times: 3,
      }),
      // the in-memory store can't fail
      HttpClient.catchTag("RateLimiterError", Effect.die),
      HttpClient.retryTransient({ times: 3 }),
    );

    const getAccountByRiotId = Effect.fn("HenrikApiClient.getAccountByRiotId")(
      function* (name: string, tag: string) {
        const res = yield* client.get(
          `/valorant/v2/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
        );
        const json = yield* res.json;
        const { data } =
          yield* Schema.decodeUnknownEffect(ValAccountResponse)(json);
        return { puuid: data.puuid, region: data.region.toLowerCase() };
      },
    );

    const getRecentMatches = Effect.fn("HenrikApiClient.getRecentMatches")(
      function* (puuid: Puuid, region: string | undefined, count: number) {
        const res = yield* client.get(
          `/valorant/v4/by-puuid/matches/${region ?? defaultRegion}/${platform}/${encodeURIComponent(puuid)}?size=${count}`,
        );
        const json = yield* res.json;
        const { data } = yield* Schema.decodeUnknownEffect(ValMatchesResponse)(
          json,
        ).pipe(Effect.annotateLogs({ puuid }));

        // undefined entries are matches the schema skipped rather than failed on
        return data.filter((match) => match !== undefined);
      },
    );

    // rounded Performance Score per player, from riot's own match payload;
    // players without one are left out
    const getPerformanceScores = Effect.fn(
      "HenrikApiClient.getPerformanceScores",
    )(function* (matchId: MatchId, region: string | undefined) {
      const res = yield* client.post("/valorant/v1/raw", {
        body: HttpBody.jsonUnsafe({
          type: "matchdetails",
          value: matchId,
          region: region ?? defaultRegion,
          platform,
        }),
      });
      const json = yield* res.json;
      const { data } = yield* Schema.decodeUnknownEffect(
        ValPerformanceScoresResponse,
      )(json);
      return new Map(
        data.players.flatMap(({ subject, scores }) =>
          scores?.performanceScore == null
            ? []
            : [[subject, Math.round(scores.performanceScore)] as const],
        ),
      );
    });

    const getRank = Effect.fn("HenrikApiClient.getRank")(function* (
      puuid: Puuid,
      region: string | undefined,
    ) {
      const res = yield* client.get(
        `/valorant/v3/by-puuid/mmr/${region ?? defaultRegion}/${platform}/${encodeURIComponent(puuid)}`,
      );
      const json = yield* res.json;
      const { data } = yield* Schema.decodeUnknownEffect(ValMmrResponse)(json);
      const tier = data.current?.tier?.name;
      if (!tier) return undefined;

      const act = data.seasonal?.findLast((season) => season.games > 0);
      return {
        tier,
        rr: data.current?.rr ?? 0,
        wins: act?.wins,
        games: act?.games,
      };
    });

    const getMmrHistory = Effect.fn("HenrikApiClient.getMmrHistory")(function* (
      puuid: Puuid,
      region: string | undefined,
    ) {
      const res = yield* client.get(
        `/valorant/v1/by-puuid/mmr-history/${region ?? defaultRegion}/${encodeURIComponent(puuid)}`,
      );
      const json = yield* res.json;
      const { data } = yield* Schema.decodeUnknownEffect(ValMmrHistoryResponse)(
        json,
      );
      return data;
    });

    return HenrikApiClient.of({
      getAccountByRiotId,
      getRecentMatches,
      getPerformanceScores,
      getRank,
      getMmrHistory,
    });
  }),
).pipe(Layer.provide(RiotRateLimiterLive));
