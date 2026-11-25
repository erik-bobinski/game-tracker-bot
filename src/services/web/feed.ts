// The website API's handlers. Every query is scoped to the signed-in viewer's
// servers, so a player only ever sees reports from servers they're tracked in.

import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Database } from "../database/index.ts";
import { Discord } from "../discord/index.ts";
import { SiteApi, Viewer } from "./api.ts";

const PAGE_SIZE = 20;

export const FeedLive = HttpApiBuilder.group(SiteApi, "feed", (handlers) =>
  Effect.gen(function* () {
    const database = yield* Database;
    const discord = yield* Discord;

    return handlers
      .handle("me", () =>
        Effect.gen(function* () {
          const { discordUserId } = yield* Viewer;
          const members = yield* database.getServerMembers(discordUserId);
          const guildIds = [...new Set(members.map((m) => m.guildId))];
          const servers = yield* Effect.forEach(
            guildIds,
            (guildId) =>
              discord.getServer(guildId).pipe(
                Effect.map((server) => ({
                  guildId,
                  name: Option.match(server, {
                    onNone: () => "Unknown server",
                    onSome: (found) => found.name,
                  }),
                  iconUrl: Option.getOrNull(
                    Option.flatMapNullishOr(server, (found) => found.iconUrl),
                  ),
                  players: members
                    .filter((member) => member.guildId === guildId)
                    .map(({ discordUserId, discordName }) => ({
                      discordUserId,
                      discordName,
                    })),
                })),
              ),
            { concurrency: 8 },
          );
          return {
            discordUserId,
            discordName:
              members.find((member) => member.discordUserId === discordUserId)
                ?.discordName ?? "",
            servers,
          };
        }).pipe(Effect.orDie),
      )
      .handle("feed", ({ query }) =>
        Effect.gen(function* () {
          const { discordUserId } = yield* Viewer;
          // one extra row says whether there's another page
          const rows = yield* database.getFeed({
            viewer: discordUserId,
            server: query.server,
            game: query.game,
            player: query.player,
            order: query.order ?? "newest",
            after: query.cursor,
            limit: PAGE_SIZE + 1,
          });
          const page = rows.slice(0, PAGE_SIZE);
          const last = page.at(-1);
          return {
            matches: page.map((row) => ({
              game: row.game,
              matchId: row.matchId,
              playedAt: row.playedAt,
              match: row.details,
              guildIds: [...new Set(row.posts.map((post) => post.guildId))],
              // a player tracked in two of the viewer's servers shows once
              players: row.posts
                .filter(
                  (post, index, posts) =>
                    posts.findIndex(
                      (other) => other.discordUserId === post.discordUserId,
                    ) === index,
                )
                .map(({ discordUserId, discordName, puuid, rankUpdate }) => ({
                  discordUserId,
                  discordName,
                  puuid,
                  rankUpdate,
                })),
            })),
            next:
              rows.length > PAGE_SIZE && last
                ? {
                    playedAt: last.playedAt,
                    game: last.game,
                    matchId: last.matchId,
                  }
                : null,
          };
        }).pipe(Effect.orDie),
      );
  }),
);
