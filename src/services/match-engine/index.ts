import { Clock, Context, Duration, Effect, Layer } from "effect";
import { Database } from "../database/index.ts";
import { Discord } from "../discord/index.ts";
import {
  enrichOrSkip,
  GameAdapters,
  logApiWarning,
  type GameAdapter,
} from "../game/game-adapters/index.ts";
import {
  EpochMillis,
  type MatchId,
  type Puuid,
  type RankSnapshots,
  type Region,
} from "../game/index.ts";

interface TrackedPlayer {
  readonly discordName: string;
  readonly discordUserId: string;
  readonly puuid: Puuid;
  readonly region: Region | undefined;
  // the servers they report in that have a channel and aren't paused
  readonly guildIds: ReadonlyArray<string>;
  // when the newest match reported for them started
  readonly lastReportedAt: number;
}

interface PendingMatch {
  readonly adapter: GameAdapter;
  readonly matchId: MatchId;
  readonly players: Array<TrackedPlayer>;
  readonly currentRankSnapshots: Map<Puuid, RankSnapshots>;
}

// Someone who just played is likely to queue again, so they're polled every
// minute, then less often the longer they stay idle, down to every 15 minutes.
// The first report after a break lags by up to an eighth of the break.
const pollInterval = (idleMillis: number) =>
  Duration.clamp(Duration.millis(idleMillis / 8), {
    minimum: Duration.minutes(1),
    maximum: Duration.minutes(15),
  });

