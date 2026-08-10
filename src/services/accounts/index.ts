import { Effect } from "effect";
import type { Account, Database } from "../database/index.ts";
import type { GameAdapters } from "../game/game-adapters/index.ts";

// Signing someone up needs nothing from discord, so the admin cli reuses it
export interface AccountDeps {
  readonly database: Database["Service"];
  readonly gameAdapters: GameAdapters["Service"];
}

// pre-reports current matches so the first poll doesn't repost old games
export const registerAccount = (
  { database, gameAdapters }: AccountDeps,
  input: Omit<Account, "games">,
) =>
  Effect.gen(function* () {
    // a riot id may exist in only one game, so each lookup fails on its own
    const resolved = yield* Effect.forEach(
      gameAdapters.all,
      (adapter) =>
        adapter.resolveAccount(input.riotName, input.riotTag).pipe(
          Effect.flatMap(({ puuid, region }) =>
            adapter.getRecentMatches(puuid, region).pipe(
              Effect.catchTag("GameApiError", (error) =>
                Effect.logWarning("baseline match fetch failed", error).pipe(
                  Effect.as([]),
                ),
              ),
              Effect.map((matches) => ({
                game: adapter.game,
                state: {
                  puuid,
                  reportedMatches: matches.map((match) => ({
                    matchId: match.matchId,
                    date: match.date,
                  })),
                  // matches carry the platformId they were played on, which
                  // covers accounts the region lookup couldn't resolve
                  region: region ?? matches[0]?.routingRegion,
                },
              })),
            ),
          ),
          // a failed lookup is not the same as "no such account", but
          // both leave this game untracked
          Effect.catch((error) =>
            Effect.logWarning("resolveAccount failed", error).pipe(
              Effect.annotateLogs({ game: adapter.game }),
              Effect.as(undefined),
            ),
          ),
        ),
      { concurrency: "unbounded" },
    );

    const games: Account["games"] = {};
    for (const entry of resolved) {
      if (entry) games[entry.game] = entry.state;
    }

    if (Object.keys(games).length === 0) return "not-found" as const;

    yield* database.addAccount({ ...input, games });
    return "ok" as const;
  });
