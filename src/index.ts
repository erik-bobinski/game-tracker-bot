import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { DiscordGateway } from "dfx/gateway";
import { Effect, Layer } from "effect";
import { Polling, PollingLive } from "./services/polling/index.js";
import { DatabaseLive } from "./services/database/index.js";
import { DiscordLive } from "./services/discord/index.js";
import { GameAdaptersLive } from "./services/game/game-adapters/index.js";
import { RiotApiLive } from "./services/game/game-api/lol/riot-api-client.js";
import { HenrikApiClientLive } from "./services/game/game-api/val/henrik-api-client.js";
import { MatchEngineLive } from "./services/match-engine/index.js";

const main = Effect.gen(function* () {
  const polling = yield* Polling;
  yield* DiscordGateway;
  yield* Effect.forkScoped(polling.run);

  // Keep the parent scope alive for both the gateway and polling fiber.
  yield* Effect.never;
});

// Riot + Henrik clients share one HTTP client (Discord has its own, internally).
const ApiClientsLive = Layer.mergeAll(RiotApiLive, HenrikApiClientLive).pipe(
  Layer.provide(NodeHttpClient.layerUndici),
);

const GameLive = GameAdaptersLive.pipe(Layer.provide(ApiClientsLive));

const AppLive = Layer.mergeAll(PollingLive, DiscordLive).pipe(
  Layer.provide(MatchEngineLive),
  Layer.provide(Layer.mergeAll(DatabaseLive, GameLive)),
);

const runner = main.pipe(Effect.provide(AppLive), Effect.scoped);

NodeRuntime.runMain(runner);
