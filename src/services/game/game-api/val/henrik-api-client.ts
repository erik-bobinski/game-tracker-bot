import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { Puuid } from "../../index.ts";

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
  }
>()("app/HenrikApiClient") {}

// HenrikDev wraps every payload in {status, data}
const HenrikResponse = <A extends Schema.Top>(data: A) =>
  Schema.Struct({ status: Schema.Number, data });

export const HenrikApiClientLive = Layer.effect(
  HenrikApiClient,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("HENRIK_API_KEY");
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

    return HenrikApiClient.of({ getAccountByRiotId });
  }),
);
