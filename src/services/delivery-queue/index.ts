import { Context, Effect, Layer, Schema } from "effect";
import { SqlSchema } from "effect/sql";
import { SqlClient } from "effect/sql/SqlClient";
import { Database } from "../database/index.ts";
import type { MatchReport } from "../discord/embed.ts";
import { Discord } from "../discord/index.ts";
import {
  enrichOrSkip,
  GameAdapters,
  logApiWarning,
} from "../game/game-adapters/index.ts";
import { GameId, MatchId, Puuid } from "../game/index.ts";

// A delivery is one match_deliveries row per (game, match, server) waiting to
// post. Its whole life is here: queued at discovery, tried on every poll,
// dropped after a day or once no subscribed player is left in it, and deleted
// when it posts. The one rule kept elsewhere is in SQL: the triggers of
// migration 7_create_match_deliveries (../database/index.ts) strip a player
// from queued rows the moment they untrack or sign out.

const DeliveryKey = Schema.Struct({
  game: GameId,
  matchId: MatchId,
  guildId: Schema.String,
});
const DeliveryPlayers = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      discordUserId: Schema.String,
      puuid: Puuid,
    }),
  ),
);
const PendingDelivery = Schema.Struct({
  ...DeliveryKey.fields,
  players: DeliveryPlayers,
});

// A match the poll in progress found, with the report only that poll can
// build: it alone holds the rank changes since the saved snapshots.
export interface DiscoveredMatch {
  readonly game: GameId;
  readonly matchId: MatchId;
  readonly report: MatchReport;
}

