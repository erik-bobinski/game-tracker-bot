import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { Polling, PollingLive } from "./services/polling/index.ts";
import { PollingStateLive } from "./services/polling/state.ts";
import { DatabaseLive } from "./services/database/index.ts";
import { DiscordLive } from "./services/discord/index.ts";
import { GameAdaptersLive } from "./services/game/game-adapters/index.ts";
import { RiotApiLive } from "./services/game/game-api/lol/riot-api-client.ts";
import { HenrikApiClientLive } from "./services/game/game-api/val/henrik-api-client.ts";
import { MatchEngineLive } from "./services/match-engine/index.ts";
import { isAdminCli, runAdminCli } from "./admin-cli.ts";
import { AdminLive } from "./services/admin/index.ts";
import { serveAdmin } from "./services/admin/socket.ts";

const main = Effect.gen(function* () {
  const polling = yield* Polling;
  yield* serveAdmin().pipe(Effect.flatMap(Effect.forkScoped));
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

const AppLive = AdminLive.pipe(
  Layer.provideMerge(PollingLive),
  Layer.provide(MatchEngineLive),
  Layer.provide(DiscordLive),
  Layer.provide(Layer.mergeAll(StateLive, GameLive)),
);

const LoggerLive = Logger.layer([Logger.consoleJson]);

const runner = main.pipe(
  Effect.provide(AppLive),
  Effect.provide(LoggerLive),
  Effect.scoped,
);

if (isAdminCli) runAdminCli();
else NodeRuntime.runMain(runner);
