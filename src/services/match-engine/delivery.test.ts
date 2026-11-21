import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { registerAccount } from "../account/index.ts";
import { Database as Sqlite } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ConfigProvider, Effect, Layer, Result } from "effect";
import { Database, DatabaseLive } from "../database/index.ts";
import { DeliveryQueue, DeliveryQueueLive } from "../delivery-queue/index.ts";
import { Discord, DiscordError } from "../discord/index.ts";
import { MatchEngine, MatchEngineLive } from "./index.ts";
import {
  CATCH_UP_MATCH_COUNT,
  GameAdapters,
  RECENT_MATCH_COUNT,
  emptyEnrichment,
  resolveGameState,
  type GameAdapter,
} from "../game/game-adapters/index.ts";
import {
  EpochMillis,
  MatchId,
  Puuid,
  type MatchDetails,
} from "../game/index.ts";

// No bot connection, credentials, API calls or production database.
test("deliveries survive restart, newer matches and partial server failure", async () => {
  const dbPath = `${Bun.env.TMPDIR ?? "/tmp"}/reporting-test-${crypto.randomUUID()}.sqlite`;
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
  const live = MatchEngineLive.pipe(
    Layer.provideMerge(DeliveryQueueLive),
    Layer.provideMerge(dependencies),
  );
  const run = <A, E>(
    effect: Effect.Effect<A, E, MatchEngine | DeliveryQueue | Database>,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(live),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            DB_PATH: dbPath,
            LEGACY_DB_PATH: "",
          }),
        ),
      ),
    );
  try {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const queue = yield* DeliveryQueue;
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
            expect(result).toEqual(Result.succeed("not-found"));
          else expect(Result.isFailure(result)).toBe(true);
          expect(yield* db.getAccount("lookup")).toBe(undefined);
        }
        const baseline = yield* resolveGameState(adapter, "test", "test");
        expect(baseline.reportedMatches.map((m) => m.matchId)).toEqual(recent);
        yield* db.addAccount({
          discordUserId: "baseline",
          discordName: "baseline",
          riotName: "test",
          riotTag: "test",
          guildIds: ["a"],
          games: { tft: baseline },
        });
        yield* db.updateGuild("a", { channelId: "a" });
        expect((yield* (yield* MatchEngine).pollOnce()).deliveryAttempts).toBe(
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
        expect(result.deliveryAttempts).toBe(4);
        expect(result.deliveriesSucceeded).toBe(2);
        expect((yield* queue.pending()).length).toBe(2);
      }),
    );
    expect(posted).toEqual(["old:a:one,two", "new:a:one,two"]);
    // New layer/database connection, and neither match is in the recent API list.
    recent = [];
    failing = false;
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const queue = yield* DeliveryQueue;
        yield* db.updateGuild("b", { paused: true });
        expect((yield* (yield* MatchEngine).pollOnce()).deliveryAttempts).toBe(
          0,
        );
        expect((yield* queue.pending()).length).toBe(2);
        yield* db.updateGuild("b", { paused: false });
        const result = yield* (yield* MatchEngine).pollOnce();
        expect(result.deliveriesSucceeded).toBe(2);
        expect((yield* queue.pending()).length).toBe(0);
      }),
    );
    const delivered = [
      "old:a:one,two",
      "new:a:one,two",
      "old:b:one,two",
      "new:b:one,two",
    ];
    expect(posted).toEqual(delivered);
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const queue = yield* DeliveryQueue;
        // a server removed mid-poll is skipped rather than failing the poll
        yield* queue.queue({
          game: "tft",
          matchId: MatchId.make("old"),
          players: [{ discordUserId: "one", puuid, guildIds: ["gone"] }],
        });
        expect((yield* queue.pending()).length).toBe(0);
        yield* queue.queue({
          game: "tft",
          matchId: MatchId.make("cancelled"),
          players: [{ discordUserId: "one", puuid, guildIds: ["b"] }],
        });
        yield* db.removeGames({ discordUserId: "one", games: ["tft"] });
        expect((yield* queue.pending())[0]?.players).toEqual([]);
        const result = yield* (yield* MatchEngine).pollOnce();
        expect(result.deliveryAttempts).toBe(0);
        expect((yield* queue.pending()).length).toBe(0);
        yield* queue.queue({
          game: "tft",
          matchId: MatchId.make("signout"),
          players: [
            { discordUserId: "two", puuid: secondPuuid, guildIds: ["b"] },
          ],
        });
        yield* db.leaveGuild({ guildId: "b", discordUserId: "two" });
        expect((yield* queue.pending())[0]?.players).toEqual([]);
      }),
    );
    // Re-subscribe before the empty cancelled row is drained. Discovery must
    // replace it rather than advance history without delivering the match.
    recent = [MatchId.make("signout")];
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const queue = yield* DeliveryQueue;
        yield* db.subscribe({ guildId: "b", discordUserId: "two" });
        yield* db.addGame({
          discordUserId: "two",
          game: "tft",
          state: {
            puuid: secondPuuid,
            region: undefined,
            rankSnapshots: {},
            reportedMatches: [],
          },
        });
        const result = yield* (yield* MatchEngine).pollOnce();
        expect(result.deliveriesSucceeded).toBe(2);
        expect((yield* queue.pending()).length).toBe(0);
      }),
    );
    delivered.push("signout:b:two", "signout:a:two");
    expect(posted).toEqual(delivered);
    // A day-old row is dropped instead of posted, and with no history kept
    // for finished deliveries, a player with an emptied history (/dev_clear)
    // gets a shared match reported again.
    const raw = new Sqlite(dbPath);
    raw.run(`INSERT INTO match_deliveries (game, match_id, guild_id, players)
      VALUES ('tft', 'stale', 'a', '[{"discordUserId":"one","puuid":"player-one"},{"discordUserId":"two","puuid":"player-two"}]')`);
    raw.run(`UPDATE match_deliveries SET queued_at = '2000-01-01 00:00:00'`);
    raw.close();
    recent = [MatchId.make("old")];
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const queue = yield* DeliveryQueue;
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
        expect(result.deliveryAttempts).toBe(1);
        expect((yield* queue.pending()).length).toBe(0);
        expect(
          (yield* db.getAccount("three"))?.games.tft?.reportedMatches.map(
            (m) => m.matchId,
          ),
        ).toEqual([MatchId.make("old")]);
      }),
    );
    expect(posted).toEqual([...delivered, "old:a:three"]);
  } finally {
    await Bun.file(dbPath).delete();
  }
});

