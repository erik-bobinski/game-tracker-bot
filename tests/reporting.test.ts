import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { registerAccount } from "../src/services/account/index.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ConfigProvider, Effect, Layer, Result } from "effect";
import { Database, DatabaseLive } from "../src/services/database/index.ts";
import { Discord, DiscordError } from "../src/services/discord/index.ts";
import {
  MatchEngine,
  MatchEngineLive,
} from "../src/services/match-engine/index.ts";
import {
  CATCH_UP_MATCH_COUNT,
  GameAdapters,
  RECENT_MATCH_COUNT,
  emptyEnrichment,
  resolveGameState,
  type GameAdapter,
} from "../src/services/game/game-adapters/index.ts";
import {
  EpochMillis,
  MatchId,
  Puuid,
  type MatchDetails,
} from "../src/services/game/index.ts";

// No bot connection, credentials, API calls or production database.
test("deliveries survive restart, newer matches and partial server failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reporting-test-"));
  const puuid = Puuid.make("player-one");
  const secondPuuid = Puuid.make("player-two");
  const posted: string[] = [];
  let failing = true;
  let recent = [MatchId.make("old"), MatchId.make("new")];
  const match = (id: MatchId): MatchDetails => ({
    kind: "placement",
    game: "tft",
    matchId: id,
    date: EpochMillis.make(id === "old" ? 100 : 200),
    mode: "test",
    durationSeconds: 60,
    players: [puuid, secondPuuid].map((id) => ({
      puuid: id,
      riotName: "test",
      riotTag: "test",
      stat: "",
      placement: 1,
      won: true,
    })),
  });
  const adapter: GameAdapter = {
    game: "tft",
    requiresOptIn: false,
    iconUrl: "",
    rankIcons: [],
    resolveAccount: () => Effect.succeed({ puuid, region: undefined }),
    getRecentMatchIds: () => Effect.succeed(recent),
    getMatch: (id) => Effect.succeed(match(id)),
    enrichMatch: ({ match }) => Effect.succeed(emptyEnrichment(match)),
    getRank: () => Effect.succeed(undefined),
  };
  const dependencies = Layer.mergeAll(
    DatabaseLive,
    Layer.succeed(GameAdapters, { all: [adapter] }),
    Layer.succeed(Discord, {
      application: { name: "test", inviteUrl: "" },
      notifyMatch: (target, report) =>
        Effect.gen(function* () {
          if (target.guildId === "b" && failing)
            return yield* Effect.fail(
              new DiscordError({ operation: "test", cause: "temporary" }),
            );
          posted.push(
            `${report.match.matchId}:${target.guildId}:${report.tracked.map((p) => p.discordUserId).join(",")}`,
          );
        }),
    }),
  );
  const live = MatchEngineLive.pipe(Layer.provideMerge(dependencies));
  const run = <A, E>(effect: Effect.Effect<A, E, MatchEngine | Database>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(live),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            DB_PATH: join(directory, "test.sqlite"),
            LEGACY_DB_PATH: "",
          }),
        ),
      ),
    );
  try {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        for (const status of [404, 429, 503]) {
          const request = HttpClientRequest.get(
            "https://example.invalid/account",
          );
          const failure = new HttpClientError.HttpClientError({
            reason: new HttpClientError.StatusCodeError({
              request,
              response: HttpClientResponse.fromWeb(
                request,
                new Response("", { status }),
              ),
            }),
          });
          const result = yield* registerAccount(
            {
              database: db,
              gameAdapters: {
                all: [
                  { ...adapter, resolveAccount: () => Effect.fail(failure) },
                ],
              },
            },
            {
              discordUserId: "lookup",
              discordName: "lookup",
              riotName: "test",
              riotTag: "test",
              guildIds: ["a"],
            },
            [],
          ).pipe(Effect.result);
          if (status === 404)
            assert.deepEqual(result, Result.succeed("not-found"));
          else assert.equal(Result.isFailure(result), true);
          assert.equal(yield* db.getAccount("lookup"), undefined);
        }
        const baseline = yield* resolveGameState(adapter, "test", "test");
        assert.deepEqual(
          baseline.reportedMatches.map((m) => m.matchId),
          recent,
        );
        yield* db.addAccount({
          discordUserId: "baseline",
          discordName: "baseline",
          riotName: "test",
          riotTag: "test",
          guildIds: ["a"],
          games: { tft: baseline },
        });
        yield* db.updateGuild("a", { channelId: "a" });
        assert.equal(
          (yield* (yield* MatchEngine).pollOnce()).deliveryAttempts,
          0,
        );
        yield* db.deleteAccount("baseline");
        for (const [id, p] of [
          ["one", puuid],
          ["two", secondPuuid],
        ] as const) {
          yield* db.addAccount({
            discordUserId: id,
            discordName: id,
            riotName: id,
            riotTag: "test",
            guildIds: ["a", "b"],
            games: {
              tft: {
                puuid: p,
                region: undefined,
                rankSnapshots: {},
                reportedMatches: [],
              },
            },
          });
        }
        yield* db.updateGuild("a", { channelId: "a" });
        yield* db.updateGuild("b", { channelId: "b" });
        const result = yield* (yield* MatchEngine).pollOnce();
        assert.equal(result.deliveryAttempts, 4);
        assert.equal(result.deliveriesSucceeded, 2);
        assert.equal((yield* db.getPendingDeliveries()).length, 2);
      }),
    );
    assert.deepEqual(posted, ["old:a:one,two", "new:a:one,two"]);
    // New layer/database connection, and neither match is in the recent API list.
    recent = [];
    failing = false;
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.updateGuild("b", { paused: true });
        assert.equal(
          (yield* (yield* MatchEngine).pollOnce()).deliveryAttempts,
          0,
        );
        assert.equal((yield* db.getPendingDeliveries()).length, 2);
        yield* db.updateGuild("b", { paused: false });
        const result = yield* (yield* MatchEngine).pollOnce();
        assert.equal(result.deliveriesSucceeded, 2);
        assert.equal(
          (yield* (yield* Database).getPendingDeliveries()).length,
          0,
        );
      }),
    );
    const delivered = [
      "old:a:one,two",
      "new:a:one,two",
      "old:b:one,two",
      "new:b:one,two",
    ];
    assert.deepEqual(posted, delivered);
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        // A rediscovery cannot reopen a completed destination.
        yield* db.queueDelivery({
          game: "tft",
          matchId: MatchId.make("old"),
          guildId: "a",
          players: [{ discordUserId: "one", puuid }],
        });
        assert.equal((yield* db.getPendingDeliveries()).length, 0);
        yield* db.queueDelivery({
          game: "tft",
          matchId: MatchId.make("cancelled"),
          guildId: "b",
          players: [{ discordUserId: "one", puuid }],
        });
        yield* db.removeGames({ discordUserId: "one", games: ["tft"] });
        assert.deepEqual((yield* db.getPendingDeliveries())[0]?.players, []);
        const result = yield* (yield* MatchEngine).pollOnce();
        assert.equal(result.deliveryAttempts, 0);
        assert.equal((yield* db.getPendingDeliveries()).length, 0);
        yield* db.queueDelivery({
          game: "tft",
          matchId: MatchId.make("signout"),
          guildId: "b",
          players: [{ discordUserId: "two", puuid: secondPuuid }],
        });
        yield* db.leaveGuild({ guildId: "b", discordUserId: "two" });
        assert.deepEqual((yield* db.getPendingDeliveries())[0]?.players, []);
      }),
    );
    // A >1 day outage: every row is backdated, the pending one still posts
    // (to the remaining subscriber only) and the old completed key still stops
    // a newly tracked player with no history from reposting a shared match.
    const raw = new DatabaseSync(join(directory, "test.sqlite"));
    raw.exec(`INSERT INTO match_deliveries (game, match_id, guild_id, players)
      VALUES ('tft', 'stale', 'a', '[{"discordUserId":"one","puuid":"player-one"},{"discordUserId":"two","puuid":"player-two"}]')`);
    raw.exec(`UPDATE match_deliveries SET queued_at = '2000-01-01 00:00:00'`);
    raw.close();
    recent = [MatchId.make("old")];
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.addAccount({
          discordUserId: "three",
          discordName: "three",
          riotName: "three",
          riotTag: "test",
          guildIds: ["a"],
          games: {
            tft: {
              puuid: Puuid.make("player-three"),
              region: undefined,
              rankSnapshots: {},
              reportedMatches: [],
            },
          },
        });
        const result = yield* (yield* MatchEngine).pollOnce();
        assert.equal(result.deliveryAttempts, 1);
        assert.equal((yield* db.getPendingDeliveries()).length, 0);
        assert.deepEqual(
          (yield* db.getAccount("three"))?.games.tft?.reportedMatches.map(
            (m) => m.matchId,
          ),
          ["old"],
        );
      }),
    );
    assert.deepEqual(posted, [...delivered, "stale:a:two"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("catch-up posts a bounded backlog and pins live rank movement to the newest match", async () => {
  const directory = mkdtempSync(join(tmpdir(), "catch-up-test-"));
  const puuid = Puuid.make("player-one");
  // newest first, as the apis list them
  const history = ["m7", "m6", "m5", "m4", "m3", "m2", "m1"].map((id) =>
    MatchId.make(id),
  );
  const counts: number[] = [];
  const posted: string[] = [];
  const adapter: GameAdapter = {
    game: "tft",
    requiresOptIn: false,
    iconUrl: "",
    rankIcons: [],
    resolveAccount: () => Effect.succeed({ puuid, region: undefined }),
    getRecentMatchIds: (_puuid, _region, count) => {
      counts.push(count);
      return Effect.succeed(history.slice(0, count));
    },
    getMatch: (id) =>
      Effect.succeed({
        kind: "placement",
        game: "tft",
        matchId: id,
        date: EpochMillis.make(Number(id.slice(1)) * 100),
        mode: "test",
        durationSeconds: 60,
        players: [
          {
            puuid,
            riotName: "one",
            riotTag: "test",
            stat: "",
            placement: 1,
            won: true,
          },
        ],
      }),
    // like lol and tft: the live rank diffed against the last saved one
    enrichMatch: ({ match, trackedPlayers }) =>
      Effect.succeed({
        match,
        rankUpdates: new Map(
          trackedPlayers.map((p) => [p.puuid, { delta: 40, unit: "LP" }]),
        ),
        updatedRankSnapshots: new Map(
          trackedPlayers.map((p) => [
            p.puuid,
            { RANKED_TFT: { standing: "Gold I", points: 40 } },
          ]),
        ),
      }),
    getRank: () => Effect.succeed(undefined),
  };
  const live = MatchEngineLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        DatabaseLive,
        Layer.succeed(GameAdapters, { all: [adapter] }),
        Layer.succeed(Discord, {
          application: { name: "test", inviteUrl: "" },
          notifyMatch: (_target, report) =>
            Effect.sync(() => {
              const update = report.rankUpdates.get(puuid);
              posted.push(
                `${report.match.matchId}${update ? `:${update.delta}:${update.sinceLastCheck}` : ""}`,
              );
            }),
        }),
      ),
    ),
  );
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Database;
        const engine = yield* MatchEngine;
        yield* db.addAccount({
          discordUserId: "one",
          discordName: "one",
          riotName: "one",
          riotTag: "test",
          guildIds: ["a"],
          games: {
            tft: {
              puuid,
              region: undefined,
              rankSnapshots: {},
              // m1 is the last match reported before the outage
              reportedMatches: [
                { matchId: history[6]!, date: EpochMillis.make(100) },
              ],
            },
          },
        });
        yield* db.updateGuild("a", { channelId: "a" });

        // first poll after boot looks back further, posts the newest five
        // missed matches oldest first, and skips m2
        yield* engine.pollOnce();
        assert.deepEqual(posted, ["m3", "m4", "m5", "m6", "m7:40:true"]);
        assert.deepEqual(
          (yield* db.getAccount("one"))?.games.tft?.rankSnapshots,
          { RANKED_TFT: { standing: "Gold I", points: 40 } },
        );

        // the next poll is a normal one, and m2 stays skipped
        yield* engine.pollOnce();
        assert.deepEqual(counts, [CATCH_UP_MATCH_COUNT, RECENT_MATCH_COUNT]);
        assert.equal(posted.length, 5);
      }).pipe(
        Effect.provide(live),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            DB_PATH: join(directory, "test.sqlite"),
            LEGACY_DB_PATH: "",
          }),
        ),
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
