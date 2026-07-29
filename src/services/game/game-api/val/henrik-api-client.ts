import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { Puuid } from "../../index.ts";
import { ValMatchesResponse, type ValRawMatch } from "./match-schema.ts";

export class HenrikApiClient extends Context.Service<
  HenrikApiClient,
  {
    getAccountByRiotId: (
      name: string,
      tag: string,
    ) => Effect.Effect<
      Puuid,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    getRecentMatches: (
      puuid: Puuid,
      count: number,
    ) => Effect.Effect<
      ReadonlyArray<ValRawMatch>,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
  }
>()("app/HenrikApiClient") {}

// HenrikDev wraps every payload in {status, data}
const HenrikResponse = <A extends Schema.Top>(data: A) =>
  Schema.Struct({ status: Schema.Number, data });

export const HenrikApiClientLive = Layer.effect(
  HenrikApiClient,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("HENRIK_API_KEY");
    // TODO: replace with per-account region once Database stores it.
    const region = yield* Config.string("VAL_REGION").pipe(
      Config.withDefault("na"),
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
          `/valorant/v1/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
        );
        const json = yield* res.json;
        const { data } = yield* Schema.decodeUnknownEffect(
          HenrikResponse(Schema.Struct({ puuid: Puuid })),
        )(json);
        return data.puuid;
      },
    );

    const getRecentMatches = Effect.fn("HenrikApiClient.getRecentMatches")(
      function* (puuid: Puuid, count: number) {
        const res = yield* client.get(
          `/valorant/v3/by-puuid/matches/${region}/${encodeURIComponent(puuid)}?size=${count}`,
        );
        const json = yield* res.json;
        const { data } = yield* Schema.decodeUnknownEffect(ValMatchesResponse)(
          json,
        ).pipe(Effect.annotateLogs({ puuid }));

        // undefined entries are matches the schema skipped rather than failed on
        return data.filter((match) => match !== undefined);
      },
    );

    return HenrikApiClient.of({ getAccountByRiotId, getRecentMatches });
  }),
);
