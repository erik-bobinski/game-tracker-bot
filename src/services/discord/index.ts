import { NodeHttpClient, NodeSocket } from "@effect/platform-node";
import { Config, Layer } from "effect";
import { DiscordConfig, Intents } from "dfx";
import { DiscordIxLive } from "dfx/gateway";

const DiscordConfigLive = DiscordConfig.layerConfig({
  token: Config.redacted("DISCORD_BOT_TOKEN"),
  gateway: {
    intents: Config.succeed(Intents.fromList(["Guilds"])),
  },
});

export const DiscordLive = DiscordIxLive.pipe(
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(NodeSocket.layerWebSocketConstructor),
  Layer.provide(DiscordConfigLive),
);
