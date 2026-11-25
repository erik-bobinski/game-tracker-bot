import { Database as Sqlite } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { Database, DatabaseLive } from "../database/index.ts";
import { Discord } from "../discord/index.ts";
import {
  emptyEnrichment,
  GameAdapters,
  GameApiError,
  type GameAdapter,
} from "../game/game-adapters/index.ts";
import {
  EpochMillis,
  MatchId,
  Puuid,
  type MatchDetails,
} from "../game/index.ts";
import { MatchEngine, MatchEngineLive } from "./index.ts";

// The import only adds matches a server would have been posted: played after
// that player signed up there, in a server with a report channel.
test("history import saves pre-website matches since each signup", async () => {
  const dbPath = `${Bun.env.TMPDIR ?? "/tmp"}/history-import-test-${crypto.randomUUID()}.sqlite`;
  const day = 86_400_000;
  // alice signed up in a long ago and in b just now; bob in a just now
  const dates = new Map([
    ["ancient", Date.parse("2019-01-01")],
    ["lastYear", Date.now() - 365 * day],
    ["soon", Date.now() + day],
    ["solo", Date.now() + day],
    ["later", Date.now() + 2 * day],
  ]);
  const players = {
    alice: ["ancient", "lastYear", "soon"],
    bob: ["soon", "solo"],
  };
  let failing = true;
  const match = (id: MatchId): MatchDetails => ({
    kind: "placement",
    game: "tft",
    matchId: id,
    date: EpochMillis.make(dates.get(id) ?? 0),
    mode: "test",
    durationSeconds: 60,
    players: Object.entries(players)
      .filter(([, ids]) => ids.includes(id))
      .map(([name]) => ({
        puuid: Puuid.make(name),
        riotName: name,
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
    resolveAccount: () => Effect.die("unused"),
    getRecentMatchIds: (puuid) =>
      puuid === "bob" && failing
        ? Effect.fail(
            new GameApiError({
              game: "tft",
              operation: "test",
              cause: "down",
            }),
          )
        : Effect.succeed(
            (players[puuid === "bob" ? "bob" : "alice"] ?? []).map((id) =>
              MatchId.make(id),
            ),
          ),
    getMatch: (id) => Effect.succeed(match(id)),
    enrichMatch: ({ match }) => Effect.succeed(emptyEnrichment(match)),
    getRank: () => Effect.succeed(undefined),
  };
  const live = MatchEngineLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        DatabaseLive,
        Layer.succeed(GameAdapters, { all: [adapter] }),
        Layer.succeed(Discord, {
          notifyMatch: () => Effect.die("the import never posts"),
          getAvatarUrl: (id) => Effect.succeed(id),
          getServer: () => Effect.succeed(Option.none()),
          application: { id: "", name: "test", inviteUrl: "" },
        }),
      ),
    ),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, MatchEngine | Database>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(live),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ DB_PATH: dbPath, LEGACY_DB_PATH: "" }),
        ),
      ),
    );
  const raw = () => new Sqlite(dbPath);
  // match history as match:server:player posts
  const posts = () => {
    const db = raw();
    const rows = db
      .query<{ post: string }, []>(
        `SELECT match_id || ':' || guild_id || ':' || discord_user_id AS post
        FROM match_posts ORDER BY post`,
      )
      .all()
      .map((row) => row.post);
    db.close();
    return rows;
  };

  try {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        for (const [name, guildIds] of [
          ["alice", ["a", "b", "silent"]],
          ["bob", ["a"]],
        ] as const) {
          yield* db.addAccount({
            discordUserId: name,
            discordName: name,
            riotName: name,
            riotTag: "test",
            guildIds,
            games: {
              tft: {
                puuid: Puuid.make(name),
                region: undefined,
                rankSnapshots: {},
                reportedMatches: [],
              },
            },
          });
        }
        // "silent" never picked a report channel, so nothing posted there
        yield* db.updateGuild("a", { channelId: "a" });
        yield* db.updateGuild("b", { channelId: "b" });
        // a report waiting to post survives the import
        yield* db.queueDelivery({
          game: "tft",
          matchId: MatchId.make("soon"),
          guildId: "b",
          players: [{ discordUserId: "alice", puuid: Puuid.make("alice") }],
        });
      }),
    );
    const db = raw();
    db.run(`UPDATE guild_accounts SET created_at = '2020-01-01 00:00:00'
      WHERE guild_id = 'a' AND discord_user_id = 'alice'`);
    db.close();

    // bob's list is down: the match he shared with alice still comes through
    // hers, his solo one waits for the next start
    await run(
      Effect.gen(function* () {
        yield* (yield* MatchEngine).importHistory();
        expect(yield* (yield* Database).getHistoryImported()).toBe(false);
      }),
    );
    expect(posts()).toEqual([
      "lastYear:a:alice",
      "soon:a:alice",
      "soon:a:bob",
      "soon:b:alice",
    ]);

    failing = false;
    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* (yield* MatchEngine).importHistory();
        expect(yield* database.getHistoryImported()).toBe(true);
        expect((yield* database.getPendingDeliveries()).length).toBe(1);
      }),
    );
    const imported = [
      "lastYear:a:alice",
      "solo:a:bob",
      "soon:a:alice",
      "soon:a:bob",
      "soon:b:alice",
    ];
    expect(posts()).toEqual(imported);

    // done once, so a later start fetches nothing
    players.alice.push("later");
    await run(
      Effect.gen(function* () {
        yield* (yield* MatchEngine).importHistory();
      }),
    );
    expect(posts()).toEqual(imported);
  } finally {
    await Bun.file(dbPath).delete();
  }
});
