import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { Puuid } from "../../index.ts";
import { LolLeagueEntries, LolMatch, LolMatchIds } from "./match-schema.ts";

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
    getPlatformId: (
      puuid: Puuid,
    ) => Effect.Effect<
      string,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    getRecentMatches: (
      puuid: Puuid,
      platformId: string | undefined,
      count: number,
    ) => Effect.Effect<
      ReadonlyArray<LolMatch>,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    getLeagueEntries: (
      puuid: Puuid,
      platformId: string,
    ) => Effect.Effect<
      typeof LolLeagueEntries.Type,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
  }
>()("app/RiotApiClient") {}

export const RiotApiLive = Layer.effect(
  RiotApiClient,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("RIOT_API_KEY");
    // account-v1 answers for any account from any cluster, so this only picks
    // the nearest one; per-account routing comes from the stored platformId
    const defaultCluster = yield* Config.string("RIOT_REGION").pipe(
      Config.withDefault("americas"),
    );
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        HttpClientRequest.prependUrl(
          `https://${defaultCluster}.api.riotgames.com`,
        ),
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

    // the shard a player is active on (na1, euw1, ...), which league-v4 is
    // routed by; account-v1 answers this from any cluster
    const getPlatformId = Effect.fn("RiotApi.getPlatformId")(function* (
      puuid: Puuid,
    ) {
      const res = yield* client.get(
        `/riot/account/v1/region/by-game/lol/by-puuid/${encodeURIComponent(puuid)}`,
      );
      const json = yield* res.json;
      const { region } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ region: Schema.String }),
      )(json);
      return region.toLowerCase();
    });

    // an unknown shard falls back to the configured cluster, which is right
    // as long as the account plays there
    const matchGet = (platformId: string | undefined, path: string) => {
      const cluster =
        (platformId ? CLUSTERS[platformId] : undefined) ?? defaultCluster;
      return client
        .pipe(
          HttpClient.mapRequest(
            HttpClientRequest.setUrl(
              `https://${cluster}.api.riotgames.com${path}`,
            ),
          ),
        )
        .get("");
    };

    const getMatch = Effect.fn("RiotApi.getMatch")(function* (
      matchId: string,
      platformId: string | undefined,
    ) {
      const res = yield* matchGet(
        platformId,
        `/lol/match/v5/matches/${matchId}`,
      );
      const json = yield* res.json;
      return yield* Schema.decodeUnknownEffect(LolMatch)(json);
    });

    // Match-V5 has no bulk endpoint: fetch ids, then one call per match.
    const getRecentMatches = Effect.fn("RiotApi.getRecentMatches")(function* (
      puuid: Puuid,
      platformId: string | undefined,
      count: number,
    ) {
      const res = yield* matchGet(
        platformId,
        `/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?count=${count}`,
      );
      const json = yield* res.json;
      const matchIds = yield* Schema.decodeUnknownEffect(LolMatchIds)(json);

      const matches = yield* Effect.forEach(matchIds, (matchId) =>
        getMatch(matchId, platformId).pipe(
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

    const getLeagueEntries = Effect.fn("RiotApi.getLeagueEntries")(function* (
      puuid: Puuid,
      platformId: string,
    ) {
      const shardClient = client.pipe(
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

    return RiotApiClient.of({
      getAccountByRiotId,
      getPlatformId,
      getRecentMatches,
      getLeagueEntries,
    });
  }),
);
