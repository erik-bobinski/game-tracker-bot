import * as HttpClientError from "effect/http/HttpClientError";
import { DateTime, Effect, Schema } from "effect";
import type { Account, Database } from "../database/index.ts";
import {
  logApiWarning,
  resolveGameState,
  type GameAdapters,
} from "../game/game-adapters/index.ts";
import { gameIds, gameNames, type GameId } from "../game/index.ts";

// Signup, link, track and untrack, shared by the discord commands, the admin
// cli and the riot sign-in callback. Only needs these two services, so each
// caller hands over its own (the cli builds adapters only when a command
// needs them).
export interface AccountDeps {
  readonly database: Database["Service"];
  readonly gameAdapters: GameAdapters["Service"];
}

// The given games for a riot id, each with its current matches pre-reported so
// the first poll doesn't repost old games. Games that need an opt-in are only
// looked up for someone who signed in with riot.
const resolveGames = (
  gameAdapters: GameAdapters["Service"],
  riotId: { readonly riotName: string; readonly riotTag: string },
  optedIn: boolean,
) =>
  Effect.gen(function* () {
    // kept as the record of when they opted in
    const optedInAt = optedIn
      ? DateTime.formatIso(yield* DateTime.now)
      : undefined;
    // a riot id may exist in only one game, so each lookup fails on its own
    const resolved = yield* Effect.forEach(
      gameAdapters.all.filter((adapter) => optedIn || !adapter.requiresOptIn),
      (adapter) =>
        resolveGameState(adapter, riotId.riotName, riotId.riotTag).pipe(
          Effect.map((state) => [
            {
              game: adapter.game,
              state: adapter.requiresOptIn ? { ...state, optedInAt } : state,
            },
          ]),
          // a failed lookup is not the same as "no such account", but
          // both leave this game untracked
          Effect.catch((error) =>
            logApiWarning("resolveAccount failed", error).pipe(
              Effect.annotateLogs({ game: adapter.game }),
              Effect.as([]),
            ),
          ),
        ),
      { concurrency: "unbounded" },
    );
    return resolved.flat();
  });

// every lookup failed, and not because the riot id doesn't exist
export class AccountLookupError extends Schema.TaggedError<AccountLookupError>()(
  "AccountLookupError",
  {},
) {}

// Only needs the two services, so the admin cli can call it too. Players pick
// their games, so only the ones passed in are tracked.
export const registerAccount = (
  { database, gameAdapters }: AccountDeps,
  input: Omit<Account, "games">,
  games: ReadonlyArray<GameId>,
  { optedIn = false }: { readonly optedIn?: boolean } = {},
) =>
  Effect.gen(function* () {
    // any game finding the riot id proves it exists
    const lookups = yield* Effect.forEach(
      gameAdapters.all,
      (adapter) =>
        adapter.resolveAccount(input.riotName, input.riotTag).pipe(
          Effect.as("found" as const),
          Effect.catch((error) =>
            logApiWarning("riot id lookup failed", error).pipe(
              Effect.as(
                HttpClientError.isHttpClientError(error) &&
                  error.response?.status === 404
                  ? ("not-found" as const)
                  : ("unavailable" as const),
              ),
            ),
          ),
        ),
      { concurrency: "unbounded" },
    );
    if (!lookups.includes("found")) {
      if (
        lookups.length > 0 &&
        lookups.every((result) => result === "not-found")
      )
        return "not-found" as const;
      return yield* Effect.fail(new AccountLookupError({}));
    }

    const resolved = yield* resolveGames(
      {
        all: gameAdapters.all.filter((adapter) => games.includes(adapter.game)),
      },
      input,
      optedIn,
    );

    const states: Account["games"] = {};
    for (const { game, state } of resolved) states[game] = state;
    yield* database.addAccount({ ...input, games: states });
    return "ok" as const;
  });

// After a riot sign-in: adds the games that needed it to the account, or,
// for someone who hadn't signed up, signs them up with the riot id they
// signed in as.
export const linkAccount = (
  deps: AccountDeps,
  link: {
    readonly discordUserId: string;
    readonly discordName: string;
    readonly guildId: string;
  },
  riotId: { readonly riotName: string; readonly riotTag: string },
) =>
  Effect.gen(function* () {
    // signing in is how they pick these games
    const optInAdapters = deps.gameAdapters.all.filter(
      (adapter) => adapter.requiresOptIn,
    );
    const account = yield* deps.database.getAccount(link.discordUserId);
    if (!account) {
      return yield* registerAccount(
        deps,
        { ...link, ...riotId, guildIds: [link.guildId] },
        optInAdapters.map((adapter) => adapter.game),
        { optedIn: true },
      );
    }

    const found = yield* resolveGames({ all: optInAdapters }, riotId, true);
    if (found.length === 0) return "not-found" as const;

    for (const { game, state } of found) {
      yield* deps.database.addGame({
        discordUserId: link.discordUserId,
        game,
        state,
      });
    }
    yield* deps.database.subscribe({
      guildId: link.guildId,
      discordUserId: link.discordUserId,
    });
    return "ok" as const;
  });

