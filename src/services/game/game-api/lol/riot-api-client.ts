import {
  Config,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as Headers from "effect/unstable/http/Headers";
import { Puuid } from "../../index.ts";
import {
  LolLeagueEntries,
  LolMatch,
  LolMatchIds,
} from "../lol/match-schema.ts";
import {
  TftLeagueEntries,
  TftMatch,
  TftMatchIds,
} from "../tft/match-schema.ts";

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
      game: "lol" | "tft",
      puuid: Puuid,
    ) => Effect.Effect<
      string,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    getLolRecentMatches: (
      puuid: Puuid,
      platformId: string | undefined,
      count: number,
    ) => Effect.Effect<
      ReadonlyArray<LolMatch>,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    getTftRecentMatches: (
      puuid: Puuid,
      platformId: string | undefined,
      count: number,
    ) => Effect.Effect<
      ReadonlyArray<TftMatch>,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
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
      HttpClient.retryTransient({
        times: 5,
        schedule: Schedule.exponential("1 second").pipe(
          Schedule.modifyDelay(({ duration, input }) => {
            const header =
              HttpClientError.isHttpClientError(input) &&
              input.response !== undefined
                ? Option.getOrUndefined(
                    Headers.get(input.response.headers, "retry-after"),
                  )
                : undefined;
            const seconds = Number(header);
            const wait =
              Number.isFinite(seconds) && seconds > 0
                ? Duration.min(Duration.seconds(seconds), Duration.seconds(15))
                : Duration.zero;
            return Effect.succeed(Duration.max(duration, wait));
          }),
          Schedule.jittered,
        ),
      }),
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

    const getPlatformId = Effect.fn("RiotApi.getPlatformId")(function* (
      game: "lol" | "tft",
      puuid: Puuid,
    ) {
      const res = yield* client.get(
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

    const getLolMatch = Effect.fn("RiotApi.getLolMatch")(function* (
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

    const getTftMatch = Effect.fn("RiotApi.getTftMatch")(function* (
      matchId: string,
      platformId: string | undefined,
    ) {
      const res = yield* matchGet(
        platformId,
        `/tft/match/v1/matches/${matchId}`,
      );
      const json = yield* res.json;
      return yield* Schema.decodeUnknownEffect(TftMatch)(json);
    });

    // Match-V5 has no bulk endpoint: fetch ids, then one call per match.
    const getLolRecentMatches = Effect.fn("RiotApi.getLolRecentMatches")(
      function* (puuid: Puuid, platformId: string | undefined, count: number) {
        const res = yield* matchGet(
          platformId,
          `/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?count=${count}`,
        );
        const json = yield* res.json;
        const matchIds = yield* Schema.decodeUnknownEffect(LolMatchIds)(json);

        const matches = yield* Effect.forEach(matchIds, (matchId) =>
          getLolMatch(matchId, platformId).pipe(
            Effect.catchTag("SchemaError", (error) =>
              Effect.logWarning("skipping undecodable lol match").pipe(
                Effect.annotateLogs({ matchId, error }),
                Effect.as(undefined),
              ),
            ),
          ),
        );

        return matches.filter((match) => match !== undefined);
      },
    );

    const getTftRecentMatches = Effect.fn("RiotApi.getTftRecentMatches")(
      function* (puuid: Puuid, platformId: string | undefined, count: number) {
        const res = yield* matchGet(
          platformId,
          `/tft/match/v1/matches/by-puuid/${encodeURIComponent(puuid)}/ids?count=${count}`,
        );
        const json = yield* res.json;
        const matchIds = yield* Schema.decodeUnknownEffect(TftMatchIds)(json);

        const matches = yield* Effect.forEach(matchIds, (matchId) =>
          getTftMatch(matchId, platformId).pipe(
            Effect.catchTag("SchemaError", (error) =>
              Effect.logWarning("skipping undecodable tft match").pipe(
                Effect.annotateLogs({ matchId, error }),
                Effect.as(undefined),
              ),
            ),
          ),
        );

        return matches.filter((match) => match !== undefined);
      },
    );

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

    const getTftLeagueEntries = Effect.fn("RiotApi.getTftLeagueEntries")(
      function* (puuid: Puuid, platformId: string) {
        const shardClient = client.pipe(
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
      getLolRecentMatches,
      getTftRecentMatches,
      getLeagueEntries,
      getTftLeagueEntries,
    });
  }),
);
