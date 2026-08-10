import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Layer, Logger, References } from "effect";
import { Polling, PollingLive } from "./services/polling/index.ts";
import { PollingStateLive } from "./services/polling/state.ts";
import { DatabaseLive } from "./services/database/index.ts";
import { DiscordLive } from "./services/discord/index.ts";
import { GameAdaptersLive } from "./services/game/game-adapters/index.ts";
import { RiotApiLive } from "./services/game/game-api/lol/riot-api-client.ts";
import { HenrikApiClientLive } from "./services/game/game-api/val/henrik-api-client.ts";
import { MatchEngineLive } from "./services/match-engine/index.ts";

const main = Effect.gen(function* () {
  const devMode = yield* Config.boolean("DEV_MODE").pipe(
    Config.withDefault(false),
  );
  const logLevel = yield* Config.logLevel("LOG_LEVEL").pipe(
    Config.withDefault("Info"),
  );
  const polling = yield* Polling;

  yield* Effect.logInfo("application started").pipe(
    Effect.annotateLogs({ devMode, logLevel }),
  );
  yield* Effect.forkScoped(polling.run);

  // Keep the parent scope alive for both the gateway and polling fiber.
  yield* Effect.never;
});

// Riot + Henrik clients share one HTTP client (Discord has its own, internally).
const ApiClientsLive = Layer.mergeAll(RiotApiLive, HenrikApiClientLive).pipe(
  Layer.provide(NodeHttpClient.layerUndici),
);

const GameLive = GameAdaptersLive.pipe(Layer.provide(ApiClientsLive));

const StateLive = PollingStateLive.pipe(Layer.provideMerge(DatabaseLive));

const AppLive = PollingLive.pipe(
  Layer.provide(MatchEngineLive),
  Layer.provide(DiscordLive),
  Layer.provide(Layer.mergeAll(StateLive, GameLive)),
);

const LoggerLive = Layer.unwrap(
  Effect.gen(function* () {
    const devMode = yield* Config.boolean("DEV_MODE").pipe(
      Config.withDefault(false),
    );
    const logLevel = yield* Config.logLevel("LOG_LEVEL").pipe(
      Config.withDefault("Info"),
    );

    return Layer.mergeAll(
      Logger.layer([
        devMode ? Logger.consolePretty({ colors: "auto" }) : Logger.consoleJson,
      ]),
      Layer.succeed(References.MinimumLogLevel, logLevel),
    );
  }),
);

const runner = main.pipe(
  Effect.provide(AppLive),
  Effect.provide(LoggerLive),
  Effect.scoped,
);

NodeRuntime.runMain(runner);
