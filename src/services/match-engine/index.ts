import { Context, Effect, Layer } from "effect";
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
  readonly reportedMatchIds: ReadonlySet<MatchId>;
}

interface PendingMatch {
  readonly adapter: GameAdapter;
  readonly matchId: MatchId;
  readonly players: Array<TrackedPlayer>;
  // everyone tracked in this game, including anyone whose lookup missed it
  readonly tracked: ReadonlyArray<TrackedPlayer>;
  readonly currentRankSnapshots: Map<Puuid, RankSnapshots>;
}

const makeMatchEngine = Effect.gen(function* () {
  const database = yield* Database;
  const gameAdapters = yield* GameAdapters;
  const discord = yield* Discord;

  const pollOnce = Effect.fn("MatchEngine.pollOnce")(function* () {
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
    // updated as renames are saved, so a later match in this poll compares
    // against what an earlier one saved
    const savedRiotIds = new Map(
      accounts.map((account) => [
        account.discordUserId,
        `${account.riotName}#${account.riotTag}`,
      ]),
    );

    for (const adapter of gameAdapters.all) {
      const currentRankSnapshots = new Map<Puuid, RankSnapshots>();
      const tracked = accounts.flatMap((account) => {
        const state = account.games[adapter.game];
        const guildIds = account.guildIds.filter((id) => channels.has(id));
        if (!state || guildIds.length === 0) return [];
        // e.g. a valorant signup from before riot's api, until they /link
        if (adapter.requiresOptIn && !state.optedInAt) return [];
        currentRankSnapshots.set(state.puuid, state.rankSnapshots);

        const lastReportedAt = Math.max(
          0,
          ...state.reportedMatches.map((match) => match.date),
        );
        return [
          {
            riotId: `${account.riotName}#${account.riotTag}`,
            player: {
              discordName: account.discordName,
              discordUserId: account.discordUserId,
              puuid: state.puuid,
              region: state.region,
              guildIds,
              lastReportedAt,
              reportedMatchIds: new Set(
                state.reportedMatches.map((match) => match.matchId),
              ),
            },
          },
        ];
      });
      const trackedPlayers = tracked.map(({ player }) => player);
      accountsPolled += tracked.length;

      yield* Effect.forEach(
        tracked,
        ({ riotId, player }) =>
          Effect.gen(function* () {
            const matchIds = yield* adapter.getRecentMatchIds(
              player.puuid,
              player.region,
            );
            for (const matchId of matchIds) {
              if (player.reportedMatchIds.has(matchId)) continue;
              const id = `${adapter.game}:${matchId}`;
              const entry = pending.get(id);
              if (entry) entry.players.push(player);
              else {
                pending.set(id, {
                  adapter,
                  matchId,
                  players: [player],
                  tracked: trackedPlayers,
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
          Effect.map((match) => ({
            ...entry,
            match,
            // riot can list a match for one player before another, or one
            // player's lookup can fail, so whoever's list has it takes in the
            // others who played it, for one report
            players: [
              ...entry.players,
              ...entry.tracked.filter(
                (player) =>
                  !entry.players.includes(player) &&
                  !player.reportedMatchIds.has(entry.matchId) &&
                  match?.players.some((p) => p.puuid === player.puuid),
              ),
            ],
          })),
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

      // a /link sign-in can be a different riot account than the saved id, so
      // only games found by that id rename it; matches go oldest first, so
      // the newest name is saved last
      for (const player of adapter.requiresOptIn ? [] : fresh) {
        const current = match?.players.find((p) => p.puuid === player.puuid);
        if (!current?.riotName || !current.riotTag) continue;
        const riotId = `${current.riotName}#${current.riotTag}`;
        const saved = savedRiotIds.get(player.discordUserId);
        if (saved === riotId) continue;
        yield* database.updateRiotId({
          game: adapter.game,
          puuid: player.puuid,
          riotName: current.riotName,
          riotTag: current.riotTag,
        });
        savedRiotIds.set(player.discordUserId, riotId);
        yield* Effect.logInfo("riot id renamed").pipe(
          Effect.annotateLogs({ game: adapter.game, from: saved, to: riotId }),
        );
      }

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
