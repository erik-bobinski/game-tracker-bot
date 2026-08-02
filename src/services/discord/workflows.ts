import { Clock, Effect } from "effect";
import type { Account, Database } from "../database/index.ts";
import type { GameAdapter, GameAdapters } from "../game/game-adapters/index.ts";
import type { DevSimulator, StageMatchInput } from "../game/dev-simulator.ts";
import {
  EpochMillis,
  type GameId,
  type RankSummary,
  type ResolvedGameAccount,
} from "../game/index.ts";
import type { PollResult, Polling } from "../polling/index.ts";

const gameLabel = (game: GameId) => (game === "lol" ? "LoL" : "Valorant");

export interface WorkflowDeps {
  readonly database: Database["Service"];
  readonly gameAdapters: GameAdapters["Service"];
}

type DiscoveryResult =
  | { readonly _tag: "AlreadyTracked"; readonly adapter: GameAdapter }
  | {
      readonly _tag: "Found";
      readonly adapter: GameAdapter;
      readonly account: ResolvedGameAccount;
    }
  | { readonly _tag: "NotFound"; readonly adapter: GameAdapter }
  | { readonly _tag: "Failed"; readonly adapter: GameAdapter };

export const signupWorkflow = Effect.fn("Commands.signup")(function* (
  deps: WorkflowDeps,
  input: {
    readonly discordUserId: string;
    readonly discordName: string;
    readonly riotName: string;
    readonly riotTag: string;
  },
) {
  const existing = yield* deps.database.getAccount(input.discordUserId);
  const discover = (adapter: GameAdapter): Effect.Effect<DiscoveryResult> => {
    if (existing?.games[adapter.game]) {
      return Effect.succeed({ _tag: "AlreadyTracked" as const, adapter });
    }
    return adapter.resolveAccount(input.riotName, input.riotTag).pipe(
      Effect.map((account) => ({
        _tag: "Found" as const,
        adapter,
        account,
      })),
      Effect.catchTags({
        AccountNotFound: () =>
          Effect.succeed({ _tag: "NotFound" as const, adapter }),
        GameApiError: (error) =>
          Effect.logWarning("signup game discovery failed", error).pipe(
            Effect.annotateLogs({ game: adapter.game }),
            Effect.as({ _tag: "Failed" as const, adapter }),
          ),
      }),
    );
  };
  const checked = yield* Effect.forEach(deps.gameAdapters.all, discover, {
    concurrency: 2,
  });
  const startedAt = EpochMillis.make(yield* Clock.currentTimeMillis);
  const games: Account["games"] = {};
  for (const result of checked) {
    if (result._tag !== "Found") continue;
    games[result.adapter.game] = {
      ...result.account,
      trackingStartedAt: startedAt,
      reportedMatches: [],
    };
  }
  const added = checked
    .filter((result) => result._tag === "Found")
    .map((result) => gameLabel(result.adapter.game));
  const failed = checked
    .filter((result) => result._tag === "Failed")
    .map((result) => gameLabel(result.adapter.game));
  const already = checked
    .filter((result) => result._tag === "AlreadyTracked")
    .map((result) => gameLabel(result.adapter.game));

  if (added.length > 0) {
    yield* deps.database.addAccount({
      discordUserId: input.discordUserId,
      discordName: input.discordName,
      riotName: input.riotName,
      riotTag: input.riotTag,
      games,
    });
  }

  const parts: Array<string> = [];
  if (added.length > 0) parts.push(`Now tracking ${added.join(" and ")}.`);
  if (already.length > 0) {
    parts.push(`Already tracking ${already.join(" and ")}.`);
  }
  if (failed.length > 0) {
    parts.push(`Could not check ${failed.join(" and ")}; please try again.`);
  }
  if (parts.length === 0) {
    return "That Riot ID was not found in LoL or Valorant.";
  }
  return parts.join(" ");
});

export const signoutWorkflow = Effect.fn("Commands.signout")(function* (
  database: Database["Service"],
  discordUserId: string,
  game?: GameId,
) {
  const deleted = game
    ? yield* database.deleteGame(discordUserId, game)
    : yield* database.deleteAccount(discordUserId);
  if (!deleted) {
    return game
      ? `You were not tracking ${gameLabel(game)}.`
      : "You did not have a tracked account.";
  }
  return game
    ? `Stopped tracking ${gameLabel(game)}.`
    : "Stopped tracking all of your games.";
});

