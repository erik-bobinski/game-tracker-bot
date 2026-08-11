import { readFile } from "node:fs/promises";
import { Effect, Encoding } from "effect";
import { DiscordREST } from "dfx";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { GameAdapter } from "../game/game-adapters/index.ts";
import type { RankEmojis } from "./embed.ts";

const MAX_EMOJI_BYTES = 256 * 1024;

const emojiName = (game: GameAdapter["game"], key: string) =>
  `rank_${game}_${key}`;

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
    let reused = 0;
    let uploaded = 0;

    for (const adapter of adapters) {
      for (const icon of adapter.rankIcons) {
        const name = emojiName(adapter.game, icon.key);
        const existingEmoji = existingByName.get(name);
        if (existingEmoji) reused++;
        const emoji =
          existingEmoji ??
          (yield* Effect.gen(function* () {
            const bytes = icon.url.startsWith("file:")
              ? new Uint8Array(
                  yield* Effect.tryPromise({
                    try: () => readFile(new URL(icon.url)),
                    catch: (cause) =>
                      new Error(`could not read ${icon.url}: ${cause}`),
                  }),
                )
              : new Uint8Array(
                  yield* (yield* client.get(icon.url)).arrayBuffer,
                );
            if (bytes.byteLength > MAX_EMOJI_BYTES) {
              return yield* Effect.fail(
                new Error(`${name} exceeds Discord's 256 KiB emoji limit`),
              );
            }
            const created = yield* rest.createApplicationEmoji(application.id, {
              name,
              image: `data:image/png;base64,${Encoding.encodeBase64(bytes)}`,
            });
            uploaded++;
            return created;
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

    yield* Effect.logInfo("rank emoji provisioning finished").pipe(
      Effect.annotateLogs({ reused, uploaded }),
    );

    return resolved satisfies RankEmojis;
  },
);
