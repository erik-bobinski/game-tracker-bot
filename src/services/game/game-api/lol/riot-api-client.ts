import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { Puuid } from "../../index.ts";
import { LolMatch, LolMatchIds } from "./match-schema.ts";

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
    getRecentMatches: (
      puuid: Puuid,
      count: number,
    ) => Effect.Effect<
      ReadonlyArray<LolMatch>,
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

    const getMatch = Effect.fn("RiotApi.getMatch")(function* (matchId: string) {
      const res = yield* client.get(`/lol/match/v5/matches/${matchId}`);
      const json = yield* res.json;
      return yield* Schema.decodeUnknownEffect(LolMatch)(json);
    });

    // Match-V5 has no bulk endpoint: fetch ids, then one call per match.
    const getRecentMatches = Effect.fn("RiotApi.getRecentMatches")(function* (
      puuid: Puuid,
      count: number,
    ) {
      const res = yield* client.get(
        `/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?count=${count}`,
      );
      const json = yield* res.json;
      const matchIds = yield* Schema.decodeUnknownEffect(LolMatchIds)(json);

      const matches = yield* Effect.forEach(matchIds, (matchId) =>
        getMatch(matchId).pipe(
          Effect.catchTag("SchemaError", (error) =>
            Effect.logWarning("skipping undecodable lol match").pipe(
              Effect.annotateLogs({ matchId, error }),
              Effect.as(undefined),
            ),
          ),
        ),
      );

      return matches.filter((match) => match !== undefined);
    });

    return RiotApiClient.of({ getAccountByRiotId, getRecentMatches });
  }),
);
