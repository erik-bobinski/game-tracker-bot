import { describe, expect, it } from "vitest";
import { Context, Effect, Layer, Ref } from "effect";
import { Database } from "../src/services/database/index.ts";
import { Discord, DiscordError } from "../src/services/discord/index.ts";
import type { MatchReport } from "../src/services/discord/embed.ts";
import {
  devStageMatchWorkflow,
  signupWorkflow,
} from "../src/services/discord/commands.ts";
import { DevSimulator } from "../src/services/game/dev-simulator.ts";
import {
  GameApiError,
  GameAdapters,
  type GameAdapter,
} from "../src/services/game/game-adapters/index.ts";
import {
  EpochMillis,
  MatchId,
  Puuid,
  type MatchDetails,
} from "../src/services/game/index.ts";
import {
  MatchEngine,
  MatchEngineLive,
} from "../src/services/match-engine/index.ts";
import { databaseLayer, run, simulatedGameLayer } from "./helpers.ts";

class NotifierControl extends Context.Service<
  NotifierControl,
  {
    readonly reports: Ref.Ref<ReadonlyArray<MatchReport>>;
    readonly failNext: Ref.Ref<boolean>;
  }
>()("test/NotifierControl") {}

const notifierLayer = Layer.effectContext(
  Effect.gen(function* () {
    const reports = yield* Ref.make<ReadonlyArray<MatchReport>>([]);
    const failNext = yield* Ref.make(false);
    const notifyMatch = (report: MatchReport) =>
      Ref.getAndSet(failNext, false).pipe(
        Effect.flatMap((shouldFail) =>
          shouldFail
            ? Effect.fail(
                new DiscordError({
                  operation: "test",
                  cause: new Error("planned failure"),
                }),
              )
            : Ref.update(reports, (sent) => [...sent, report]),
        ),
      );
    const control = NotifierControl.of({ reports, failNext });
    return Context.empty().pipe(
      Context.add(Discord, Discord.of({ notifyMatch })),
      Context.add(NotifierControl, control),
    );
  }),
);

const match = (id: string, date: number): MatchDetails => ({
  matchId: MatchId.make(id),
  game: "lol",
  date: EpochMillis.make(date),
  mode: "Ranked Solo/Duo",
  durationSeconds: 1_800,
  surrendered: false,
  players: [
    {
      puuid: Puuid.make("shared-puuid"),
      team: "100",
      riotName: "Mock",
      riotTag: "NA1",
      character: "Ahri",
      kills: 10,
      deaths: 2,
      assists: 7,
      stat: "200 CS",
      sortKey: 8,
    },
  ],
  teams: [{ id: "100", won: true }],
});

const gameLayer = (matches: ReadonlyArray<MatchDetails>) => {
  const adapter: GameAdapter = {
    game: "lol",
    rankIcons: [],
    resolveAccount: () => Effect.die("unused"),
    getRecentMatches: () => Effect.succeed(matches),
    getRanks: () => Effect.succeed([]),
    enrichMatch: Effect.succeed,
  };
  return Layer.succeed(GameAdapters, GameAdapters.of({ all: [adapter] }));
};

const engineLayer = (matches: ReadonlyArray<MatchDetails>) =>
  MatchEngineLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        databaseLayer(":memory:"),
        gameLayer(matches),
        notifierLayer,
      ),
    ),
  );

const add = (id: string, name: string, trackingStartedAt = 1_000) => ({
  discordUserId: id,
  discordName: name,
  riotName: "Mock",
  riotTag: "NA1",
  games: {
    lol: {
      puuid: Puuid.make("shared-puuid"),
      route: "na1",
      trackingStartedAt: EpochMillis.make(trackingStartedAt),
      reportedMatches: [],
    },
  },
});

