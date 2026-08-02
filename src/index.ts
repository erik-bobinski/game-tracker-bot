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
  DevHttpClientLive,
  DevSimulatorLive,
} from "./services/game/dev-simulator.ts";
import { GameAdaptersLive } from "./services/game/game-adapters/index.ts";
import { RiotApiLive } from "./services/game/game-api/lol/riot-api-client.ts";
import { HenrikApiClientLive } from "./services/game/game-api/val/henrik-api-client.ts";
import { MatchEngineLive } from "./services/match-engine/index.ts";
import { Polling, PollingLive } from "./services/polling/index.ts";
import { PollingStateLive } from "./services/polling/state.ts";
import { isAdminCli, runAdminCli } from "./admin-cli.ts";
import { AdminLive } from "./services/admin/index.ts";
import { makeAdminServer } from "./services/admin/socket.ts";

const main = Effect.gen(function* () {
  yield* CommandRegistration;
  const polling = yield* Polling;
  const adminServer = yield* makeAdminServer();
  yield* Effect.forkScoped(adminServer);
  yield* polling.run;
});

const ApiHttpLive = Layer.unwrap(
  AppConfig.pipe(
    Effect.map(({ appMode }) =>
      appMode === "development"
        ? DevHttpClientLive
        : NodeHttpClient.layerUndici,
    ),
  ),
);

const ApiClientsLive = Layer.mergeAll(RiotApiLive, HenrikApiClientLive).pipe(
  Layer.provide(ApiHttpLive),
);
const GameLive = GameAdaptersLive.pipe(Layer.provide(ApiClientsLive));
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
const RuntimeLive = AdminLive.pipe(
  Layer.provideMerge(ApplicationLive),
  Layer.provide(AppConfigLive),
);

const runner = main.pipe(
  Effect.provide(RuntimeLive),
  Effect.provide(Logger.layer([Logger.consoleJson])),
  Effect.scoped,
);

if (isAdminCli) runAdminCli();
else NodeRuntime.runMain(runner);