export const listGameNames = (games: ReadonlyArray<GameId>) =>
  games.map((game) => gameNames[game]).join(", ");

// A game that needs a riot sign-in only reports once they've signed in, even
// if an older signup left a row for it.
export const reportedGames = (
  gameAdapters: GameAdapters["Service"],
  account: Account,
) =>
  gameAdapters.all
    .filter((adapter) => {
      const state = account.games[adapter.game];
      return state && (!adapter.requiresOptIn || state.optedInAt);
    })
    .map((adapter) => adapter.game);

// Adds the picked games an account doesn't report yet. The ones that need a
// riot sign-in are left to /link.
export const trackGames = (
  { database, gameAdapters }: AccountDeps,
  account: Account,
  games: ReadonlyArray<GameId>,
) =>
  Effect.gen(function* () {
    const reported = reportedGames(gameAdapters, account);
    const alreadyTracked = games.filter((game) => reported.includes(game));
    const wanted = gameAdapters.all.filter(
      (adapter) =>
        games.includes(adapter.game) && !reported.includes(adapter.game),
    );
    const needsLink = wanted
      .filter((adapter) => adapter.requiresOptIn)
      .map((adapter) => adapter.game);

    const resolved = yield* Effect.forEach(
      wanted.filter((adapter) => !adapter.requiresOptIn),
      (adapter) =>
        resolveGameState(adapter, account.riotName, account.riotTag).pipe(
          Effect.map((state) => ({ game: adapter.game, state })),
          Effect.catch((error) =>
            logApiWarning("track lookup failed", error).pipe(
              Effect.annotateLogs({ game: adapter.game }),
              Effect.as({ game: adapter.game, state: undefined }),
            ),
          ),
        ),
      { concurrency: "unbounded" },
    );

    const added: Array<GameId> = [];
    const notFound: Array<GameId> = [];
    for (const { game, state } of resolved) {
      if (!state) {
        notFound.push(game);
        continue;
      }
      yield* database.addGame({
        discordUserId: account.discordUserId,
        game,
        state,
      });
      added.push(game);
    }

    return { added, alreadyTracked, needsLink, notFound };
  });

export const formatTrackResult = (
  result: Effect.Success<ReturnType<typeof trackGames>>,
  canLink: boolean,
) =>
  [
    result.added.length > 0 &&
      `Now reporting in every server you signed up in: ${listGameNames(result.added)}`,
    result.alreadyTracked.length > 0 &&
      `Already reporting: ${listGameNames(result.alreadyTracked)}`,
    result.needsLink.length > 0 &&
      (canLink
        ? `Run \`/link\` to add ${listGameNames(result.needsLink)}.`
        : `${listGameNames(result.needsLink)} needs a Riot sign-in, which isn't available yet.`),
    result.notFound.length > 0 &&
      `Couldn't look up ${listGameNames(result.notFound)} for your Riot ID, try again in a bit.`,
  ]
    .filter((line) => line !== false)
    .join("\n");

// Games are per account, so this stops them in every server it reports in.
export const untrackGames = (
  database: Database["Service"],
  account: Account,
  games: ReadonlyArray<GameId>,
) =>
  Effect.gen(function* () {
    const removed = games.filter((game) => account.games[game] !== undefined);
    const notTracked = games.filter(
      (game) => account.games[game] === undefined,
    );
    if (removed.length > 0) {
      yield* database.removeGames({
        discordUserId: account.discordUserId,
        games: removed,
      });
    }
    const remaining = gameIds.filter(
      (game) => account.games[game] !== undefined && !removed.includes(game),
    );
    return { removed, notTracked, remaining };
  });

export const formatUntrackResult = (
  result: Effect.Success<ReturnType<typeof untrackGames>>,
) =>
  [
    result.removed.length > 0
      ? `Stopped reporting in every server you signed up in: ${listGameNames(result.removed)}`
      : "Nothing to stop reporting.",
    result.notTracked.length > 0 &&
      `Wasn't reporting: ${listGameNames(result.notTracked)}`,
    result.remaining.length === 0 &&
      "You're still signed up, with no games. `/signout` removes your tracking from this server, and deletes your data if it's your last one.",
  ]
    .filter((line) => line !== false)
    .join("\n");

// The bot's words the site's walkthrough quotes, so it can't drift from them
