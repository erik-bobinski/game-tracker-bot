import { Config, Context, Effect, Layer, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { MatchId, Puuid } from "../../index.ts";
import { LolLeagueEntries, LolMatch } from "../lol/match-schema.ts";
import { makeRiotHttpClient, RiotRateLimiterLive } from "../riot/http.ts";
import { TftLeagueEntries, TftMatch } from "../tft/match-schema.ts";

// A platformId is the shard an account lives on (riot's "platform routing
// value"), not pc/console. match-v5 is routed by regional cluster instead, so
// an account's matches are only visible on the cluster its shard belongs to.
const CLUSTERS: Record<string, string> = {
  na1: "americas",
  br1: "americas",
  la1: "americas",
  la2: "americas",
  pbe1: "americas",
  euw1: "europe",
  eun1: "europe",
  tr1: "europe",
  ru: "europe",
  me1: "europe",
  kr: "asia",
  jp1: "asia",
  oc1: "sea",
  ph2: "sea",
  sg2: "sea",
  th2: "sea",
  tw2: "sea",
  vn2: "sea",
};

const MatchIds = Schema.Array(MatchId);

export class RiotApiClient extends Context.Service<
  RiotApiClient,
  {
    getAccountByRiotId: (
      game: "lol" | "tft",
      name: string,
      tag: string,
    ) => Effect.Effect<
      Puuid,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    getPlatformId: (
      game: "lol" | "tft",
      puuid: Puuid,
    ) => Effect.Effect<
      string,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    getMatchIds: (
      game: "lol" | "tft",
      puuid: Puuid,
      platformId: string | undefined,
      count: number,
    ) => Effect.Effect<
      ReadonlyArray<MatchId>,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    // undefined when the match doesn't decode
    getLolMatch: (
      matchId: MatchId,
      platformId: string | undefined,
    ) => Effect.Effect<LolMatch | undefined, HttpClientError.HttpClientError>;
    getTftMatch: (
      matchId: MatchId,
      platformId: string | undefined,
    ) => Effect.Effect<TftMatch | undefined, HttpClientError.HttpClientError>;
    getLeagueEntries: (
      puuid: Puuid,
      platformId: string,
    ) => Effect.Effect<
      typeof LolLeagueEntries.Type,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    getTftLeagueEntries: (
      puuid: Puuid,
      platformId: string,
    ) => Effect.Effect<
      typeof TftLeagueEntries.Type,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
  }
>()("app/RiotApiClient") {}

export const RiotApiLive = Layer.effect(
  RiotApiClient,
  Effect.gen(function* () {
    // account-v1 answers for any account from any cluster, so this only picks
    // the nearest one; per-account routing comes from the stored platformId
    const defaultCluster = yield* Config.string("RIOT_REGION").pipe(
      Config.withDefault("americas"),
    );

    // Riot scopes each product key to one game and encrypts puuids per key,
    // so tft calls, account lookups included, go out under the tft key
    const clients = {
      lol: yield* makeRiotHttpClient(
        "lol",
        yield* Config.redacted("RIOT_API_KEY"),
        defaultCluster,
      ),
      tft: yield* makeRiotHttpClient(
        "tft",
        yield* Config.redacted("RIOT_TFT_API_KEY"),
        defaultCluster,
      ),
    };

    const getAccountByRiotId = Effect.fn("RiotApi.getAccountByRiotId")(
      function* (game: "lol" | "tft", name: string, tag: string) {
        const res = yield* clients[game].get(
          `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
        );
        const json = yield* res.json;
        const { puuid } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ puuid: Puuid }),
        )(json);
        return puuid;
      },
    );

    const getPlatformId = Effect.fn("RiotApi.getPlatformId")(function* (
      game: "lol" | "tft",
      puuid: Puuid,
    ) {
      const res = yield* clients[game].get(
        `/riot/account/v1/region/by-game/${game}/by-puuid/${encodeURIComponent(puuid)}`,
      );
      const json = yield* res.json;
      const { region } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ region: Schema.String }),
      )(json);
      return region.toLowerCase();
    });

    // an unknown shard falls back to the configured cluster, which is right
    // as long as the account plays there
    const matchGet = (
      game: "lol" | "tft",
      platformId: string | undefined,
      path: string,
    ) => {
      const cluster =
        (platformId ? CLUSTERS[platformId] : undefined) ?? defaultCluster;
      return clients[game]
        .pipe(
          HttpClient.mapRequest(
            HttpClientRequest.setUrl(
              `https://${cluster}.api.riotgames.com${path}`,
            ),
          ),
        )
        .get("");
    };

    const getMatchIds = Effect.fn("RiotApi.getMatchIds")(function* (
      game: "lol" | "tft",
      puuid: Puuid,
      platformId: string | undefined,
      count: number,
    ) {
      const path =
        game === "lol"
          ? "/lol/match/v5/matches/by-puuid"
          : "/tft/match/v1/matches/by-puuid";
      const res = yield* matchGet(
        game,
        platformId,
        `${path}/${encodeURIComponent(puuid)}/ids?count=${count}`,
      );
      return yield* Schema.decodeUnknownEffect(MatchIds)(yield* res.json);
    });

    const getLolMatch = Effect.fn("RiotApi.getLolMatch")(function* (
      matchId: MatchId,
      platformId: string | undefined,
    ) {
      const res = yield* matchGet(
        "lol",
        platformId,
        `/lol/match/v5/matches/${matchId}`,
      );
      return yield* Schema.decodeUnknownEffect(LolMatch)(yield* res.json).pipe(
        Effect.catchTag("SchemaError", (error) =>
          Effect.logWarning("skipping undecodable lol match").pipe(
            Effect.annotateLogs({ matchId, error }),
            Effect.as(undefined),
          ),
        ),
      );
    });

    const getTftMatch = Effect.fn("RiotApi.getTftMatch")(function* (
      matchId: MatchId,
      platformId: string | undefined,
    ) {
      const res = yield* matchGet(
        "tft",
        platformId,
        `/tft/match/v1/matches/${matchId}`,
      );
      return yield* Schema.decodeUnknownEffect(TftMatch)(yield* res.json).pipe(
        Effect.catchTag("SchemaError", (error) =>
          Effect.logWarning("skipping undecodable tft match").pipe(
            Effect.annotateLogs({ matchId, error }),
            Effect.as(undefined),
          ),
        ),
      );
    });

    const getLeagueEntries = Effect.fn("RiotApi.getLeagueEntries")(function* (
      puuid: Puuid,
      platformId: string,
    ) {
      const shardClient = clients.lol.pipe(
        HttpClient.mapRequest(
          HttpClientRequest.setUrl(
            `https://${platformId}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`,
          ),
        ),
      );
      const res = yield* shardClient.get("");
      return yield* Schema.decodeUnknownEffect(LolLeagueEntries)(
        yield* res.json,
      );
    });

    const getTftLeagueEntries = Effect.fn("RiotApi.getTftLeagueEntries")(
      function* (puuid: Puuid, platformId: string) {
        const shardClient = clients.tft.pipe(
          HttpClient.mapRequest(
            HttpClientRequest.setUrl(
              `https://${platformId}.api.riotgames.com/tft/league/v1/by-puuid/${encodeURIComponent(puuid)}`,
            ),
          ),
        );
        const res = yield* shardClient.get("");
        return yield* Schema.decodeUnknownEffect(TftLeagueEntries)(
          yield* res.json,
        );
      },
    );

    return RiotApiClient.of({
      getAccountByRiotId,
      getPlatformId,
      getMatchIds,
      getLolMatch,
      getTftMatch,
      getLeagueEntries,
      getTftLeagueEntries,
    });
  }),
).pipe(Layer.provide(RiotRateLimiterLive));
