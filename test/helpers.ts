import { Duration, Effect, Layer, Redacted } from "effect";
import { AppConfig, type AppConfigService } from "../src/services/config.ts";
import { DatabaseLive } from "../src/services/database/index.ts";
import {
  DevGameAdaptersLive,
  DevSimulatorLive,
} from "../src/services/game/dev-simulator.ts";

export const config = (dbPath: string): AppConfigService => ({
  appMode: "development",
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

export const simulatedGameLayer = () =>
  DevGameAdaptersLive.pipe(Layer.provideMerge(DevSimulatorLive));

export const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.scoped));