const makeDeliveryQueue = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const database = yield* Database;
  const gameAdapters = yield* GameAdapters;
  const discord = yield* Discord;

  const insert = SqlSchema.void({
    Request: PendingDelivery,
    execute: (
      row,
    ) => sql`INSERT INTO match_deliveries (game, match_id, guild_id, players)
      SELECT ${row.game}, ${row.matchId}, ${row.guildId}, ${row.players}
      WHERE EXISTS (SELECT 1 FROM guilds WHERE guild_id = ${row.guildId})
      ON CONFLICT (game, match_id, guild_id) DO UPDATE
      SET players = excluded.players, queued_at = CURRENT_TIMESTAMP
      WHERE json_array_length(match_deliveries.players) = 0`,
  });

  // A day-old row is dropped rather than retried: henrik can only refetch a
  // match still in a player's recent history, and a channel failing that long
  // shouldn't flood with its backlog once it works again.
  const expire = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DeliveryKey,
    execute: () => sql`DELETE FROM match_deliveries
      WHERE queued_at < datetime('now', '-1 day')
      RETURNING game, match_id AS "matchId", guild_id AS "guildId"`,
  });

  // oldest first; outside this module only tests and the live test read it
  const pending = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PendingDelivery,
    execute:
      () => sql`SELECT game, match_id AS "matchId", guild_id AS "guildId", players
      FROM match_deliveries ORDER BY rowid`,
  });
  const finish = SqlSchema.void({
    Request: DeliveryKey,
    execute: (row) => sql`DELETE FROM match_deliveries
      WHERE game = ${row.game} AND match_id = ${row.matchId} AND guild_id = ${row.guildId}`,
  });

  // One delivery per server any of the players reports in, naming only that
  // server's players. A server that already has the match queued keeps its
  // row unless everyone in it has since left, and a server that no longer
  // exists is skipped.
  const queue = Effect.fn("DeliveryQueue.queue")(function* (input: {
    readonly game: GameId;
    readonly matchId: MatchId;
    readonly players: ReadonlyArray<{
      readonly discordUserId: string;
      readonly puuid: Puuid;
      readonly guildIds: ReadonlyArray<string>;
    }>;
  }) {
    for (const guildId of new Set(input.players.flatMap((p) => p.guildIds))) {
      yield* insert({
        game: input.game,
        matchId: input.matchId,
        guildId,
        players: input.players
          .filter((p) => p.guildIds.includes(guildId))
          .map(({ discordUserId, puuid }) => ({ discordUserId, puuid })),
      });
    }
  });

  // Tries every pending delivery once, oldest first. A match discovered by
  // the poll calling this posts with its rank changes and is fetched once for
  // all its servers. Retries in later polls fetch it again and omit rank
  // movement, so nothing about a pending delivery, or the players in it, is
  // held between polls.
  const deliver = Effect.fn("DeliveryQueue.deliver")(function* (
    discovered: ReadonlyArray<DiscoveredMatch>,
  ) {
    let deliveryAttempts = 0;
    let deliveriesSucceeded = 0;
    const matchesReported = new Set<string>();
    const expired = yield* expire();

    if (expired.length > 0) {
      yield* Effect.logWarning("dropped day-old match deliveries").pipe(
        Effect.annotateLogs({
          deliveries: expired.map((d) => `${d.game}:${d.matchId}:${d.guildId}`),
        }),
      );
    }

    const deliveries = yield* pending();
    for (const delivery of deliveries) {
      const adapter = gameAdapters.all.find((a) => a.game === delivery.game);
      if (!adapter) continue;
      // Read each player just before posting: signout, untrack and account
      // replacement must keep queued reports from exposing a former
      // subscriber, even one who left earlier in this poll.
      const current = yield* database.getAccounts();

      const tracked = delivery.players.flatMap((player) => {
        const account = current.find(
          (candidate) => candidate.discordUserId === player.discordUserId,
        );

        const state = account?.games[delivery.game];
        return account &&
          account.guildIds.includes(delivery.guildId) &&
          state?.puuid === player.puuid &&
          (!adapter.requiresOptIn || state.optedInAt)
          ? [
              {
                ...player,
                discordName: account.discordName,
                region: state.region,
              },
            ]
          : [];
      });
      if (tracked.length === 0) {
        yield* finish(delivery);
        continue;
      }
      const guild = yield* database.getGuild(delivery.guildId);
      if (!guild?.channelId || guild.paused) continue;
      const channelId = guild.channelId;
      yield* Effect.gen(function* () {
        // A retry has lost the discovering poll's rank changes, so it enriches
        // the match again without the saved snapshots: names and current
        // ranks come back, and only movement that needs no snapshot (exact
        // per-match RR) is shown. Nothing it reads is saved.
        const report =
          discovered.find(
            (d) => d.game === delivery.game && d.matchId === delivery.matchId,
          )?.report ??
          (yield* Effect.gen(function* () {
            const match = yield* adapter.getMatch(
              delivery.matchId,
              tracked[0]?.region,
            );
            if (!match) return undefined;
            const enrichment = yield* enrichOrSkip(adapter, {
              match,
              trackedPlayers: tracked.map(({ puuid, region }) => ({
                puuid,
                region,
                previousRankSnapshots: {},
              })),
            });
            return { tracked, ...enrichment };
          }));
        if (!report) return; // Leave queued if the API cannot currently decode it.
        // only this server's players: the others' rank changes aren't its
        const trackedPuuids = new Set(tracked.map((p) => p.puuid));

        deliveryAttempts += 1;
        // Discord and SQLite cannot commit atomically. Not letting a shutdown
        // land between them leaves only a crash to duplicate a delivery.
        yield* Effect.uninterruptible(
          Effect.andThen(
            discord.notifyMatch(
              { guildId: delivery.guildId, channelId },
              {
                tracked,
                match: report.match,
                rankUpdates: new Map(
                  [...report.rankUpdates].filter(([puuid]) =>
                    trackedPuuids.has(puuid),
                  ),
                ),
              },
            ),
            finish(delivery),
          ),
        );
        deliveriesSucceeded += 1;
        matchesReported.add(`${delivery.game}:${delivery.matchId}`);
      }).pipe(
        Effect.catchTag("DiscordError", (error) =>
          Effect.logWarning("match delivery queued for retry", error),
        ),
        Effect.catchTag("GameApiError", (error) =>
          logApiWarning("queued match unavailable; retrying next poll", error),
        ),
      );
    }

    return {
      matchesReported: matchesReported.size,
      deliveryAttempts,
      deliveriesSucceeded,
    };
  });

  return { queue, deliver, pending };
});

export class DeliveryQueue extends Context.Service<
  DeliveryQueue,
  Effect.Success<typeof makeDeliveryQueue>
>()("app/DeliveryQueue") {}

export const DeliveryQueueLive = Layer.effect(DeliveryQueue, makeDeliveryQueue);
