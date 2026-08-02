import { Duration, Effect, Layer, Redacted } from "effect";
import { AppConfig, type AppConfigService } from "../src/services/config.ts";
import { DatabaseLive } from "../src/services/database/index.ts";
import {
  DevHttpClientLive,
  DevSimulatorLive,
} from "../src/services/game/dev-simulator.ts";
import { GameAdaptersLive } from "../src/services/game/game-adapters/index.ts";
import { RiotApiLive } from "../src/services/game/game-api/lol/riot-api-client.ts";
import { HenrikApiClientLive } from "../src/services/game/game-api/val/henrik-api-client.ts";

export const config = (dbPath: string): AppConfigService => ({
  appMode: "development",
  adminSocketPath: "/tmp/riot-tracker-bot-test-admin.sock",
  dbPath,
  notificationChannelId: "test-channel",
  pollInterval: Duration.minutes(1),
  discordBotToken: Redacted.make("test-discord"),
  riotApiKey: Redacted.make("test-riot"),
  henrikApiKey: Redacted.make("test-henrik"),
});

export const configLayer = (dbPath: string) =>
  Layer.succeed(AppConfig, config(dbPath));

export const databaseLayer = (dbPath: string) =>
  DatabaseLive.pipe(Layer.provide(configLayer(dbPath)));

export const simulatedGameLayer = (dbPath = ":memory:") => {
  const base = Layer.mergeAll(configLayer(dbPath), DevSimulatorLive);
  const clients = Layer.mergeAll(RiotApiLive, HenrikApiClientLive).pipe(
    Layer.provide(DevHttpClientLive),
    Layer.provideMerge(base),
  );
  return GameAdaptersLive.pipe(Layer.provideMerge(clients));
};

export const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.scoped));
