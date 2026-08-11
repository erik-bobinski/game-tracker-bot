import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { Puuid, type ResolvedAccount } from "../../index.ts";
import {
  ValAccountResponse,
  ValMatchesResponse,
  ValMmrResponse,
  type ValRawMatch,
} from "./match-schema.ts";

export interface ValRank {
  readonly tier: string;
  readonly rr: number;
  readonly wins: number | undefined;
  readonly losses: number | undefined;
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
    getRank: (
      puuid: Puuid,
      region: string | undefined,
    ) => Effect.Effect<
      ValRank | undefined,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
  }
>()("app/HenrikApiClient") {}

export const HenrikApiClientLive = Layer.effect(
  HenrikApiClient,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("HENRIK_API_KEY");
    // the region an account plays in; only used when signup couldn't store one
    const defaultRegion = yield* Config.string("VAL_REGION").pipe(
      Config.withDefault("na"),
    );
    // henrik's "platform" is pc/console, unlike riot's, which is a shard
    const platform = yield* Config.string("VAL_PLATFORM").pipe(
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

      const act = data.seasonal?.at(-1);
      return {
        tier,
        rr: data.current?.rr ?? 0,
        wins: act?.wins,
        losses: act ? act.games - act.wins : undefined,
      };
    });

    return HenrikApiClient.of({
      getAccountByRiotId,
      getRecentMatches,
      getRank,
    });
  }),
);
