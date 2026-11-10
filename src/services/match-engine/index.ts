import { Clock, Context, Duration, Effect, Layer, Ref } from "effect";
import { Database } from "../database/index.ts";
import type { MatchReport } from "../discord/embed.ts";
import { Discord } from "../discord/index.ts";
import {
  CATCH_UP_MATCH_COUNT,
  enrichOrSkip,
  emptyEnrichment,
  GameAdapters,
  logApiWarning,
  RECENT_MATCH_COUNT,
  type GameAdapter,
} from "../game/game-adapters/index.ts";
import {
  EpochMillis,
  type MatchId,
  type Puuid,
  type RankSnapshots,
  type Region,
} from "../game/index.ts";

// Polls run every 3 minutes, so a longer gap means the bot was down, paused or
// failing, and the next poll looks further back to catch up.
const CATCH_UP_AFTER = Duration.minutes(10);
// A catch-up posts at most this many of a player's missed matches, the newest
// ones, so a long outage doesn't flood the channel.
const CATCH_UP_REPORT_LIMIT = 5;

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
  const lastPollAt = yield* Ref.make<number | undefined>(undefined);

  const pollOnce = Effect.fn("MatchEngine.pollOnce")(function* () {
    // reports by game:matchId for this poll only: a match discovered now posts
    // with its rank changes and is fetched once for all its servers. Retries
    // in later polls fetch it again and omit rank movement, so nothing about
    // a pending delivery, or the players in it, is held between polls.
    const reports = new Map<string, MatchReport>();
    const startedAt = yield* Clock.currentTimeMillis;
    const previousPollAt = yield* Ref.get(lastPollAt);
    const catchingUp =
      previousPollAt === undefined ||
      startedAt - previousPollAt > Duration.toMillis(CATCH_UP_AFTER);
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
              catchingUp ? CATCH_UP_MATCH_COUNT : RECENT_MATCH_COUNT,
            );
            // newest first, so anything past a reported match is older than
            // it and was either reported or deliberately skipped
            const known = matchIds.findIndex((id) =>
              player.reportedMatchIds.has(id),
            );
            const unseen = known === -1 ? matchIds : matchIds.slice(0, known);
            const skipped = unseen.length - CATCH_UP_REPORT_LIMIT;
            if (skipped > 0) {
              yield* Effect.logInfo("catch-up skipped older matches").pipe(
                Effect.annotateLogs({
                  game: adapter.game,
                  riotId,
                  skipped: known === -1 ? `${skipped}+` : skipped,
                }),
              );
            }
            for (const matchId of unseen.slice(0, CATCH_UP_REPORT_LIMIT)) {
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

    // lol and tft diff the live rank against the last saved one, so when
    // several of a player's matches turn up in one poll the movement can't be
    // split between them: only the newest shows it, labelled as covering all
    const foundThisPoll = new Map<
      string,
      { matchId: MatchId; count: number }
    >();
    for (const { adapter, matchId, players, match } of ready) {
      for (const player of players) {
        if (!match || match.date <= player.lastReportedAt) continue;
        const key = `${adapter.game}:${player.puuid}`;
        const count = (foundThisPoll.get(key)?.count ?? 0) + 1;
        foundThisPoll.set(key, { matchId, count });
      }
    }

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
        const rankUpdates = new Map(enrichment.rankUpdates);
        for (const player of fresh) {
          const snapshots = enrichment.updatedRankSnapshots.get(player.puuid);
          if (!snapshots) continue;
          const found = foundThisPoll.get(`${adapter.game}:${player.puuid}`);
          const update = rankUpdates.get(player.puuid);
          if (found && found.count > 1) {
            // the newest match diffs against the snapshot this one leaves
            if (found.matchId !== matchId) {
              rankUpdates.delete(player.puuid);
              continue;
            }
            if (update) {
              rankUpdates.set(player.puuid, {
                ...update,
                sinceLastCheck: true,
              });
            }
          }
          rankSnapshotsByDiscordUserId[player.discordUserId] = snapshots;
          currentRankSnapshots.set(player.puuid, snapshots);
        }
        reports.set(`${adapter.game}:${matchId}`, {
          tracked: fresh,
          match: enrichment.match,
          rankUpdates,
        });
        // Persist all destinations before advancing player discovery history.
        for (const guildId of new Set(fresh.flatMap((p) => p.guildIds))) {
          yield* database.queueDelivery({
            game: adapter.game,
            matchId,
            guildId,
            players: fresh
              .filter((p) => p.guildIds.includes(guildId))
              .map(({ discordUserId, puuid }) => ({ discordUserId, puuid })),
          });
        }
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

    let deliveryAttempts = 0;
    let deliveriesSucceeded = 0;
    const matchesReported = new Set<string>();
    const deliveries = yield* database.getPendingDeliveries();
    for (const delivery of deliveries) {
      const adapter = gameAdapters.all.find((a) => a.game === delivery.game);
      if (!adapter) continue;
      // Read each player just before posting: signout, untrack and account
      // replacement must keep queued reports from exposing a former
      // subscriber, even one who left earlier in this poll.
      const accounts = yield* Effect.forEach(delivery.players, (player) =>
        database.getAccount(player.discordUserId),
      );
      const tracked = delivery.players.flatMap((player, index) => {
        const account = accounts[index];
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
        yield* database.finishDelivery(delivery);
        continue;
      }
      const guild = yield* database.getGuild(delivery.guildId);
      if (!guild?.channelId || guild.paused) continue;
      const channelId = guild.channelId;
      const key = `${delivery.game}:${delivery.matchId}`;
      yield* Effect.gen(function* () {
        const cached = reports.get(key);
        const match =
          cached?.match ??
          (yield* adapter.getMatch(delivery.matchId, tracked[0]?.region));
        if (!match) return; // Leave queued if the API cannot currently decode it.
        const report = {
          tracked,
          match,
          rankUpdates:
            cached?.rankUpdates ?? emptyEnrichment(match).rankUpdates,
        };
        reports.set(key, report);
        deliveryAttempts += 1;
        yield* discord.notifyMatch(
          { guildId: delivery.guildId, channelId },
          report,
        );
        // Discord and SQLite cannot commit atomically. A crash after posting
        // but before this write can duplicate a delivery on the next poll.
        yield* database.finishDelivery(delivery);
        deliveriesSucceeded += 1;
        matchesReported.add(key);
      }).pipe(
        Effect.catchTag("DiscordError", (error) =>
          Effect.logWarning("match delivery queued for retry", error),
        ),
        Effect.catchTag("GameApiError", (error) =>
          logApiWarning("queued match unavailable; retrying next poll", error),
        ),
      );
    }

    yield* Ref.set(lastPollAt, startedAt);
    return {
      catchingUp,
      accountsScanned: accounts.length,
      accountsPolled,
      matchesReported: matchesReported.size,
      deliveryAttempts,
      deliveriesSucceeded,
    };
  });

  return { pollOnce };
});

export class MatchEngine extends Context.Service<
  MatchEngine,
  Effect.Success<typeof makeMatchEngine>
>()("app/MatchEngine") {}

export const MatchEngineLive = Layer.effect(MatchEngine, makeMatchEngine);
