import { expect, test } from "bun:test";
import { ConfigProvider, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Database, DatabaseLive } from "../database/index.ts";
import { Discord, DiscordError } from "../discord/index.ts";
import { emptyEnrichment, GameAdapters } from "../game/game-adapters/index.ts";
import { EpochMillis, MatchId, Puuid } from "../game/index.ts";
import { DeliveryQueue, DeliveryQueueLive } from "./index.ts";

const m1 = MatchId.make("m1");
const players = ["one", "two"].map((id) => ({
  discordUserId: id,
  puuid: Puuid.make(`player-${id}`),
  guildIds: ["guild"],
}));

// An in-memory database with both players subscribed in one server, a tft
// adapter that can fetch any match, and a discord that records each post as
// "match:players" and fails while `discord.failing` is set.
const world = () => {
  const posted: Array<string> = [];
  const discord = { failing: false };
  const layer = DeliveryQueueLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        DatabaseLive,
        Layer.succeed(GameAdapters, {
          all: [
            {
              game: "tft",
              requiresOptIn: false,
              iconUrl: "",
              rankIcons: [],
              resolveAccount: () => Effect.die("unused"),
              getRecentMatchIds: () => Effect.die("unused"),
              getMatch: (matchId) =>
                Effect.succeed({
                  kind: "placement",
                  game: "tft",
                  matchId,
                  date: EpochMillis.make(100),
                  mode: "test",
                  durationSeconds: 60,
                  players: [],
                }),
              enrichMatch: ({ match }) =>
                Effect.succeed(emptyEnrichment(match)),
              getRank: () => Effect.succeed(undefined),
            },
          ],
        }),
        Layer.succeed(Discord, {
          application: { name: "test", inviteUrl: "" },
          notifyMatch: (_target, report) =>
            discord.failing
              ? Effect.fail(
                  new DiscordError({ operation: "test", cause: "temporary" }),
                )
              : Effect.sync(() => {
                  posted.push(
                    `${report.match.matchId}:${report.tracked.map((p) => p.discordUserId).join(",")}`,
                  );
                }),
        }),
      ),
    ),
    Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ DB_PATH: ":memory:" })),
    ),
  );

  const run = <A, E>(
    program: Effect.Effect<A, E, DeliveryQueue | Database | SqlClient>,
  ) =>
    Effect.gen(function* () {
      const database = yield* Database;
      for (const { discordUserId, puuid, guildIds } of players) {
        yield* database.addAccount({
          discordUserId,
          discordName: discordUserId,
          riotName: discordUserId,
          riotTag: "test",
          games: {
            tft: {
              puuid,
              reportedMatches: [],
              region: undefined,
              rankSnapshots: {},
            },
          },
          guildIds,
        });
      }
      yield* database.updateGuild("guild", { channelId: "channel" });
      return yield* program;
    }).pipe(Effect.provide(layer), Effect.runPromise);

  return { posted, discord, run };
};

test("a failed post stays queued and is retried on the next poll", async () => {
  const { posted, discord, run } = world();
  await run(
    Effect.gen(function* () {
      const queue = yield* DeliveryQueue;
      yield* queue.queue({ game: "tft", matchId: m1, players });

      discord.failing = true;
      expect(yield* queue.deliver([])).toEqual({
        matchesReported: 0,
        deliveryAttempts: 1,
        deliveriesSucceeded: 0,
      });
      expect((yield* queue.pending()).length).toBe(1);

      discord.failing = false;
      expect((yield* queue.deliver([])).deliveriesSucceeded).toBe(1);
      expect((yield* queue.pending()).length).toBe(0);
      // a server that already got the match isn't posted it again
      expect((yield* queue.deliver([])).deliveryAttempts).toBe(0);
    }),
  );
  expect(posted).toEqual(["m1:one,two"]);
});

test("a day-old delivery is dropped instead of posted", async () => {
  const { posted, discord, run } = world();
  await run(
    Effect.gen(function* () {
      const queue = yield* DeliveryQueue;
      const sql = yield* SqlClient;
      yield* queue.queue({ game: "tft", matchId: m1, players });
      discord.failing = true;
      yield* queue.deliver([]);

      // the channel works again, a day too late
      discord.failing = false;
      yield* sql`UPDATE match_deliveries SET queued_at = datetime('now', '-25 hours')`;
      expect((yield* queue.deliver([])).deliveryAttempts).toBe(0);
      expect((yield* queue.pending()).length).toBe(0);
    }),
  );
  expect(posted).toEqual([]);
});

test("a player removed before the retry is left out of it", async () => {
  const { posted, discord, run } = world();
  await run(
    Effect.gen(function* () {
      const queue = yield* DeliveryQueue;
      const database = yield* Database;
      yield* queue.queue({ game: "tft", matchId: m1, players });
      discord.failing = true;
      yield* queue.deliver([]);

      // "two" signs out before the retry, which then names only "one"
      discord.failing = false;
      yield* database.leaveGuild({ guildId: "guild", discordUserId: "two" });
      expect((yield* queue.deliver([])).deliveriesSucceeded).toBe(1);

      // A /link as another riot account replaces the game row in place, which
      // no trigger sees: the queued identity is caught just before posting,
      // and a delivery with nobody left is dropped unposted.
      yield* queue.queue({
        game: "tft",
        matchId: MatchId.make("m2"),
        players: players.slice(0, 1),
      });
      yield* database.addGame({
        discordUserId: "one",
        game: "tft",
        state: {
          puuid: Puuid.make("another-riot-account"),
          reportedMatches: [],
          region: undefined,
          rankSnapshots: {},
        },
      });
      expect((yield* queue.pending())[0]?.players.length).toBe(1);
      expect((yield* queue.deliver([])).deliveryAttempts).toBe(0);
      expect((yield* queue.pending()).length).toBe(0);
    }),
  );
  expect(posted).toEqual(["m1:one"]);
});