test("catch-up posts a bounded backlog after downtime", async () => {
  const dbPath = `${Bun.env.TMPDIR ?? "/tmp"}/catch-up-test-${crypto.randomUUID()}.sqlite`;
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
    enrichMatch: ({ match }) => Effect.succeed(emptyEnrichment(match)),
    getRank: () => Effect.succeed(undefined),
  };
  const live = MatchEngineLive.pipe(
    Layer.provide(DeliveryQueueLive),
    Layer.provideMerge(
      Layer.mergeAll(
        DatabaseLive,
        Layer.succeed(GameAdapters, { all: [adapter] }),
        Layer.succeed(Discord, {
          application: { name: "test", inviteUrl: "" },
          notifyMatch: (_target, report) =>
            Effect.sync(() => {
              posted.push(report.match.matchId);
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
        expect(posted).toEqual(["m3", "m4", "m5", "m6", "m7"]);

        // the next poll is a normal one, and m2 stays skipped
        yield* engine.pollOnce();
        expect(counts).toEqual([CATCH_UP_MATCH_COUNT, RECENT_MATCH_COUNT]);
        expect(posted.length).toBe(5);
      }).pipe(
        Effect.provide(live),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            DB_PATH: dbPath,
            LEGACY_DB_PATH: "",
          }),
        ),
      ),
    );
  } finally {
    await Bun.file(dbPath).delete();
  }
});
