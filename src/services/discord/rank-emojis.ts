import { Effect, Encoding } from "effect";
import { DiscordREST } from "dfx";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { GameAdapter } from "../game/game-adapters/index.ts";
import type { RankEmojis } from "./embed.ts";

const MAX_EMOJI_BYTES = 256 * 1024;

const emojiName = (game: GameAdapter["game"], key: string) =>
  game === "lol" ? `rank_lol_v2_${key}` : `rank_${game}_${key}`;

export const provisionRankEmojis = Effect.fn("Discord.provisionRankEmojis")(
  function* (adapters: ReadonlyArray<GameAdapter>) {
    const rest = yield* DiscordREST;
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({ times: 3 }),
    );
    const application = yield* rest.getMyOauth2Application();
    const { items: existing } = yield* rest.listApplicationEmojis(
      application.id,
    );
    const existingByName = new Map(
      existing.map((emoji) => [emoji.name, emoji]),
    );
    const resolved: Record<string, string> = {};

    for (const adapter of adapters) {
      for (const icon of adapter.rankIcons) {
        const name = emojiName(adapter.game, icon.key);
        const emoji =
          existingByName.get(name) ??
          (yield* Effect.gen(function* () {
            const response = yield* client.get(icon.url);
            const bytes = new Uint8Array(yield* response.arrayBuffer);
            if (bytes.byteLength > MAX_EMOJI_BYTES) {
              return yield* Effect.fail(
                new Error(`${name} exceeds Discord's 256 KiB emoji limit`),
              );
            }
            return yield* rest.createApplicationEmoji(application.id, {
              name,
              image: `data:image/png;base64,${Encoding.encodeBase64(bytes)}`,
            });
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("rank emoji provisioning failed", error).pipe(
                Effect.annotateLogs({ game: adapter.game, key: icon.key }),
                Effect.as(undefined),
              ),
            ),
          ));

        if (emoji)
          resolved[`${adapter.game}.${icon.key}`] = `<:${name}:${emoji.id}>`;
      }
    }

    return resolved satisfies RankEmojis;
  },
);