describe("MatchEngine", () => {
  it("reports a new match once and marks it for deduplication", async () => {
    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        const engine = yield* MatchEngine;
        const control = yield* NotifierControl;
        yield* database.addAccount(add("one", "One"));
        expect((yield* engine.pollOnce()).reportsSent).toBe(1);
        expect((yield* engine.pollOnce()).reportsSent).toBe(0);
        expect(yield* Ref.get(control.reports)).toHaveLength(1);
      }).pipe(Effect.provide(engineLayer([match("new", 2_000)]))),
    );
  });

  it("coalesces a shared match into one report naming both users", async () => {
    const shared: MatchDetails = {
      ...match("shared", 2_000),
      players: [
        ...match("shared", 2_000).players,
        {
          puuid: Puuid.make("shared-puuid-two"),
          team: "100",
          riotName: "MockTwo",
          riotTag: "NA1",
          character: "Lux",
          kills: 8,
          deaths: 3,
          assists: 12,
          stat: "180 CS",
          sortKey: 7,
        },
      ],
    };
    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        const engine = yield* MatchEngine;
        const control = yield* NotifierControl;
        yield* database.addAccount(add("one", "One"));
        yield* database.addAccount({
          ...add("two", "Two"),
          games: {
            lol: {
              ...add("two", "Two").games.lol,
              puuid: Puuid.make("shared-puuid-two"),
            },
          },
        });
        yield* engine.pollOnce();
        const reports = yield* Ref.get(control.reports);
        expect(reports).toHaveLength(1);
        expect(reports[0]?.discordNames).toEqual(["One", "Two"]);
        expect(
          (yield* database.getAccount("one"))?.games.lol?.reportedMatches,
        ).toHaveLength(1);
        expect(
          (yield* database.getAccount("two"))?.games.lol?.reportedMatches,
        ).toHaveLength(1);
      }).pipe(Effect.provide(engineLayer([shared]))),
    );
  });

  it("retries a failed notification and ignores pre-signup history", async () => {
    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        const engine = yield* MatchEngine;
        const control = yield* NotifierControl;
        yield* database.addAccount(add("one", "One", 1_500));
        yield* Ref.set(control.failNext, true);
        const first = yield* engine.pollOnce();
        expect(first.discoveredMatches).toBe(1);
        expect(first.reportFailures).toBe(1);
        expect((yield* engine.pollOnce()).reportsSent).toBe(1);
        expect(yield* Ref.get(control.reports)).toHaveLength(1);
      }).pipe(
        Effect.provide(
          engineLayer([match("historical", 1_000), match("retry", 2_000)]),
        ),
      ),
    );
  });

  it("isolates an account API failure and sends base reports chronologically", async () => {
    const early = match("early", 2_000);
    const late = match("late", 3_000);
    const adapter: GameAdapter = {
      game: "lol",
      rankIcons: [],
      resolveAccount: () => Effect.die("unused"),
      getRecentMatches: (account) =>
        account.puuid === "failed-puuid"
          ? Effect.fail(
              new GameApiError({
                game: "lol",
                operation: "recent matches",
                cause: new Error("planned API failure"),
              }),
            )
          : Effect.succeed([late, early]),
      getRanks: () => Effect.succeed([]),
      enrichMatch: () =>
        Effect.fail(
          new GameApiError({
            game: "lol",
            operation: "enrichment",
            cause: new Error("planned enrichment failure"),
          }),
        ),
    };
    const layer = MatchEngineLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          databaseLayer(":memory:"),
          Layer.succeed(GameAdapters, GameAdapters.of({ all: [adapter] })),
          notifierLayer,
        ),
      ),
    );
    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        const engine = yield* MatchEngine;
        const control = yield* NotifierControl;
        yield* database.addAccount(add("working", "Working"));
        yield* database.addAccount({
          ...add("failed", "Failed"),
          games: {
            lol: {
              ...add("failed", "Failed").games.lol,
              puuid: Puuid.make("failed-puuid"),
            },
          },
        });
        const summary = yield* engine.pollOnce();
        expect(summary).toMatchObject({
          accountsChecked: 2,
          apiFailures: 1,
          reportsSent: 2,
        });
        expect(
          (yield* Ref.get(control.reports)).map(
            (report) => report.match.matchId,
          ),
        ).toEqual(["early", "late"]);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("reports a solo Valorant match once", async () => {
    const valorantMatch: MatchDetails = {
      ...match("valorant", 2_000),
      game: "valorant",
    };
    const adapter: GameAdapter = {
      game: "valorant",
      rankIcons: [],
      resolveAccount: () => Effect.die("unused"),
      getRecentMatches: () => Effect.succeed([valorantMatch]),
      getRanks: () => Effect.succeed([]),
      enrichMatch: Effect.succeed,
    };
    const layer = MatchEngineLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          databaseLayer(":memory:"),
          Layer.succeed(GameAdapters, GameAdapters.of({ all: [adapter] })),
          notifierLayer,
        ),
      ),
    );
    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        const engine = yield* MatchEngine;
        const account = add("valorant-user", "Valorant User");
        yield* database.addAccount({
          ...account,
          games: {
            valorant: {
              ...account.games.lol,
              route: "na/pc",
            },
          },
        });
        expect((yield* engine.pollOnce()).reportsSent).toBe(1);
        expect((yield* engine.pollOnce()).reportsSent).toBe(0);
      }).pipe(Effect.provide(layer)),
    );
  });
  it("polls a staged LoL fixture through the dev adapters", async () => {
    const layer = MatchEngineLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          databaseLayer(":memory:"),
          simulatedGameLayer(),
          notifierLayer,
        ),
      ),
    );
    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        const gameAdapters = yield* GameAdapters;
        const simulator = yield* DevSimulator;
        const engine = yield* MatchEngine;
        const control = yield* NotifierControl;
        yield* signupWorkflow(database, gameAdapters, {
          discordUserId: "live-lol",
          discordName: "Live LoL",
          riotName: "MockAlpha",
          riotTag: "NA1",
        });
        yield* devStageMatchWorkflow(database, simulator, {
          discordUserId: "live-lol",
          game: "lol",
          result: "victory",
          mode: "ranked",
          surrendered: false,
          duplicate: false,
        });
        const summary = yield* engine.pollOnce();
        expect(summary).toMatchObject({
          accountsChecked: 2,
          apiFailures: 0,
          discoveredMatches: 1,
          reportsSent: 1,
          reportFailures: 0,
        });
        expect(yield* Ref.get(control.reports)).toHaveLength(1);
      }).pipe(Effect.provide(layer)),
    );
  });
});