const makeMatchEngine = Effect.gen(function* () {
  const database = yield* Database;
  const gameAdapters = yield* GameAdapters;
  const discord = yield* Discord;
  // when each riot account was last polled, per game; kept in memory, so a
  // restart polls everyone once
  const lastPolledAt = new Map<string, number>();

  const pollOnce = Effect.fn("MatchEngine.pollOnce")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const [accounts, guilds] = yield* Effect.all([
      database.getAccounts(),
      database.getGuilds(),
    ]);
    // an account is only polled while some server wants its reports
    const channels = new Map(
      guilds.flatMap((guild) =>
        guild.channelId && !guild.paused
          ? [[guild.guildId, guild.channelId] as const]
          : [],
      ),
    );
    const pending = new Map<string, PendingMatch>();
    let accountsPolled = 0;

    for (const adapter of gameAdapters.all) {
      const currentRankSnapshots = new Map<Puuid, RankSnapshots>();
      const due = accounts.flatMap((account) => {
        const state = account.games[adapter.game];
        const guildIds = account.guildIds.filter((id) => channels.has(id));
        if (!state || guildIds.length === 0) return [];
        currentRankSnapshots.set(state.puuid, state.rankSnapshots);

        const lastReportedAt = Math.max(
          0,
          ...state.reportedMatches.map((match) => match.date),
        );
        const key = `${adapter.game}:${state.puuid}`;
        const polledAt = lastPolledAt.get(key);
        if (
          polledAt !== undefined &&
          now - polledAt < Duration.toMillis(pollInterval(now - lastReportedAt))
        ) {
          return [];
        }

        return [
          {
            key,
            riotId: `${account.riotName}#${account.riotTag}`,
            reported: new Set(
              state.reportedMatches.map((match) => match.matchId),
            ),
            player: {
              discordName: account.discordName,
              discordUserId: account.discordUserId,
              puuid: state.puuid,
              region: state.region,
              guildIds,
              lastReportedAt,
            },
          },
        ];
      });
      accountsPolled += due.length;

      yield* Effect.forEach(
        due,
        ({ key, riotId, reported, player }) =>
          Effect.gen(function* () {
            // set up front, so an account whose lookup fails waits too
            lastPolledAt.set(key, now);
            const matchIds = yield* adapter.getRecentMatchIds(
              player.puuid,
              player.region,
            );
            for (const matchId of matchIds) {
              if (reported.has(matchId)) continue;
              const id = `${adapter.game}:${matchId}`;
              const entry = pending.get(id);
              if (entry) entry.players.push(player);
              else {
                pending.set(id, {
                  adapter,
                  matchId,
                  players: [player],
                  currentRankSnapshots,
                });
              }
            }
          }).pipe(
            Effect.catchTag("GameApiError", (error) =>
              logApiWarning("skipping account this poll", error).pipe(
                Effect.annotateLogs({
                  game: adapter.game,
                  discordUser: `${player.discordName} (${player.discordUserId})`,
                  riotId,
                }),
              ),
            ),
          ),
        // the api clients pace requests to their rate limits; this only
        // overlaps the latency
        { concurrency: 8, discard: true },
      );
    }

    // a match several tracked players were in is fetched once
    const fetched = yield* Effect.forEach(
      pending.values(),
      (entry) =>
        entry.adapter.getMatch(entry.matchId, entry.players[0]?.region).pipe(
          Effect.map((match) => ({ ...entry, match })),
          Effect.catchTag("GameApiError", (error) =>
            logApiWarning("match unavailable; retrying next poll", error).pipe(
              Effect.annotateLogs({ matchId: entry.matchId }),
              Effect.as(undefined),
            ),
          ),
        ),
      { concurrency: 8 },
    );
    const ready = fetched
      .filter((entry) => entry !== undefined)
      .sort((a, b) => (a.match?.date ?? 0) - (b.match?.date ?? 0));

    let matchesReported = 0;
    for (const {
      adapter,
      matchId,
      players,
      currentRankSnapshots,
      match,
    } of ready) {
      // a match older than what was already reported for someone showed up
      // late, and is skipped for them
      const fresh = match
        ? players.filter((player) => match.date > player.lastReportedAt)
        : [];
      const rankSnapshotsByDiscordUserId: Record<string, RankSnapshots> = {};

      if (match && fresh.length > 0) {
        const enrichment = yield* enrichOrSkip(adapter, {
          match,
          trackedPlayers: fresh.map(({ puuid, region }) => ({
            puuid,
            region,
            previousRankSnapshots: currentRankSnapshots.get(puuid) ?? {},
          })),
        });
        // one post per server, naming the players who report there
        for (const guildId of new Set(fresh.flatMap((p) => p.guildIds))) {
          const channelId = channels.get(guildId);
          if (!channelId) continue;
          yield* discord
            .notifyMatch(
              { guildId, channelId },
              {
                tracked: fresh.filter((player) =>
                  player.guildIds.includes(guildId),
                ),
                match: enrichment.match,
                rankUpdates: enrichment.rankUpdates,
              },
            )
            .pipe(
              // the match is marked reported anyway, so one server's
              // failure doesn't repost it everywhere else next poll
              Effect.catchTag("DiscordError", (error) =>
                Effect.logWarning("match report not posted", error).pipe(
                  Effect.annotateLogs({ guildId, channelId, matchId }),
                ),
              ),
            );
        }
        for (const player of fresh) {
          const snapshots = enrichment.updatedRankSnapshots.get(player.puuid);
          if (!snapshots) continue;
          rankSnapshotsByDiscordUserId[player.discordUserId] = snapshots;
          currentRankSnapshots.set(player.puuid, snapshots);
        }
        matchesReported += 1;
      }

      yield* database.markMatchAsReported({
        discordUserIds: players.map((player) => player.discordUserId),
        game: adapter.game,
        match: {
          matchId,
          // an undecodable match takes the newest reported date, so it stays
          // on the list instead of being fetched again
          date:
            match?.date ??
            EpochMillis.make(
              Math.max(...players.map((player) => player.lastReportedAt)),
            ),
        },
        rankSnapshotsByDiscordUserId,
      });
    }

    return {
      accountsScanned: accounts.length,
      accountsPolled,
      matchesReported,
    };
  });

  return { pollOnce };
});

export class MatchEngine extends Context.Service<
  MatchEngine,
  Effect.Success<typeof makeMatchEngine>
>()("app/MatchEngine") {}

export const MatchEngineLive = Layer.effect(MatchEngine, makeMatchEngine);
