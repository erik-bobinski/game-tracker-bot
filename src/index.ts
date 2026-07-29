import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { Polling, PollingLive } from "./services/polling/index.ts";
import { DatabaseLive } from "./services/database/index.ts";
import { DiscordLive } from "./services/discord/index.ts";
import { GameAdaptersLive } from "./services/game/game-adapters/index.ts";
import { RiotApiLive } from "./services/game/game-api/lol/riot-api-client.ts";
import { HenrikApiClientLive } from "./services/game/game-api/val/henrik-api-client.ts";
import { MatchEngineLive } from "./services/match-engine/index.ts";

const main = Effect.gen(function* () {
  const polling = yield* Polling;
  yield* Effect.forkScoped(polling.run);

  // Keep the parent scope alive for both the gateway and polling fiber.
  yield* Effect.never;
});

// Riot + Henrik clients share one HTTP client (Discord has its own, internally).
const ApiClientsLive = Layer.mergeAll(RiotApiLive, HenrikApiClientLive).pipe(
  Layer.provide(NodeHttpClient.layerUndici),
);

const GameLive = GameAdaptersLive.pipe(Layer.provide(ApiClientsLive));

const AppLive = PollingLive.pipe(
  Layer.provide(MatchEngineLive),
  Layer.provide(DiscordLive),
  Layer.provide(Layer.mergeAll(DatabaseLive, GameLive)),
);

// One JSON object per line. The default pretty logger wraps multi-line, and the
// log drain treats each line as its own entry, which splits a single warning
// across several of them and hides annotations from structured search.
const LoggerLive = Logger.layer([Logger.consoleJson]);

const runner = main.pipe(
  Effect.provide(AppLive),
  Effect.provide(LoggerLive),
  Effect.scoped,
);

NodeRuntime.runMain(runner);
