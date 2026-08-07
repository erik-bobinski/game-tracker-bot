import { describe, expect, it } from "vitest";
import { Effect, Layer, Ref } from "effect";
import { Database } from "../src/services/database/index.ts";
import {
  commandNamesForMode,
  devStageMatchWorkflow,
  rankCheckWorkflow,
  signoutWorkflow,
  signupWorkflow,
} from "../src/services/discord/commands.ts";
import { DevSimulator } from "../src/services/game/dev-simulator.ts";
import {
  GameApiError,
  GameAdapters,
  type GameAdapter,
} from "../src/services/game/game-adapters/index.ts";
import { Puuid } from "../src/services/game/index.ts";
import { databaseLayer, run, simulatedGameLayer } from "./helpers.ts";

const workflowLayer = () =>
  Layer.mergeAll(databaseLayer(":memory:"), simulatedGameLayer());

describe("command workflows", () => {
  it("does not expose development commands in production mode", () => {
    expect(commandNamesForMode("production")).toEqual([
      "signup",
      "signout",
      "pause",
      "resume",
      "rank_check",
    ]);
    expect(commandNamesForMode("development")).toContain("dev_poll");
  });

  it("signs up every discovered game, maps ranks, stages fixtures, and signs out", async () => {
    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        const gameAdapters = yield* GameAdapters;
        const simulator = yield* DevSimulator;
        const signup = yield* signupWorkflow(database, gameAdapters, {
          discordUserId: "discord-1",
          discordName: "Tester",
          riotName: "MockAlpha",
          riotTag: "NA1",
        });
        expect(signup).toContain("LoL");
        expect(signup).toContain("Valorant");
        const repeated = yield* signupWorkflow(database, gameAdapters, {
          discordUserId: "discord-1",
          discordName: "Tester",
          riotName: "MockAlpha",
          riotTag: "NA1",
        });
        expect(repeated).toContain("Already tracking");
        const lolRanks = yield* rankCheckWorkflow(
          database,
          gameAdapters,
          "discord-1",
          "lol",
        );
        expect(lolRanks._tag).toBe("Ranks");
        if (lolRanks._tag === "Ranks") {
          expect(lolRanks.ranks[0]?.pointsLabel).toBe("64 LP");
          expect(lolRanks.iconUrl).toContain("ranked-mini-crests/diamond.png");
        }
        const valorantRank = yield* rankCheckWorkflow(
          database,
          gameAdapters,
          "discord-1",
          "valorant",
        );
        expect(valorantRank._tag).toBe("Ranks");
        if (valorantRank._tag === "Ranks") {
          expect(valorantRank.ranks[0]?.pointsLabel).toBe("38 RR");
          expect(valorantRank.iconUrl).toContain("smallicon.png");
        }
        expect(
          yield* devStageMatchWorkflow(database, simulator, {
            discordUserId: "discord-1",
            game: "lol",
            result: "victory",
            mode: "ranked",
            surrendered: false,
            duplicate: false,
          }),
        ).toContain("Staged LoL match");
        expect(yield* signoutWorkflow(database, "discord-1", "lol")).toBe(
          "Stopped tracking LoL.",
        );
        expect(yield* signoutWorkflow(database, "discord-1")).toBe(
          "Stopped tracking all of your games.",
        );
      }).pipe(Effect.provide(workflowLayer())),
    );
  });

  it("reports unknown signup and missing tracked games clearly", async () => {
    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        const gameAdapters = yield* GameAdapters;
        expect(
          yield* signupWorkflow(database, gameAdapters, {
            discordUserId: "missing",
            discordName: "Missing",
            riotName: "Unknown",
            riotTag: "NOPE",
          }),
        ).toContain("not found");
        const missingRank = yield* rankCheckWorkflow(
          database,
          gameAdapters,
          "missing",
          "lol",
        );
        expect(missingRank).toMatchObject({
          _tag: "Message",
          content: expect.stringContaining("not tracking"),
        });
        expect(yield* signoutWorkflow(database, "missing")).toContain(
          "did not have",
        );
      }).pipe(Effect.provide(workflowLayer())),
    );
  });

  it("reports partial discovery and adds the missing game on retry", async () => {
    await run(
      Effect.gen(function* () {
        const attempts = yield* Ref.make(0);
        const lol: GameAdapter = {
          game: "lol",
          rankIcons: [],
          resolveAccount: () =>
            Effect.succeed({ puuid: Puuid.make("partial-lol"), route: "na1" }),
          getRecentMatches: () => Effect.succeed([]),
          getRanks: () => Effect.succeed([]),
          enrichMatch: Effect.succeed,
        };
        const valorant: GameAdapter = {
          game: "valorant",
          rankIcons: [],
          resolveAccount: () =>
            Ref.updateAndGet(attempts, (count) => count + 1).pipe(
              Effect.flatMap((attempt) =>
                attempt === 1
                  ? Effect.fail(
                      new GameApiError({
                        game: "valorant",
                        operation: "account discovery",
                        cause: new Error("planned provider failure"),
                      }),
                    )
                  : Effect.succeed({
                      puuid: Puuid.make("partial-val"),
                      route: "na/pc",
                    }),
              ),
            ),
          getRecentMatches: () => Effect.succeed([]),
          getRanks: () => Effect.succeed([]),
          enrichMatch: Effect.succeed,
        };
        const gameAdapters = GameAdapters.of({ all: [lol, valorant] });
        const layer = Layer.mergeAll(
          databaseLayer(":memory:"),
          Layer.succeed(GameAdapters, gameAdapters),
        );
        yield* Effect.gen(function* () {
          const database = yield* Database;
          const first = yield* signupWorkflow(database, gameAdapters, {
            discordUserId: "partial",
            discordName: "Partial",
            riotName: "Partial",
            riotTag: "NA1",
          });
          expect(first).toContain("Now tracking LoL");
          expect(first).toContain("Could not check Valorant");
          const second = yield* signupWorkflow(database, gameAdapters, {
            discordUserId: "partial",
            discordName: "Partial",
            riotName: "Partial",
            riotTag: "NA1",
          });
          expect(second).toContain("Already tracking LoL");
          expect(second).toContain("Now tracking Valorant");
          expect((yield* database.getAccount("partial"))?.games).toMatchObject({
            lol: { route: "na1" },
            valorant: { route: "na/pc" },
          });
        }).pipe(Effect.provide(layer));
      }),
    );
  });
});
