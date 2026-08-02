import { Context, Effect, Layer, Redacted, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { AppConfig } from "../../../config.ts";
import { Puuid } from "../../index.ts";
import { ProviderError, ProviderNotFound } from "../errors.ts";
import {
  ValAccountResponse,
  ValMatchesResponse,
  ValMmrResponse,
  type ValRawMatch,
} from "./match-schema.ts";

type HenrikFailure = ProviderNotFound | ProviderError;

export interface HenrikAccount {
  readonly puuid: Puuid;
  readonly region: string;
  readonly platforms: ReadonlyArray<string>;
}

export interface HenrikMmr {
  readonly tier: string;
  readonly rr: number;
}

export class HenrikApiClient extends Context.Service<
  HenrikApiClient,
  {
    readonly getAccountByRiotId: (
      name: string,
      tag: string,
    ) => Effect.Effect<HenrikAccount, HenrikFailure>;
    readonly getRecentMatches: (
      puuid: Puuid,
      count: number,
      region: string,
      platform: string,
    ) => Effect.Effect<ReadonlyArray<ValRawMatch>, HenrikFailure>;
    readonly getMmr: (
      puuid: Puuid,
      region: string,
      platform: string,
    ) => Effect.Effect<HenrikMmr, HenrikFailure>;
  }
>()("app/HenrikApiClient") {}

const classify = (operation: string) =>
  Effect.mapError(
    (cause: HttpClientError.HttpClientError | Schema.SchemaError) => {
      if (
        HttpClientError.isHttpClientError(cause) &&
        cause.reason._tag === "StatusCodeError" &&
        cause.reason.response.status === 404
      ) {
        return new ProviderNotFound({ provider: "henrik", operation });
      }
      return new ProviderError({ provider: "henrik", operation, cause });
    },
  );

export const HenrikApiClientLive = Layer.effect(
  HenrikApiClient,
  Effect.gen(function* () {
    const { henrikApiKey } = yield* AppConfig;
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        HttpClientRequest.setHeader(
          "Authorization",
          Redacted.value(henrikApiKey),
        ),
      ),
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({ times: 3 }),
    );

    const getAccountByRiotId = Effect.fn("HenrikApiClient.getAccountByRiotId")(
      function* (name: string, tag: string) {
        const response = yield* client.get(
          `https://api.henrikdev.xyz/valorant/v2/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
        );
        const { data } = yield* Schema.decodeUnknownEffect(ValAccountResponse)(
          yield* response.json,
        );
        return data;
      },
      (effect) => effect.pipe(classify("getAccountByRiotId")),
    );

    const getRecentMatches = Effect.fn("HenrikApiClient.getRecentMatches")(
      function* (
        puuid: Puuid,
        count: number,
        region: string,
        platform: string,
      ) {
        const response = yield* client.get(
          `https://api.henrikdev.xyz/valorant/v4/by-puuid/matches/${encodeURIComponent(region)}/${encodeURIComponent(platform)}/${encodeURIComponent(puuid)}?size=${count}`,
        );
        const { data } = yield* Schema.decodeUnknownEffect(ValMatchesResponse)(
          yield* response.json,
        ).pipe(Effect.annotateLogs({ puuid }));
        return data.filter((match) => match !== undefined);
      },
      (effect) => effect.pipe(classify("getRecentMatches")),
    );

    const getMmr = Effect.fn("HenrikApiClient.getMmr")(
      function* (puuid: Puuid, region: string, platform: string) {
        const response = yield* client.get(
          `https://api.henrikdev.xyz/valorant/v3/by-puuid/mmr/${encodeURIComponent(region)}/${encodeURIComponent(platform)}/${encodeURIComponent(puuid)}`,
        );
        const { data } = yield* Schema.decodeUnknownEffect(ValMmrResponse)(
          yield* response.json,
        );
        return { tier: data.current.tier.name, rr: data.current.rr };
      },
      (effect) => effect.pipe(classify("getMmr")),
    );

    return HenrikApiClient.of({ getAccountByRiotId, getRecentMatches, getMmr });
  }),
);
