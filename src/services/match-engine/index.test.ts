import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Layer } from "effect";
import { Database, DatabaseLive } from "../database/index.ts";
import type { MatchReport } from "../discord/embed.ts";
import { Discord } from "../discord/index.ts";
import {
  emptyEnrichment,
  GameAdapters,
  GameApiError,
} from "../game/game-adapters/index.ts";
import {
  EpochMillis,
  MatchId,
  Puuid,
  type VersusMatch,
} from "../game/index.ts";
import { MatchEngine, MatchEngineLive } from "./index.ts";

const alice = Puuid.make("alice");
const bob = Puuid.make("bob");

const match = (
  id: string,
  date: number,
  players: ReadonlyArray<Puuid>,
): VersusMatch => ({
  kind: "versus",
  matchId: MatchId.make(id),
  game: "lol",
  date: EpochMillis.make(date),
  mode: "Ranked Solo/Duo",
  durationSeconds: 1_800,
  surrendered: false,
  teams: [],
  players: players.map((puuid) => ({
    puuid,
    // the saved riot id, so no poll renames anyone
    riotName: puuid,
    riotTag: "na1",
    stat: "",
    team: "100",
    character: "Ahri",
    kills: 1,
    deaths: 1,
    assists: 1,
    sortKey: 1,
  })),
});

// A lol adapter answering from `recent` and `matches`, which a test changes
// between polls, and a discord that records what it would have posted. An
// account with no entry in `recent` fails its lookup.
const world = (
  recent: Map<Puuid, ReadonlyArray<MatchId>>,
  matches: Array<VersusMatch>,
) => {
  const posts: Array<MatchReport> = [];
  const layer = MatchEngineLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(
          GameAdapters,
          GameAdapters.of({
            all: [
              {
                game: "lol",
                requiresOptIn: false,
                iconUrl: "",
                rankIcons: [],
                resolveAccount: () => Effect.die("unused"),
                getRecentMatchIds: (puuid) => {
                  const ids = recent.get(puuid);
                  return ids
                    ? Effect.succeed(ids)
                    : Effect.fail(
                        new GameApiError({
                          game: "lol",
                          operation: "getRecentMatchIds",
                          cause: "riot is down",
                        }),
                      );
                },
                getMatch: (matchId) =>
                  Effect.succeed(
                    matches.find((candidate) => candidate.matchId === matchId),
                  ),
                enrichMatch: ({ match }) =>
                  Effect.succeed(emptyEnrichment(match)),
                getRank: () => Effect.succeed(undefined),
              },
            ],
          }),
        ),
        Layer.succeed(
          Discord,
          Discord.of({
            notifyMatch: (_target, report) =>
              Effect.sync(() => {
                posts.push(report);
              }),
            application: { name: "test", inviteUrl: "" },
          }),
        ),
        DatabaseLive,
      ),
    ),
    Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ DB_PATH: ":memory:" })),
    ),
  );

  const run = <A, E>(program: Effect.Effect<A, E, MatchEngine | Database>) =>
    Effect.gen(function* () {
      const database = yield* Database;
      for (const puuid of [alice, bob]) {
        yield* database.addAccount({
          discordUserId: puuid,
          discordName: puuid,
          riotName: puuid,
          riotTag: "na1",
          games: {
            lol: {
              puuid,
              reportedMatches: [],
              region: "na1",
              rankSnapshots: {},
            },
          },
          guildIds: ["guild"],
        });
      }
      yield* database.updateGuild("guild", { channelId: "channel" });
      return yield* program;
    }).pipe(Effect.provide(layer), Effect.runPromise);

  return { posts, run };
};

const poll = Effect.gen(function* () {
  const engine = yield* MatchEngine;
  return yield* engine.pollOnce();
});

const reportedPlayers = (report: MatchReport | undefined) =>
  report?.tracked.map((player) => player.puuid).toSorted();

describe("MatchEngine.pollOnce", () => {
  test("reports a new match once", async () => {
    const m1 = MatchId.make("m1");
    const { posts, run } = world(
      new Map([
        [alice, [m1]],
        [bob, []],
      ]),
      [match("m1", 1_000, [alice])],
    );
    await run(Effect.andThen(poll, poll));
    expect(posts.length).toBe(1);
    expect(reportedPlayers(posts[0])).toEqual([alice]);
  });

  test("a match two tracked players were in is one report naming both", async () => {
    const m1 = MatchId.make("m1");
    const { posts, run } = world(
      new Map([
        [alice, [m1]],
        [bob, [m1]],
      ]),
      [match("m1", 1_000, [alice, bob])],
    );
    await run(poll);
    expect(posts.length).toBe(1);
    expect(reportedPlayers(posts[0])).toEqual([alice, bob]);
  });

  test("takes in a tracked player whose match list hasn't caught up", async () => {
    const m1 = MatchId.make("m1");
    const recent = new Map([
      [alice, [m1]],
      [bob, []],
    ]);
    const { posts, run } = world(recent, [match("m1", 1_000, [alice, bob])]);
    await run(
      Effect.gen(function* () {
        yield* poll;
        // bob's list catching up later doesn't post it again
        recent.set(bob, [m1]);
        yield* poll;
      }),
    );
    expect(posts.length).toBe(1);
    expect(reportedPlayers(posts[0])).toEqual([alice, bob]);
  });

  test("a failed lookup is retried on the next poll", async () => {
    const m1 = MatchId.make("m1");
    const recent = new Map<Puuid, ReadonlyArray<MatchId>>([[bob, []]]);
    const { posts, run } = world(recent, [match("m1", 1_000, [alice])]);
    await run(
      Effect.gen(function* () {
        yield* poll;
        expect(posts.length).toBe(0);
        recent.set(alice, [m1]);
        yield* poll;
      }),
    );
    expect(posts.length).toBe(1);
  });

  test("skips a match older than the newest one already reported", async () => {
    const m1 = MatchId.make("m1");
    const m2 = MatchId.make("m2");
    const recent = new Map([
      [alice, [m2]],
      [bob, []],
    ]);
    const { posts, run } = world(recent, [
      match("m1", 1_000, [alice]),
      match("m2", 2_000, [alice]),
    ]);
    await run(
      Effect.gen(function* () {
        yield* poll;
        // riot listing an older game late
        recent.set(alice, [m2, m1]);
        yield* poll;
      }),
    );
    expect(posts.map((post) => post.match.matchId)).toEqual([m2]);
  });
});
