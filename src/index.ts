import { NodeRuntime } from "@effect/platform-node";
import { DiscordGateway } from "dfx/gateway";
import { Effect, Layer } from "effect";
import { Polling, PollingLive } from "./polling.js";
import { DatabaseLive } from "./services/database/index.js";
import { DiscordLive } from "./services/discord/index.js";
import { GameAdaptersLive } from "./services/game-adapters/index.js";
import { MatchEngineLive } from "./services/match-engine/index.js";

const main = Effect.gen(function* () {
  const polling = yield* Polling;
  yield* DiscordGateway;
  yield* Effect.forkScoped(polling.run);

  // Keep the parent scope alive for both the gateway and polling fiber.
  yield* Effect.never;
});

const AppLive = Layer.mergeAll(PollingLive, DiscordLive).pipe(
  Layer.provide(MatchEngineLive),
  Layer.provide(Layer.mergeAll(DatabaseLive, GameAdaptersLive)),
);

const runner = main.pipe(Effect.provide(AppLive), Effect.scoped);

NodeRuntime.runMain(runner);
