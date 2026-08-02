import { Config, Context, Duration, Effect, Layer, Redacted } from "effect";

export type AppMode = "development" | "production";

export interface AppConfigService {
  readonly appMode: AppMode;
  readonly dbPath: string;
  readonly notificationChannelId: string;
  readonly pollInterval: Duration.Duration;
  readonly discordBotToken: Redacted.Redacted<string>;
  readonly riotApiKey: Redacted.Redacted<string>;
  readonly henrikApiKey: Redacted.Redacted<string>;
}

export class AppConfig extends Context.Service<AppConfig, AppConfigService>()(
  "app/AppConfig",
) {}

export const AppConfigLive = Layer.effect(
  AppConfig,
  Effect.gen(function* () {
    return AppConfig.of({
      appMode: yield* Config.literals(
        ["development", "production"],
        "APP_MODE",
      ).pipe(Config.withDefault("production")),
      dbPath: yield* Config.nonEmptyString("DB_PATH").pipe(
        Config.withDefault("riot-tracker.sqlite"),
      ),
      notificationChannelId: yield* Config.nonEmptyString(
        "NOTIFICATION_CHANNEL_ID",
      ),
      pollInterval: yield* Config.duration("POLL_INTERVAL").pipe(
        Config.withDefault(Duration.minutes(1)),
      ),
      discordBotToken: yield* Config.redacted("DISCORD_BOT_TOKEN"),
      riotApiKey: yield* Config.redacted("RIOT_API_KEY"),
      henrikApiKey: yield* Config.redacted("HENRIK_API_KEY"),
    });
  }),
);
