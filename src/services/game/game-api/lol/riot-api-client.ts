import { Context, Effect, Layer, Redacted, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { AppConfig } from "../../../config.ts";
import { Puuid } from "../../index.ts";
import { ProviderError, ProviderNotFound } from "../errors.ts";
import {
  LolLeagueEntries,
  LolMatch,
  LolMatchIds,
  LolSummoner,
  type LolLeagueEntry,
} from "./match-schema.ts";

type RiotFailure = ProviderNotFound | ProviderError;

export class RiotApiClient extends Context.Service<
  RiotApiClient,
  {
    readonly getAccountByRiotId: (
      name: string,
      tag: string,
      regionalRoute: string,
    ) => Effect.Effect<Puuid, RiotFailure>;
    readonly getSummonerByPuuid: (
      puuid: Puuid,
      platformRoute: string,
    ) => Effect.Effect<void, RiotFailure>;
    readonly getRecentMatches: (
      puuid: Puuid,
      count: number,
      regionalRoute: string,
    ) => Effect.Effect<ReadonlyArray<LolMatch>, RiotFailure>;
    readonly getLeagueEntries: (
      puuid: Puuid,
      platformRoute: string,
    ) => Effect.Effect<ReadonlyArray<LolLeagueEntry>, RiotFailure>;
  }
>()("app/RiotApiClient") {}

const classify = (operation: string) =>
  Effect.mapError(
    (cause: HttpClientError.HttpClientError | Schema.SchemaError) => {
      if (
        HttpClientError.isHttpClientError(cause) &&
        cause.reason._tag === "StatusCodeError" &&
        cause.reason.response.status === 404
      ) {
        return new ProviderNotFound({ provider: "riot", operation });
      }
      return new ProviderError({ provider: "riot", operation, cause });
    },
  );

export const RiotApiLive = Layer.effect(
  RiotApiClient,
  Effect.gen(function* () {
    const { riotApiKey } = yield* AppConfig;
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        HttpClientRequest.setHeader("X-Riot-Token", Redacted.value(riotApiKey)),
      ),
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({ times: 3 }),
    );

    const getAccountByRiotId = Effect.fn("RiotApi.getAccountByRiotId")(
      function* (name: string, tag: string, regionalRoute: string) {
        const response = yield* client.get(
          `https://${regionalRoute}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
        );
        const { puuid } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ puuid: Puuid }),
        )(yield* response.json);
        return puuid;
      },
      (effect) => effect.pipe(classify("getAccountByRiotId")),
    );

    const getSummonerByPuuid = Effect.fn("RiotApi.getSummonerByPuuid")(
      function* (puuid: Puuid, platformRoute: string) {
        const response = yield* client.get(
          `https://${platformRoute}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`,
        );
        yield* Schema.decodeUnknownEffect(LolSummoner)(yield* response.json);
      },
      (effect) => effect.pipe(classify("getSummonerByPuuid")),
    );

    const getMatch = Effect.fn("RiotApi.getMatch")(
      function* (matchId: string, regionalRoute: string) {
        const response = yield* client.get(
          `https://${regionalRoute}.api.riotgames.com/lol/match/v5/matches/${encodeURIComponent(matchId)}`,
        );
        return yield* Schema.decodeUnknownEffect(LolMatch)(
          yield* response.json,
        );
      },
      (effect) => effect.pipe(classify("getMatch")),
    );

    const getRecentMatches = Effect.fn("RiotApi.getRecentMatches")(function* (
      puuid: Puuid,
      count: number,
      regionalRoute: string,
    ) {
      const matchIds = yield* Effect.gen(function* () {
        const response = yield* client.get(
          `https://${regionalRoute}.api.riotgames.com/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?count=${count}`,
        );
        return yield* Schema.decodeUnknownEffect(LolMatchIds)(
          yield* response.json,
        );
      }).pipe(classify("getRecentMatchIds"));
      const matches = yield* Effect.forEach(matchIds, (matchId) =>
        getMatch(matchId, regionalRoute).pipe(
          Effect.catchTag("ProviderError", (error) =>
            error.cause instanceof Schema.SchemaError
              ? Effect.logWarning("skipping undecodable lol match").pipe(
                  Effect.annotateLogs({ matchId, error }),
                  Effect.as(undefined),
                )
              : Effect.fail(error),
          ),
        ),
      );
      return matches.filter((match) => match !== undefined);
    });

    const getLeagueEntries = Effect.fn("RiotApi.getLeagueEntries")(
      function* (puuid: Puuid, platformRoute: string) {
        const response = yield* client.get(
          `https://${platformRoute}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`,
        );
        return yield* Schema.decodeUnknownEffect(LolLeagueEntries)(
          yield* response.json,
        );
      },
      (effect) => effect.pipe(classify("getLeagueEntries")),
    );

    return RiotApiClient.of({
      getAccountByRiotId,
      getSummonerByPuuid,
      getRecentMatches,
      getLeagueEntries,
    });
  }),
);
