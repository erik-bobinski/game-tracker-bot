import { BunHttpServer } from "@effect/platform-bun";
import { expect, test } from "bun:test";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { Base64Url } from "effect/encoding";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Database, DatabaseLive } from "../database/index.ts";
import { Discord } from "../discord/index.ts";
import {
  EpochMillis,
  MatchId,
  Puuid,
  type GameId,
  type MatchDetails,
} from "../game/index.ts";
import { SiteApi } from "./api.ts";
import { FeedLive } from "./feed.ts";
import { SignedInLive } from "./sign-in.ts";

// The feed is the website's privacy boundary: a session sees only reports
// posted in servers its player is tracked in.
test("the feed shows a viewer only their servers' reports", async () => {
  const dbPath = `${Bun.env.TMPDIR ?? "/tmp"}/feed-test-${crypto.randomUUID()}.sqlite`;
  const database = DatabaseLive.pipe(
    Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ DB_PATH: dbPath })),
    ),
  );
  const match = (game: GameId, id: string, date: number): MatchDetails => ({
    kind: "placement",
    game,
    matchId: MatchId.make(id),
    date: EpochMillis.make(date),
    mode: "test",
    durationSeconds: 60,
    players: [],
  });
  // the session cookie's token, stored as its sha-256 like sign-in does
  const token = "alice-session";
  const tokenHash = Base64Url.encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
  );

  try {
    await Effect.gen(function* () {
      const db = yield* Database;
      // alice is in a and b, bob in a, carol only in c
      for (const [id, guildIds] of [
        ["alice", ["a", "b"]],
        ["bob", ["a"]],
        ["carol", ["c"]],
      ] as const) {
        yield* db.addAccount({
          discordUserId: id,
          discordName: id,
          riotName: id,
          riotTag: "test",
          guildIds,
          games: {
            tft: {
              puuid: Puuid.make(id),
              region: undefined,
              rankSnapshots: {},
              reportedMatches: [],
            },
            lol: {
              puuid: Puuid.make(id),
              region: undefined,
              rankSnapshots: {},
              reportedMatches: [],
            },
          },
        });
      }
      const post = (
        game: GameId,
        id: string,
        date: number,
        guildId: string,
        players: ReadonlyArray<string>,
      ) =>
        db.finishDelivery(
          { game, matchId: MatchId.make(id), guildId },
          {
            match: match(game, id, date),
            players: players.map((player) => ({
              discordUserId: player,
              puuid: Puuid.make(player),
              rankUpdate: undefined,
            })),
          },
        );
      yield* post("tft", "shared", 100, "a", ["alice", "bob"]);
      yield* post("tft", "shared", 100, "b", ["alice"]);
      yield* post("lol", "bobs", 200, "a", ["bob"]);
      yield* post("tft", "elsewhere", 300, "c", ["carol"]);
      yield* db.createSession({
        tokenHash,
        discordUserId: "alice",
        expiresAt: EpochMillis.make(Date.now() + 60_000),
      });
    }).pipe(Effect.provide(database), Effect.runPromise);
    // a page holds 20, so these push the others onto a second page
    const morePosts = Effect.gen(function* () {
      const db = yield* Database;
      for (let i = 0; i < 20; i += 1) {
        const id = `more${String(i).padStart(2, "0")}`;
        yield* db.finishDelivery(
          { game: "tft", matchId: MatchId.make(id), guildId: "b" },
          {
            match: match("tft", id, 1_000 + i),
            players: [
              {
                discordUserId: "alice",
                puuid: Puuid.make("alice"),
                rankUpdate: undefined,
              },
            ],
          },
        );
      }
    });

    const { handler, dispose } = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(SiteApi).pipe(
        Layer.provide(FeedLive),
        Layer.provide(SignedInLive),
        Layer.provide([
          database,
          BunHttpServer.layerHttpServices,
          Layer.succeed(Discord, {
            notifyMatch: () => Effect.void,
            getServer: (guildId) =>
              Effect.succeed(
                Option.some({ name: `server ${guildId}`, iconUrl: undefined }),
              ),
            application: { id: "", name: "test", inviteUrl: "" },
          }),
        ]),
      ),
      { disableLogger: true },
    );
    const get = (path: string, cookie = `session=${token}`) =>
      handler(new Request(`http://test${path}`, { headers: { cookie } }));
    const page = async (query = "") => {
      const response = await get(`/api/feed${query}`);
      const body: {
        matches: ReadonlyArray<{
          game: string;
          matchId: string;
          players: ReadonlyArray<{ discordUserId: string }>;
        }>;
        next: string | null;
      } = await response.json();
      return body;
    };
    // the matches a feed request returns, as game:id with their players
    const feed = async (query = "") =>
      (await page(query)).matches.map(
        (m) =>
          `${m.game}:${m.matchId}:${m.players.map((p) => p.discordUserId).join(",")}`,
      );

    try {
      expect((await get("/api/feed", "")).status).toBe(401);
      expect((await get("/api/feed", "session=forged")).status).toBe(401);

      expect(await feed()).toEqual(["lol:bobs:bob", "tft:shared:alice,bob"]);
      expect(await feed("?order=oldest")).toEqual([
        "tft:shared:alice,bob",
        "lol:bobs:bob",
      ]);
      expect(await feed("?game=lol")).toEqual(["lol:bobs:bob"]);
      expect(await feed("?player=alice")).toEqual(["tft:shared:alice,bob"]);
      // a server shows only the players tracked there
      expect(await feed("?server=b")).toEqual(["tft:shared:alice"]);
      expect(await feed("?server=c")).toEqual([]);

      const me = await (await get("/api/me")).json();
      expect(me).toEqual({
        discordUserId: "alice",
        discordName: "alice",
        servers: [
          {
            guildId: "a",
            name: "server a",
            iconUrl: null,
            players: [
              { discordUserId: "alice", discordName: "alice" },
              { discordUserId: "bob", discordName: "bob" },
            ],
          },
          {
            guildId: "b",
            name: "server b",
            iconUrl: null,
            players: [{ discordUserId: "alice", discordName: "alice" }],
          },
        ],
      });

      expect((await page()).next).toBe(null);
      await morePosts.pipe(Effect.provide(database), Effect.runPromise);
      const first = await page();
      expect(first.matches.map((m) => m.matchId)).toEqual(
        Array.from(
          { length: 20 },
          (_, i) => `more${String(19 - i).padStart(2, "0")}`,
        ),
      );
      expect(first.next).not.toBe(null);
      const second = await page(`?cursor=${first.next}`);
      expect(second.matches.map((m) => m.matchId)).toEqual(["bobs", "shared"]);
      expect(second.next).toBe(null);
      expect((await get("/api/feed?cursor=garbage")).status).toBe(400);

      // signing out of a server takes its reports out of alice's feed, and
      // leaving the last one ends her session
      await Effect.gen(function* () {
        const db = yield* Database;
        yield* db.leaveGuild({ guildId: "a", discordUserId: "bob" });
      }).pipe(Effect.provide(database), Effect.runPromise);
      expect(await feed("?server=a")).toEqual(["tft:shared:alice"]);
      await Effect.gen(function* () {
        const db = yield* Database;
        yield* db.deleteAccount("alice");
      }).pipe(Effect.provide(database), Effect.runPromise);
      expect((await get("/api/feed")).status).toBe(401);
    } finally {
      await dispose();
    }
  } finally {
    await Bun.file(dbPath).delete();
  }
});
