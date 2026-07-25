import { Context, Effect, Layer, Schema } from "effect";
import { Database } from "../database/index.ts";
import { type MatchCandidate } from "../game/index.ts";
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

// an unreported match plus every tracked user who played in it
interface PendingMatch {
  readonly candidate: MatchCandidate;
  readonly discordNames: Array<string>;
}

const makeMatchEngine = Effect.gen(function* () {
  const database = yield* Database;
  const gameAdapters = yield* GameAdapters;
  const discord = yield* Discord;

  const pollOnce = Effect.gen(function* () {
    const accounts = yield* database.getAccounts(); // retrieve fresh accts from DB per-poll

    // unreported matches, grouped by game, grouped by matchId
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
          .getRecentMatches(gameState.puuid)
          .pipe(
            Effect.catchTag("GameApiError", (error) =>
              Effect.logWarning("skipping account this poll", error).pipe(
                Effect.annotateLogs({ discordUserId: account.discordUserId }),
                Effect.as([]),
              ),
            ),
          );
        const unreportedMatches = recentMatches.filter(
          (m) => !storedMatchIds.has(m.matchId) && m.date > latestStoredDate,
        );

        // users who shared a match land on the same entry, so it reports once
        for (const m of unreportedMatches) {
          const pending = matchesPerGame.get(m.matchId);
          if (pending) pending.discordNames.push(account.discordName);
          else
            matchesPerGame.set(m.matchId, {
              candidate: m,
              discordNames: [account.discordName],
            });
        }
      }
      matchesToReport.set(adapter.game, matchesPerGame);
    }

    const pending = [...matchesToReport.values()]
      .flatMap((perGame) => [...perGame.values()])
      .sort((a, b) => a.candidate.date - b.candidate.date);

    for (const { candidate, discordNames } of pending) {
      yield* discord.notifyMatch({ discordNames, match: candidate });
    }

    // TODO: Mark matches as reported only after successful delivery.
    // Need to ensure ring buffer maintains a static size
  });

  return MatchEngine.of({ pollOnce: () => pollOnce });
});

export const MatchEngineLive = Layer.effect(MatchEngine, makeMatchEngine);