export type RankCheckResult =
  | { readonly _tag: "Message"; readonly content: string }
  | {
      readonly _tag: "Ranks";
      readonly discordName: string;
      readonly game: GameId;
      readonly ranks: ReadonlyArray<RankSummary>;
      readonly iconUrl?: string;
    };

export const rankCheckWorkflow = Effect.fn("Commands.rankCheck")(function* (
  deps: WorkflowDeps,
  discordUserId: string,
  game: GameId,
) {
  const account = yield* deps.database.getAccount(discordUserId);
  const gameState = account?.games[game];
  if (!gameState) {
    return {
      _tag: "Message",
      content: `That user is not tracking ${gameLabel(game)}.`,
    } as const;
  }
  const adapter = deps.gameAdapters.all.find(
    (candidate) => candidate.game === game,
  );
  if (!adapter) {
    return {
      _tag: "Message",
      content: `${gameLabel(game)} is not currently supported.`,
    } as const;
  }
  const ranks = yield* adapter.getRanks(gameState);
  if (ranks.length === 0) {
    return { _tag: "Message", content: "Unranked." } as const;
  }
  const iconKey = ranks.find((rank) => rank.rankIconKey)?.rankIconKey;
  const iconUrl = adapter.rankIcons.find((icon) => icon.key === iconKey)?.url;
  return {
    _tag: "Ranks",
    discordName: account.discordName,
    game,
    ranks,
    ...(iconUrl ? { iconUrl } : {}),
  } as const;
});

export const pollResultText = (result: PollResult) =>
  result._tag === "Paused"
    ? "Polling is paused; no pass ran."
    : [
        `Checked: ${result.summary.accountsChecked}`,
        `API failures: ${result.summary.apiFailures}`,
        `Matches: ${result.summary.discoveredMatches}`,
        `Sent: ${result.summary.reportsSent}`,
        `Send failures: ${result.summary.reportFailures}`,
      ].join(" · ");

export const devStageMatchWorkflow = Effect.fn("Commands.devStageMatch")(
  function* (
    deps: WorkflowDeps & {
      readonly simulator: DevSimulator["Service"];
    },
    input: Omit<StageMatchInput, "players"> & {
      readonly discordUserId: string;
      readonly teammateDiscordUserId?: string;
    },
  ) {
    const account = yield* deps.database.getAccount(input.discordUserId);
    const state = account?.games[input.game];
    if (!account || !state) {
      return `Sign up for ${gameLabel(input.game)} before staging a match.`;
    }
    const players = [
      {
        riotName: account.riotName,
        riotTag: account.riotTag,
        puuid: state.puuid,
        route: state.route,
      },
    ];
    if (input.teammateDiscordUserId) {
      const teammate = yield* deps.database.getAccount(
        input.teammateDiscordUserId,
      );
      const teammateState = teammate?.games[input.game];
      if (!teammate || !teammateState) {
        return `The teammate is not tracking ${gameLabel(input.game)}.`;
      }
      if (teammateState.route !== state.route) {
        return "The teammate must use the same game route.";
      }
      players.push({
        riotName: teammate.riotName,
        riotTag: teammate.riotTag,
        puuid: teammateState.puuid,
        route: teammateState.route,
      });
    }
    const matchId = yield* deps.simulator.stageMatch({
      game: input.game,
      result: input.result,
      mode: input.mode,
      surrendered: input.surrendered,
      duplicate: input.duplicate,
      players,
    });
    return `Staged ${gameLabel(input.game)} match ${matchId}.`;
  },
);

export const resumeWorkflow = Effect.fn("Commands.resume")(function* (
  polling: Polling["Service"],
  setPaused: (paused: boolean) => Effect.Effect<void>,
) {
  yield* setPaused(false);
  return yield* polling.runOnce();
});

export const adapterFor = (
  adapters: GameAdapters["Service"],
  game: GameId,
): GameAdapter | undefined =>
  adapters.all.find((adapter) => adapter.game === game);
