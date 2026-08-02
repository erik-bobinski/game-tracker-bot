import { Context, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { Database } from "../database/index.ts";
import { Discord } from "../discord/index.ts";
import { GameAdapters } from "../game/game-adapters/index.ts";
import {
  GameId,
  MatchId,
  type MatchDetails,
  type TrackedGameAccount,
} from "../game/index.ts";

export interface PollSummary {
  readonly accountsChecked: number;
  readonly apiFailures: number;
  readonly discoveredMatches: number;
  readonly reportsSent: number;
  readonly reportFailures: number;
}

export class MatchEngine extends Context.Service<
  MatchEngine,
  {
    readonly pollOnce: () => Effect.Effect<
      PollSummary,
      SqlError | Schema.SchemaError
    >;
  }
>()("app/MatchEngine") {}

interface PendingMatch {
  readonly match: MatchDetails;
  readonly discordNames: Array<string>;
  readonly discordUserIds: Array<string>;
  readonly trackedPuuids: Array<string>;
}

export const MatchEngineLive = Layer.effect(
  MatchEngine,
  Effect.gen(function* () {
    const database = yield* Database;
    const gameAdapters = yield* GameAdapters;
    const discord = yield* Discord;

    const pollOnce = Effect.fn("MatchEngine.pollOnce")(function* () {
      const accounts = yield* database.getAccounts();
      const matchesToReport = new Map<GameId, Map<MatchId, PendingMatch>>();
      let accountsChecked = 0;
      let apiFailures = 0;

      for (const adapter of gameAdapters.all) {
        const matchesPerGame = new Map<MatchId, PendingMatch>();
        for (const account of accounts) {
          const gameState = account.games[adapter.game];
          if (!gameState) continue;
          accountsChecked += 1;
          const storedMatchIds = new Set(
            gameState.reportedMatches.map((match) => match.matchId),
          );
          let cutoff = Number(gameState.trackingStartedAt);
          for (const reported of gameState.reportedMatches) {
            cutoff = Math.max(cutoff, Number(reported.date));
          }
          const tracked: TrackedGameAccount = gameState;
          const recentMatches = yield* adapter.getRecentMatches(tracked).pipe(
            Effect.catchTag("GameApiError", (error) => {
              apiFailures += 1;
              return Effect.logWarning(
                "skipping account this poll",
                error,
              ).pipe(
                Effect.annotateLogs({
                  game: adapter.game,
                  discordUser: `${account.discordName} (${account.discordUserId})`,
                }),
                Effect.as<ReadonlyArray<MatchDetails>>([]),
              );
            }),
          );
          for (const match of recentMatches) {
            if (
              storedMatchIds.has(match.matchId) ||
              Number(match.date) <= cutoff
            ) {
              continue;
            }
            const pending = matchesPerGame.get(match.matchId);
            if (pending) {
              pending.discordNames.push(account.discordName);
              pending.discordUserIds.push(account.discordUserId);
              pending.trackedPuuids.push(gameState.puuid);
            } else {
              matchesPerGame.set(match.matchId, {
                match,
                discordNames: [account.discordName],
                discordUserIds: [account.discordUserId],
                trackedPuuids: [gameState.puuid],
              });
            }
          }
        }
        matchesToReport.set(adapter.game, matchesPerGame);
      }

      const pending = [...matchesToReport.values()]
        .flatMap((perGame) => [...perGame.values()])
        .sort((left, right) => left.match.date - right.match.date);
      let reportsSent = 0;
      let reportFailures = 0;

      for (const report of pending) {
        const adapter = gameAdapters.all.find(
          (candidate) => candidate.game === report.match.game,
        );
        const match = adapter
          ? yield* adapter
              .enrichMatch(report.match)
              .pipe(
                Effect.catchTag("GameApiError", (error) =>
                  Effect.logWarning(
                    "sending match report without optional enrichment",
                    error,
                  ).pipe(Effect.as(report.match)),
                ),
              )
          : report.match;
        const sent = yield* discord
          .notifyMatch({
            discordNames: report.discordNames,
            trackedPuuids: report.trackedPuuids,
            match,
          })
          .pipe(
            Effect.as(true),
            Effect.catchTag("DiscordError", (error) =>
              Effect.logError("match notification failed", error).pipe(
                Effect.annotateLogs({
                  game: match.game,
                  matchId: match.matchId,
                }),
                Effect.as(false),
              ),
            ),
          );
        if (!sent) {
          reportFailures += 1;
          continue;
        }
        reportsSent += 1;
        yield* database.markMatchAsReported({
          discordUserIds: report.discordUserIds,
          game: match.game,
          match: { matchId: match.matchId, date: match.date },
        });
      }

      return {
        accountsChecked,
        apiFailures,
        discoveredMatches: pending.length,
        reportsSent,
        reportFailures,
      };
    });

    return MatchEngine.of({ pollOnce });
  }),
);
