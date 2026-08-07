import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { AppConfig, AppConfigLive } from "./services/config.ts";
import { DatabaseLive } from "./services/database/index.ts";
import {
  CommandRegistration,
  CommandRegistrationLive,
  DiscordApiLive,
  DiscordLive,
} from "./services/discord/index.ts";
import {
  DevGameAdaptersLive,
  DevSimulator,
  DevSimulatorLive,
} from "./services/game/dev-simulator.ts";
import {
  GameAdapters,
  GameAdaptersLive,
} from "./services/game/game-adapters/index.ts";
import { RiotApiLive } from "./services/game/game-api/lol/riot-api-client.ts";
import { HenrikApiClientLive } from "./services/game/game-api/val/henrik-api-client.ts";
import { MatchEngineLive } from "./services/match-engine/index.ts";
import { Polling, PollingLive } from "./services/polling/index.ts";
import { PollingStateLive } from "./services/polling/state.ts";

const main = Effect.gen(function* () {
  yield* CommandRegistration;
  const polling = yield* Polling;
  yield* polling.run;
});

const ProdGameLive = GameAdaptersLive.pipe(
  Layer.provide(Layer.mergeAll(RiotApiLive, HenrikApiClientLive)),
  Layer.provide(NodeHttpClient.layerUndici),
);
const GameLive = Layer.unwrap(
  AppConfig.pipe(
    Effect.map(
      ({
        appMode,
      }): Layer.Layer<GameAdapters, never, AppConfig | DevSimulator> =>
        appMode === "development" ? DevGameAdaptersLive : ProdGameLive,
    ),
  ),
);
const StateLive = PollingStateLive.pipe(Layer.provideMerge(DatabaseLive));
const InfrastructureLive = Layer.mergeAll(StateLive, GameLive, DiscordApiLive);
const DiscordServiceLive = DiscordLive.pipe(
  Layer.provideMerge(InfrastructureLive),
);
const EngineLive = MatchEngineLive.pipe(Layer.provideMerge(DiscordServiceLive));
const PollingServiceLive = PollingLive.pipe(Layer.provideMerge(EngineLive));
const ApplicationLive = CommandRegistrationLive.pipe(
  Layer.provideMerge(PollingServiceLive),
  Layer.provide(Layer.mergeAll(AppConfigLive, DevSimulatorLive)),
);

const runner = main.pipe(
  Effect.provide(ApplicationLive),
  Effect.provide(Logger.layer([Logger.consoleJson])),
  Effect.scoped,
);

NodeRuntime.runMain(runner);
