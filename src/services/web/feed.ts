// The website API's handlers. Every query is scoped to the signed-in viewer's
// servers, so a player only ever sees reports from servers they're tracked in.

import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Database } from "../database/index.ts";
import { defaultAvatarUrl, Discord } from "../discord/index.ts";
import { GameAdapters } from "../game/game-adapters/index.ts";
import { gameNames } from "../game/index.ts";
import { SiteApi, Viewer } from "./api.ts";

// matches show as one-line summaries, so a page holds plenty
const PAGE_SIZE = 50;

// A few icons ship in the repo's assets folder as file urls, which the card
// renderer reads; a browser gets them from the site instead.
const browserUrl = (url: string) =>
  url.startsWith("file:") ? `/game-assets/${url.split("/").at(-1)}` : url;

export const FeedLive = HttpApiBuilder.group(SiteApi, "feed", (handlers) =>
  Effect.gen(function* () {
    const database = yield* Database;
    const discord = yield* Discord;
    const games = (yield* GameAdapters).all.map((adapter) => ({
      game: adapter.game,
      name: gameNames[adapter.game],
      iconUrl: browserUrl(adapter.iconUrl),
      rankIcons: adapter.rankIcons.map(({ key, url }) => ({
        key,
        url: browserUrl(url),
      })),
    }));

    return handlers
      .handle("me", () =>
        Effect.gen(function* () {
          const { discordUserId } = yield* Viewer;
          const members = yield* database.getServerMembers(discordUserId);
          const guildIds = [...new Set(members.map((m) => m.guildId))];
          // each player once, however many of the viewer's servers they're in
          const avatars = new Map(
            yield* Effect.forEach(
              new Set(members.map((m) => m.discordUserId)),
              (id) =>
                discord
                  .getAvatarUrl(id)
                  .pipe(Effect.map((url) => [id, url] as const)),
              { concurrency: 8 },
            ),
          );
          const avatarUrl = (id: string) =>
            avatars.get(id) ?? defaultAvatarUrl(id);
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
                      avatarUrl: avatarUrl(discordUserId),
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
            avatarUrl: avatarUrl(discordUserId),
            servers,
            games,
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
