import { NodeHttpClient, NodeSocket } from "@effect/platform-node";
import {
  Context,
  Effect,
  Layer,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import {
  Discord as DiscordApi,
  DiscordConfig,
  DiscordREST,
  Intents,
} from "dfx";
import {
  DiscordGateway,
  DiscordIxLive,
  InteractionsRegistry,
  SendEvent,
} from "dfx/gateway";
import { AppConfig } from "../config.ts";
import { Database } from "../database/index.ts";
import { DevSimulator } from "../game/dev-simulator.ts";
import { GameAdapters } from "../game/game-adapters/index.ts";
import { Polling } from "../polling/index.ts";
import { PollingState } from "../polling/state.ts";
import { commandNamesForMode, commands } from "./commands.ts";
import { matchEmbed, type MatchReport } from "./embed.ts";
import { provisionRankEmojis } from "./rank-emojis.ts";

export class DiscordError extends Schema.TaggedErrorClass<DiscordError>()(
  "DiscordError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class Discord extends Context.Service<
  Discord,
  {
    readonly notifyMatch: (
      report: MatchReport,
    ) => Effect.Effect<void, DiscordError>;
  }
>()("app/Discord") {}

export class CommandRegistration extends Context.Service<
  CommandRegistration,
  Record<never, never>
>()("app/CommandRegistration") {}

const DiscordConfigLive = Layer.unwrap(
  AppConfig.pipe(
    Effect.map(({ discordBotToken }) =>
      DiscordConfig.layer({
        token: discordBotToken,
        gateway: { intents: Intents.fromList(["Guilds"]) },
      }),
    ),
  ),
);

export const DiscordApiLive = DiscordIxLive.pipe(
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(NodeSocket.layerWebSocketConstructor),
  Layer.provide(DiscordConfigLive),
);

export const DiscordLive = Layer.effect(
  Discord,
  Effect.gen(function* () {
    const rest = yield* DiscordREST;
    const gateway = yield* DiscordGateway;
    const { notificationChannelId } = yield* AppConfig;
    const gameAdapters = yield* GameAdapters;
    const pollingState = yield* PollingState;
    const rankEmojis = yield* provisionRankEmojis(gameAdapters.all).pipe(
      Effect.provide(NodeHttpClient.layerUndici),
      Effect.catch((error) =>
        Effect.logWarning(
          "application rank emojis unavailable; continuing without icons",
          error,
        ).pipe(Effect.as({})),
      ),
    );

    const setPresence = (paused: boolean) =>
      gateway.send(
        SendEvent.presenceUpdate({
          status: paused
            ? DiscordApi.PresenceUpdateStatus.Idle
            : DiscordApi.PresenceUpdateStatus.Online,
          since: paused ? Date.now() : null,
          activities: [],
          afk: false,
        }),
      );

    yield* SubscriptionRef.changes(pollingState.paused).pipe(
      Stream.changes,
      Stream.runForEach(setPresence),
      Effect.forkScoped,
    );
    yield* gateway
      .handleDispatch("READY", () =>
        SubscriptionRef.get(pollingState.paused).pipe(
          Effect.flatMap(setPresence),
        ),
      )
      .pipe(Effect.forkScoped);

    const notifyMatch = Effect.fn("Discord.notifyMatch")(
      function* (report: MatchReport) {
        yield* rest.createMessage(notificationChannelId, {
          embeds: [matchEmbed(report, rankEmojis)],
        });
      },
      Effect.mapError(
        (cause) => new DiscordError({ operation: "notifyMatch", cause }),
      ),
    );

    return Discord.of({ notifyMatch });
  }),
);

export const CommandRegistrationLive = Layer.effect(
  CommandRegistration,
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const rest = yield* DiscordREST;
    const database = yield* Database;
    const gameAdapters = yield* GameAdapters;
    const polling = yield* Polling;
    const pollingState = yield* PollingState;
    const simulator = yield* DevSimulator;
    const { appMode } = yield* AppConfig;
    yield* registry.register(
      commands({
        appMode,
        database,
        gameAdapters,
        polling,
        rest,
        pollingState,
        simulator,
      }),
    );
    yield* Effect.logInfo("Discord commands registered").pipe(
      Effect.annotateLogs({
        appMode,
        commands: commandNamesForMode(appMode).join(","),
      }),
    );
    return CommandRegistration.of({});
  }),
);
