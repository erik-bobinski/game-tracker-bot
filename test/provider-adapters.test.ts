import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  RiotApiClient,
  RiotApiLive,
} from "../src/services/game/game-api/lol/riot-api-client.ts";
import { DevSimulator } from "../src/services/game/dev-simulator.ts";
import { GameAdapters } from "../src/services/game/game-adapters/index.ts";
import { EpochMillis, Puuid } from "../src/services/game/index.ts";
import { configLayer, run, simulatedGameLayer } from "./helpers.ts";

describe("development provider transport and adapters", () => {
  it("discovers NA and EU routes through the production clients", async () => {
    const result = await run(
      Effect.gen(function* () {
        const adapters = yield* GameAdapters;
        const lol = adapters.all.find((adapter) => adapter.game === "lol");
        const val = adapters.all.find((adapter) => adapter.game === "valorant");
        if (!lol || !val) return yield* Effect.die("missing adapters");
        return {
          naLol: yield* lol.resolveAccount("MockAlpha", "NA1"),
          euLol: yield* lol.resolveAccount("MockEuropa", "EUW"),
          naVal: yield* val.resolveAccount("MockAlpha", "NA1"),
          euVal: yield* val.resolveAccount("MockEuropa", "EUW"),
        };
      }).pipe(Effect.provide(simulatedGameLayer())),
    );

    expect(result.naLol.route).toBe("na1");
    expect(result.euLol.route).toBe("euw1");
    expect(result.naVal.route).toBe("na/pc");
    expect(result.euVal.route).toBe("eu/pc");
  });

  it("returns typed not-found behavior for unknown identities", async () => {
    const error = await run(
      Effect.gen(function* () {
        const adapters = yield* GameAdapters;
        const lol = adapters.all.find((adapter) => adapter.game === "lol");
        if (!lol) return yield* Effect.die("missing LoL adapter");
        return yield* Effect.flip(lol.resolveAccount("Unknown", "NOPE"));
      }).pipe(Effect.provide(simulatedGameLayer())),
    );
    expect(error._tag).toBe("AccountNotFound");
  });

  it("never falls through unknown simulator routes to the network", async () => {
    const status = await run(
      Effect.gen(function* () {
        const simulator = yield* DevSimulator;
        return (yield* simulator.httpClient.get("https://example.invalid/nope"))
          .status;
      }).pipe(Effect.provide(simulatedGameLayer())),
    );
    expect(status).toBe(501);
  });

  it("fails malformed provider data at the schema boundary", async () => {
    const malformedClient = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ puuid: 42 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    const layer = RiotApiLive.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, malformedClient)),
      Layer.provide(configLayer(":memory:")),
    );
    const error = await run(
      Effect.gen(function* () {
        const client = yield* RiotApiClient;
        return yield* Effect.flip(
          client.getAccountByRiotId("Malformed", "NA1", "americas"),
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(error._tag).toBe("ProviderError");
    if (error._tag === "ProviderError") {
      expect(error.cause).toHaveProperty("_tag", "SchemaError");
    }
  });

  it("decodes staged raw matches and rank responses", async () => {
    const result = await run(
      Effect.gen(function* () {
        const adapters = yield* GameAdapters;
        const simulator = yield* DevSimulator;
        const accounts = yield* simulator.listAccounts();
        const source = accounts[0];
        if (!source?.lol || !source.valorant) {
          return yield* Effect.die("mock account missing games");
        }
        const now = EpochMillis.make(Date.now() - 1);
        yield* simulator.stageMatch({
          game: "lol",
          result: "victory",
          mode: "ranked",
          surrendered: false,
          duplicate: false,
          players: [
            {
              riotName: source.riotName,
              riotTag: source.riotTag,
              ...source.lol,
            },
          ],
        });
        yield* simulator.stageMatch({
          game: "valorant",
          result: "defeat",
          mode: "ranked",
          surrendered: true,
          duplicate: false,
          players: [
            {
              riotName: source.riotName,
              riotTag: source.riotTag,
              ...source.valorant,
            },
          ],
        });
        const lol = adapters.all.find((adapter) => adapter.game === "lol");
        const val = adapters.all.find((adapter) => adapter.game === "valorant");
        if (!lol || !val) return yield* Effect.die("missing adapters");
        const lolAccount = {
          ...source.lol,
          puuid: Puuid.make(source.lol.puuid),
          trackingStartedAt: now,
        };
        const valAccount = {
          ...source.valorant,
          puuid: Puuid.make(source.valorant.puuid),
          trackingStartedAt: now,
        };
        return {
          lolMatches: yield* lol.getRecentMatches(lolAccount),
          valMatches: yield* val.getRecentMatches(valAccount),
          lolRanks: yield* lol.getRanks(lolAccount),
          valRanks: yield* val.getRanks(valAccount),
          urls: yield* simulator.requestedUrls(),
        };
      }).pipe(Effect.provide(simulatedGameLayer())),
    );

    expect(result.lolMatches).toHaveLength(1);
    expect(result.valMatches).toHaveLength(1);
    expect(result.valMatches[0]?.surrendered).toBe(true);
    expect(result.lolRanks.map((rank) => rank.queueLabel)).toEqual([
      "Ranked Solo/Duo",
      "Ranked Flex",
    ]);
    expect(result.valRanks[0]?.pointsLabel).toBe("38 RR");
    expect(
      result.urls.some((url) => url.includes("na1.api.riotgames.com")),
    ).toBe(true);
    expect(result.urls.some((url) => url.includes("/matches/na/pc/"))).toBe(
      true,
    );
  });
  it("generates restart-safe match IDs and reuses explicit duplicates", async () => {
    const [first, second, duplicate] = await run(
      Effect.gen(function* () {
        const simulator = yield* DevSimulator;
        const source = (yield* simulator.listAccounts())[0];
        if (!source?.lol) return yield* Effect.die("mock LoL account missing");
        const input = {
          game: "lol" as const,
          result: "victory" as const,
          mode: "ranked" as const,
          surrendered: false,
          players: [
            {
              riotName: source.riotName,
              riotTag: source.riotTag,
              ...source.lol,
            },
          ],
        };
        const first = yield* simulator.stageMatch({
          ...input,
          duplicate: false,
        });
        const second = yield* simulator.stageMatch({
          ...input,
          duplicate: false,
        });
        const duplicate = yield* simulator.stageMatch({
          ...input,
          duplicate: true,
        });
        return [first, second, duplicate] as const;
      }).pipe(Effect.provide(simulatedGameLayer())),
    );

    expect(first).toMatch(/^mock-lol-\d+-1$/);
    expect(second).toMatch(/^mock-lol-\d+-2$/);
    expect(second).not.toBe(first);
    expect(duplicate).toBe(second);
  });
});
