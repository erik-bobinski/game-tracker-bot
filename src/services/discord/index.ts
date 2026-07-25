import { NodeHttpClient, NodeSocket } from "@effect/platform-node";
import { Config, Context, Effect, Layer, Schema } from "effect";
import { DiscordConfig, DiscordREST, Intents } from "dfx";
import { DiscordIxLive, InteractionsRegistry } from "dfx/gateway";
import { Database } from "../database/index.ts";
import { GameAdapters } from "../game/game-adapters/index.ts";
import { commands } from "./commands.ts";
import { matchEmbed, type MatchReport } from "./embed.ts";

export class DiscordError extends Schema.TaggedErrorClass<DiscordError>()(
  "DiscordError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class Discord extends Context.Service<
  Discord,
  {
    // posts one message for a match, naming every tracked user in it
    readonly notifyMatch: (
      report: MatchReport,
    ) => Effect.Effect<void, DiscordError>;
  }
>()("app/Discord") {}

// dfx gateway + REST + interaction registry, wired from env config
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
  const database = yield* Database;
  const gameAdapters = yield* GameAdapters;
  const channelId = yield* Config.nonEmptyString("NOTIFICATION_CHANNEL_ID");

  // registering forks the interaction loop and syncs the commands with discord.
  yield* registry.register(commands({ database, gameAdapters }));

  const notifyMatch = Effect.fn("Discord.notifyMatch")(
    function* (report: MatchReport) {
      yield* rest.createMessage(channelId, { embeds: [matchEmbed(report)] });
    },
    Effect.mapError(
      (cause) => new DiscordError({ operation: "notifyMatch", cause }),
    ),
  );

  return Discord.of({ notifyMatch });
});

export const DiscordLive = Layer.effect(Discord, makeDiscord).pipe(
  Layer.provide(DiscordApiLive),
);
