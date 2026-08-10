import { NodeHttpClient, NodeSocket } from "@effect/platform-node";
import {
  Config,
  Context,
  Effect,
  Layer,
  Schema,
  Stream,
  SubscriptionRef,
  Ref,
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
import { Database } from "../database/index.ts";
import { GameAdapters } from "../game/game-adapters/index.ts";
import { PollingState } from "../polling/state.ts";
import { commands } from "./commands.ts";
import { matchEmbed, type MatchReport } from "./embed.ts";
import { provisionRankEmojis } from "./rank-emojis.ts";

export class DiscordError extends Schema.TaggedError<DiscordError>()(
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

const DiscordApiLive = DiscordIxLive.pipe(
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(NodeSocket.layerWebSocketConstructor),
  Layer.provide(
    DiscordConfig.layerConfig({
      token: Config.redacted("DISCORD_BOT_TOKEN"),
      gateway: {
        intents: Config.succeed(Intents.fromList(["Guilds"])),
      },
    }),
  ),
);

const makeDiscord = Effect.gen(function* () {
  const rest = yield* DiscordREST;
  const registry = yield* InteractionsRegistry;
  const gateway = yield* DiscordGateway;
  const database = yield* Database;
  const gameAdapters = yield* GameAdapters;
  const pollingState = yield* PollingState;
  const channelId = yield* Config.nonEmptyString("NOTIFICATION_CHANNEL_ID");
  const devMode = yield* Config.boolean("DEV_MODE").pipe(
    Config.withDefault(false),
  );
  const rankEmojis = yield* provisionRankEmojis(gameAdapters.all).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        "application rank emojis unavailable; continuing without icons",
        error,
      ).pipe(Effect.as({})),
    ),
  );

  const notifyMatch = Effect.fn("Discord.notifyMatch")(
    function* (report: MatchReport) {
      yield* rest.createMessage(channelId, {
        embeds: [matchEmbed(report, rankEmojis)],
      });
    },
    Effect.mapError(
      (cause) => new DiscordError({ operation: "notifyMatch", cause }),
    ),
  );

  // registering forks the interaction loop and syncs the commands with discord.
  yield* registry.register(
    commands(
      { database, gameAdapters, rest, pollingState, notifyMatch },
      devMode,
    ),
  );
  yield* Effect.logInfo("slash commands registered").pipe(
    Effect.annotateLogs({ devMode }),
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

  // presence is per-connection state that discord drops on reconnect
  const gatewayReady = yield* Ref.make(false);
  yield* gateway
    .handleDispatch("READY", () =>
      Effect.gen(function* () {
        const reconnected = yield* Ref.getAndSet(gatewayReady, true);
        yield* Effect.logInfo(
          reconnected ? "discord gateway reconnected" : "discord gateway ready",
        );
        yield* setPresence(yield* SubscriptionRef.get(pollingState.paused));
      }),
    )
    .pipe(Effect.forkScoped);

  return Discord.of({ notifyMatch });
});

export const DiscordLive = Layer.effect(Discord, makeDiscord).pipe(
  Layer.provide(DiscordApiLive),
  Layer.provide(NodeHttpClient.layerUndici),
);
