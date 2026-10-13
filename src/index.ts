import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Layer, Logger, References } from "effect";
import { Polling, PollingLive } from "./services/polling/index.ts";
import { PollingStateLive } from "./services/polling/state.ts";
import { DatabaseLive } from "./services/database/index.ts";
import { DiscordLive } from "./services/discord/index.ts";
import { GameAdaptersLive } from "./services/game/game-adapters/index.ts";
import { RiotApiLive } from "./services/game/game-api/lol/riot-api-client.ts";
import { MatchEngineLive } from "./services/match-engine/index.ts";
import { RsoLive } from "./services/rso/index.ts";
import { WebLive } from "./services/web/index.ts";

const runtimeConfig = Config.all({
  devMode: Config.boolean("DEV_MODE").pipe(Config.withDefault(false)),
  logLevel: Config.logLevel("LOG_LEVEL").pipe(Config.withDefault("Info")),
});

const main = Effect.gen(function* () {
  const { devMode, logLevel } = yield* runtimeConfig;
  const polling = yield* Polling;

  yield* Effect.logInfo("application started").pipe(
    Effect.annotateLogs({ devMode, logLevel }),
  );
  yield* Effect.forkScoped(polling.run);

  // Keep the parent scope alive for both the gateway and polling fiber.
  yield* Effect.never;
});

// The game api and riot sign-in clients share one HTTP client (Discord has
// its own, internally).
const GameLive = Layer.mergeAll(
  GameAdaptersLive.pipe(Layer.provide(RiotApiLive)),
  RsoLive,
).pipe(Layer.provide(NodeHttpClient.layerUndici));

const StateLive = PollingStateLive.pipe(Layer.provideMerge(DatabaseLive));

// the web server carries the public pages and riot's sign-in callback
const AppLive = Layer.mergeAll(PollingLive, WebLive).pipe(
  Layer.provide(MatchEngineLive),
  Layer.provide(DiscordLive),
  Layer.provide(Layer.mergeAll(StateLive, GameLive)),
);

const LoggerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { devMode, logLevel } = yield* runtimeConfig;

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
