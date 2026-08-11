import { Context, Effect, Layer } from "effect";
import { Database } from "../database/index.ts";
import { Discord } from "../discord/index.ts";
import {
  emptyEnrichment,
  GameAdapters,
  type GameAdapter,
} from "../game/game-adapters/index.ts";
import {
  GameId,
  MatchId,
  type MatchDetails,
  type Puuid,
  type RankSnapshots,
  type Region,
} from "../game/index.ts";

interface PendingPlayer {
  readonly discordName: string;
  readonly discordUserId: string;
  readonly puuid: Puuid;
  readonly region: Region | undefined;
}

interface PendingMatch {
  readonly adapter: GameAdapter;
  readonly match: MatchDetails;
  readonly players: Array<PendingPlayer>;
  readonly currentRankSnapshots: Map<Puuid, RankSnapshots>;
}

const makeMatchEngine = Effect.gen(function* () {
  const database = yield* Database;
  const gameAdapters = yield* GameAdapters;
  const discord = yield* Discord;

  const pollOnce = Effect.fn("MatchEngine.pollOnce")(function* () {
    const accounts = yield* database.getAccounts();
    const matchesToReport = new Map<GameId, Map<MatchId, PendingMatch>>();

    for (const adapter of gameAdapters.all) {
      const matchesPerGame = new Map<MatchId, PendingMatch>();
      const currentRankSnapshots = new Map<Puuid, RankSnapshots>();

      for (const account of accounts) {
        const gameState = account.games[adapter.game];
        if (!gameState) continue;
        currentRankSnapshots.set(gameState.puuid, gameState.rankSnapshots);

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
                  game: adapter.game,
                  discordUser: `${account.discordName} (${account.discordUserId})`,
                  riotId: `${account.riotName}#${account.riotTag}`,
                }),
                Effect.as([]),
              ),
            ),
          );
        const unreportedMatches = recentMatches.filter(
          (match) =>
            !storedMatchIds.has(match.matchId) && match.date > latestStoredDate,
        );

        for (const m of unreportedMatches) {
          const pending = matchesPerGame.get(m.matchId);
          const player = {
            discordName: account.discordName,
            discordUserId: account.discordUserId,
            puuid: gameState.puuid,
            region: gameState.region,
          };
          if (pending) pending.players.push(player);
          else
            matchesPerGame.set(m.matchId, {
              adapter,
              match: m,
              players: [player],
              currentRankSnapshots,
            });
        }
      }
      matchesToReport.set(adapter.game, matchesPerGame);
    }

    const pending = [...matchesToReport.values()]
      .flatMap((perGame) => [...perGame.values()])
      .sort((a, b) => a.match.date - b.match.date);

    for (const { adapter, match, players, currentRankSnapshots } of pending) {
      const enrichment = yield* adapter
        .enrichMatch({
          match,
          trackedPlayers: players.map(({ puuid, region }) => ({
            puuid,
            region,
            previousRankSnapshots: currentRankSnapshots.get(puuid) ?? {},
          })),
        })
        .pipe(
          Effect.catchTag("GameApiError", (error) =>
            Effect.logWarning(
              "sending match report without optional enrichment",
              error,
            ).pipe(Effect.as(emptyEnrichment(match))),
          ),
        );
      yield* discord.notifyMatch({
        discordNames: players.map((player) => player.discordName),
        trackedPuuids: players.map((player) => player.puuid),
        match: enrichment.match,
        rankUpdates: enrichment.rankUpdates,
      });
      const snapshotUpdates = players.flatMap((player) => {
        const snapshots = enrichment.updatedRankSnapshots.get(player.puuid);
        return snapshots ? [{ player, snapshots }] : [];
      });
      const rankSnapshotsByDiscordUserId = Object.fromEntries(
        snapshotUpdates.map(({ player, snapshots }) => [
          player.discordUserId,
          snapshots,
        ]),
      );
      yield* database.markMatchAsReported({
        discordUserIds: players.map((player) => player.discordUserId),
        game: enrichment.match.game,
        match: {
          matchId: enrichment.match.matchId,
          date: enrichment.match.date,
        },
        rankSnapshotsByDiscordUserId,
      });
      for (const { player, snapshots } of snapshotUpdates) {
        currentRankSnapshots.set(player.puuid, snapshots);
      }
    }

    return {
      accountsScanned: accounts.length,
      matchesReported: pending.length,
    };
  });

  return { pollOnce };
});

export class MatchEngine extends Context.Service<
  MatchEngine,
  Effect.Success<typeof makeMatchEngine>
>()("app/MatchEngine") {}

export const MatchEngineLive = Layer.effect(MatchEngine, makeMatchEngine);
