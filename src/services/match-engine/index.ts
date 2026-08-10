import { Context, Effect, Layer } from "effect";
import { Database } from "../database/index.ts";
import { type MatchDetails } from "../game/index.ts";
import { Discord } from "../discord/index.ts";
import { GameAdapters } from "../game/game-adapters/index.ts";
import { GameId, MatchId } from "../game/index.ts";

interface PendingMatch {
  readonly match: MatchDetails;
  readonly discordNames: Array<string>;
  readonly discordUserIds: Array<string>;
  readonly trackedPuuids: Array<string>;
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
      const enrichedMatch = adapter
        ? yield* adapter
            .enrichMatch(match)
            .pipe(
              Effect.catchTag("GameApiError", (error) =>
                Effect.logWarning(
                  "sending match report without optional enrichment",
                  error,
                ).pipe(Effect.as(match)),
              ),
            )
        : match;
      yield* discord.notifyMatch({
        discordNames,
        trackedPuuids,
        match: enrichedMatch,
      });
      yield* database.markMatchAsReported({
        discordUserIds,
        game: enrichedMatch.game,
        match: {
          matchId: enrichedMatch.matchId,
          date: enrichedMatch.date,
        },
      });
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
