import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { Puuid } from "../../index.js";

export class RiotApiClient extends Context.Service<
  RiotApiClient,
  {
    getAccountByRiotId: (
      name: string,
      tag: string,
    ) => Effect.Effect<
      Puuid,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
  }
>()("app/RiotApiClient") {}

export const RiotApiLive = Layer.effect(
  RiotApiClient,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("RIOT_API_KEY");
    const region = yield* Config.string("RIOT_REGION").pipe(
      Config.withDefault("americas"),
    );
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        HttpClientRequest.prependUrl(`https://${region}.api.riotgames.com`),
      ),
      HttpClient.mapRequest(
        HttpClientRequest.setHeader("X-Riot-Token", Redacted.value(apiKey)),
      ),
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({ times: 3 }),
    );

    const getAccountByRiotId = Effect.fn("RiotApi.getAccountByRiotId")(
      function* (name: string, tag: string) {
        const res = yield* client.get(
          `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
        );
        const json = yield* res.json;
        const { puuid } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ puuid: Puuid }),
        )(json);
        return puuid;
      },
    );

    return RiotApiClient.of({ getAccountByRiotId });
  }),
);
