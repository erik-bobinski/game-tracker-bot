import { Context, Effect, Layer, Schema } from "effect";
import { Database } from "../database/index.ts";
import {
  type MatchDetails,
  type Puuid,
  type RankSnapshot,
  type RankUpdate,
} from "../game/index.ts";
import { Discord, type DiscordError } from "../discord/index.ts";
import { GameAdapters } from "../game/game-adapters/index.ts";
import { GameId, MatchId } from "../game/index.ts";
import type { SqlError } from "effect/unstable/sql/SqlError";

export class MatchEngine extends Context.Service<
  MatchEngine,
  {
    readonly pollOnce: () => Effect.Effect<
      void,
      SqlError | Schema.SchemaError | DiscordError
    >;
  }
>()("app/MatchEngine") {}

interface PendingMatch {
  readonly match: MatchDetails;
  readonly discordNames: Array<string>;
  readonly discordUserIds: Array<string>;
  readonly trackedPuuids: Array<Puuid>;
}

const makeMatchEngine = Effect.gen(function* () {
  const database = yield* Database;
  const gameAdapters = yield* GameAdapters;
  const discord = yield* Discord;

  const pollOnce = Effect.gen(function* () {
    const accounts = yield* database.getAccounts();
    const liveRankSnapshots = new Map(
      accounts.flatMap((account) =>
        Object.entries(account.games).flatMap(([game, state]) =>
          state
            ? [
                [
                  `${account.discordUserId}:${game}`,
                  state.rankSnapshots,
                ] as const,
              ]
            : [],
        ),
      ),
    );

    const matchesToReport = new Map<GameId, Map<MatchId, PendingMatch>>();

    for (const adapter of gameAdapters.all) {
      const matchesPerGame = new Map<MatchId, PendingMatch>();

      for (const account of accounts) {
        const gameState = account.games[adapter.game];
        if (!gameState) continue;

        const storedMatchIds = new Set(
          gameState.reportedMatches.map((m) => m.matchId),
        );
        const latestStoredDate = gameState.reportedMatches.reduce(
          (max, m) => (m.date > max ? m.date : max),
          0,
        );

        const recentMatches = yield* adapter
          .getRecentMatches(gameState.puuid, gameState.region)
          .pipe(
            Effect.catchTag("GameApiError", (error) =>
              Effect.logWarning("skipping account this poll", error).pipe(
                Effect.annotateLogs({
                  discordUser: `${account.discordName} (${account.discordUserId})`,
                }),
                Effect.as([]),
              ),
            ),
          );
        const unreportedMatches = recentMatches.filter(
          (match) =>
            !storedMatchIds.has(match.matchId) && match.date > latestStoredDate,
        );

        // users who shared a match land on the same entry, so it reports once
        for (const m of unreportedMatches) {
          const pending = matchesPerGame.get(m.matchId);
          if (pending) {
            pending.discordNames.push(account.discordName);
            pending.discordUserIds.push(account.discordUserId);
            pending.trackedPuuids.push(gameState.puuid);
          } else
            matchesPerGame.set(m.matchId, {
              match: m,
              discordNames: [account.discordName],
              discordUserIds: [account.discordUserId],
              trackedPuuids: [gameState.puuid],
            });
        }
      }
      matchesToReport.set(adapter.game, matchesPerGame);
    }

    const pending = [...matchesToReport.values()]
      .flatMap((perGame) => [...perGame.values()])
      .sort((a, b) => a.match.date - b.match.date);

    for (const {
      match,
      discordNames,
      discordUserIds,
      trackedPuuids,
    } of pending) {
      const adapter = gameAdapters.all.find(
        (candidate) => candidate.game === match.game,
      );
      const enrichment = adapter
        ? yield* adapter
            .enrichMatch({
              match,
              trackedPlayers: trackedPuuids.flatMap((puuid, index) => {
                const account = accounts.find(
                  (candidate) =>
                    candidate.discordUserId === discordUserIds[index],
                );
                const state = account?.games[match.game];
                return state
                  ? [
                      {
                        puuid: state.puuid,
                        region: state.region,
                        rankSnapshots:
                          liveRankSnapshots.get(
                            `${account.discordUserId}:${match.game}`,
                          ) ?? {},
                      },
                    ]
                  : [];
              }),
            })
            .pipe(
              Effect.catchTag("GameApiError", (error) =>
                Effect.logWarning(
                  "sending match report without optional enrichment",
                  error,
                ).pipe(
                  Effect.as({
                    match,
                    rankUpdates: new Map<string, RankUpdate>(),
                    rankSnapshots: new Map<
                      string,
                      Readonly<Record<string, RankSnapshot>>
                    >(),
                  }),
                ),
              ),
            )
        : {
            match,
            rankUpdates: new Map<string, RankUpdate>(),
            rankSnapshots: new Map<
              string,
              Readonly<Record<string, RankSnapshot>>
            >(),
          };
      yield* discord.notifyMatch({
        discordNames,
        trackedPuuids,
        match: enrichment.match,
        rankUpdates: enrichment.rankUpdates,
      });
      const rankSnapshotsByDiscordUserId = Object.fromEntries(
        trackedPuuids.flatMap((puuid, index) => {
          const snapshots = enrichment.rankSnapshots.get(puuid);
          const discordUserId = discordUserIds[index];
          return snapshots && discordUserId
            ? [[discordUserId, snapshots] as const]
            : [];
        }),
      );
      yield* database.markMatchAsReported({
        discordUserIds,
        game: enrichment.match.game,
        match: {
          matchId: enrichment.match.matchId,
          date: enrichment.match.date,
        },
        rankSnapshotsByDiscordUserId,
      });
      // league-v4 exposes only the current standing. Advancing the in-poll
      // snapshot makes the oldest queued report absorb the combined change and
      // later reports show zero, matching the bot's documented legacy behavior.
      for (const [discordUserId, snapshots] of Object.entries(
        rankSnapshotsByDiscordUserId,
      )) {
        liveRankSnapshots.set(
          `${discordUserId}:${enrichment.match.game}`,
          snapshots,
        );
      }
    }
  });

  return MatchEngine.of({ pollOnce: () => pollOnce });
});

export const MatchEngineLive = Layer.effect(MatchEngine, makeMatchEngine);
