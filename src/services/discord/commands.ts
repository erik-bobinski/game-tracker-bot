import { Discord, DiscordREST, Ix } from "dfx";
import { Clock, Effect, Option, Schema, SubscriptionRef } from "effect";
import type { AppMode } from "../config.ts";
import type { Account, Database } from "../database/index.ts";
import {
  MOCK_ACCOUNTS,
  type DevSimulator,
  type StageMatchInput,
} from "../game/dev-simulator.ts";
import type { GameAdapter, GameAdapters } from "../game/game-adapters/index.ts";
import {
  EpochMillis,
  GameId as GameIdSchema,
  type GameId,
  type ResolvedGameAccount,
} from "../game/index.ts";
import type { PollResult, Polling } from "../polling/index.ts";
import type { PollingState } from "../polling/state.ts";
import { rankEmbed, type RankCheckRanks } from "./embed.ts";

export interface CommandDeps {
  readonly appMode: AppMode;
  readonly database: Database["Service"];
  readonly gameAdapters: GameAdapters["Service"];
  readonly polling: Polling["Service"];
  readonly rest: Effect.Success<typeof DiscordREST>;
  readonly pollingState: PollingState["Service"];
  readonly simulator: DevSimulator["Service"];
}

const gameLabel = (game: GameId) => (game === "lol" ? "LoL" : "Valorant");

const reply = (content: string): Discord.CreateInteractionResponseRequest => ({
  type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
  data: { content },
});

const deferredReply: Discord.CreateInteractionResponseRequest = {
  type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
};

const userFor = (interaction: {
  readonly interaction: Discord.APIInteraction;
}) => interaction.interaction.member?.user ?? interaction.interaction.user;

const detachFollowUp = <E>(
  rest: CommandDeps["rest"],
  interaction: Discord.APIInteraction,
  operation: Effect.Effect<
    string | Discord.IncomingWebhookUpdateRequestPartial,
    E
  >,
  failureMessage: string,
) => {
  const update = (payload: Discord.IncomingWebhookUpdateRequestPartial) =>
    rest.updateOriginalWebhookMessage(
      interaction.application_id,
      interaction.token,
      { payload },
    );
  return operation.pipe(
    Effect.flatMap((result) =>
      update(typeof result === "string" ? { content: result } : result),
    ),
    Effect.catch((error) =>
      Effect.logError("deferred command failed", error).pipe(
        Effect.andThen(update({ content: failureMessage })),
        Effect.ignore({ log: "Error", message: "command follow-up failed" }),
      ),
    ),
    Effect.forkDetach,
  );
};

const gameChoices = [
  { name: "League of Legends", value: "lol" },
  { name: "Valorant", value: "valorant" },
] as const;

export const commandNamesForMode = (appMode: AppMode) => [
  "signup",
  "signout",
  "pause",
  "resume",
  "rank_check",
  ...(appMode === "development"
    ? ["dev_accounts", "dev_match", "dev_poll"]
    : []),
];

const MatchResult = Schema.Literals(["victory", "defeat"]);
const MatchMode = Schema.Literals(["ranked", "unranked"]);

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
  database: Database["Service"],
  gameAdapters: GameAdapters["Service"],
  input: {
    readonly discordUserId: string;
    readonly discordName: string;
    readonly riotName: string;
    readonly riotTag: string;
  },
) {
  const existing = yield* database.getAccount(input.discordUserId);
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
  const checked = yield* Effect.forEach(gameAdapters.all, discover, {
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
    yield* database.addAccount({
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

const signup = (deps: CommandDeps) =>
  Ix.global(
    {
      name: "signup",
      description: "Get your Riot account's match results reported",
      options: [
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "riot_name",
          description: "before the # (for example, MockAlpha)",
          required: true,
        },
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "riot_tag",
          description: "after the # (for example, NA1)",
          required: true,
        },
      ],
    },
    (i) =>
      Effect.gen(function* () {
        const user = userFor(i);
        if (!user) return reply("Couldn't tell who ran that command.");
        yield* detachFollowUp(
          deps.rest,
          i.interaction,
          signupWorkflow(deps.database, deps.gameAdapters, {
            discordUserId: user.id,
            discordName: user.username,
            riotName: i.optionValue("riot_name"),
            riotTag: i.optionValue("riot_tag"),
          }),
          "Signup failed; please try again shortly.",
        );
        return deferredReply;
      }),
  );

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

const signout = (deps: CommandDeps) =>
  Ix.global(
    {
      name: "signout",
      description: "Stop tracking one game or your entire account",
      options: [
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "game",
          description: "omit to stop tracking every game",
          required: false,
          choices: gameChoices,
        },
      ],
    },
    (i) =>
      Effect.gen(function* () {
        const user = userFor(i);
        if (!user) return reply("Couldn't tell who ran that command.");
        const rawGame = Option.getOrUndefined(i.optionValueOptional("game"));
        const game = rawGame
          ? yield* Schema.decodeUnknownEffect(GameIdSchema)(rawGame)
          : undefined;
        return reply(yield* signoutWorkflow(deps.database, user.id, game));
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("signout failed", error).pipe(
            Effect.as(reply("Signout failed; please try again shortly.")),
          ),
        ),
      ),
  );

const pause = (deps: CommandDeps) =>
  Ix.global(
    {
      name: "pause",
      description: "Pause all match reports (the bot appears idle)",
    },
    () =>
      SubscriptionRef.set(deps.pollingState.paused, true).pipe(
        Effect.as(reply("Match reports paused.")),
      ),
  );

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

const resume = (deps: CommandDeps) =>
  Ix.global(
    {
      name: "resume",
      description: "Resume reports and run a polling pass now",
    },
    (i) =>
      Effect.gen(function* () {
        yield* SubscriptionRef.set(deps.pollingState.paused, false);
        yield* detachFollowUp(
          deps.rest,
          i.interaction,
          deps.polling
            .runOnce()
            .pipe(
              Effect.map(
                (result) => `Match reports resumed. ${pollResultText(result)}`,
              ),
            ),
          "Reports resumed, but the immediate poll failed; the schedule will retry.",
        );
        return deferredReply;
      }),
  );

export type RankCheckResult =
  | { readonly _tag: "Message"; readonly content: string }
  | ({ readonly _tag: "Ranks" } & RankCheckRanks);

export const rankCheckWorkflow = Effect.fn("Commands.rankCheck")(function* (
  database: Database["Service"],
  gameAdapters: GameAdapters["Service"],
  discordUserId: string,
  game: GameId,
) {
  const account = yield* database.getAccount(discordUserId);
  const gameState = account?.games[game];
  if (!gameState) {
    return {
      _tag: "Message",
      content: `That user is not tracking ${gameLabel(game)}.`,
    } as const;
  }
  const adapter = gameAdapters.all.find((candidate) => candidate.game === game);
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

const rankCheck = (deps: CommandDeps) =>
  Ix.global(
    {
      name: "rank_check",
      description: "Check a signed-up user's Valorant or League rank",
      options: [
        {
          type: Discord.ApplicationCommandOptionType.USER,
          name: "user",
          description: "the Discord user to check",
          required: true,
        },
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "game",
          description: "which game's rank to check",
          required: true,
          choices: gameChoices,
        },
      ],
    },
    (i) =>
      Effect.gen(function* () {
        const game = yield* Schema.decodeUnknownEffect(GameIdSchema)(
          i.optionValue("game"),
        );
        yield* detachFollowUp(
          deps.rest,
          i.interaction,
          rankCheckWorkflow(
            deps.database,
            deps.gameAdapters,
            i.optionValue("user"),
            game,
          ).pipe(
            Effect.map((result) =>
              result._tag === "Message"
                ? { content: result.content }
                : { embeds: [rankEmbed(result)] },
            ),
          ),
          "Rank lookup failed; please try again shortly.",
        );
        return deferredReply;
      }),
  );

const devAccounts = () =>
  Ix.global(
    { name: "dev_accounts", description: "List simulated Riot accounts" },
    () =>
      Effect.succeed(
        reply(
          MOCK_ACCOUNTS.map((account) => {
            const games = [
              account.lol ? `LoL ${account.lol.route}` : undefined,
              account.valorant
                ? `Valorant ${account.valorant.route}`
                : undefined,
            ].filter((value): value is string => Boolean(value));
            return `**${account.riotName}#${account.riotTag}** — ${games.join(", ")}`;
          }).join("\n"),
        ),
      ),
  );

export const devStageMatchWorkflow = Effect.fn("Commands.devStageMatch")(
  function* (
    database: Database["Service"],
    simulator: DevSimulator["Service"],
    input: Omit<StageMatchInput, "players"> & {
      readonly discordUserId: string;
      readonly teammateDiscordUserId?: string;
    },
  ) {
    const account = yield* database.getAccount(input.discordUserId);
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
      const teammate = yield* database.getAccount(input.teammateDiscordUserId);
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
    const matchId = yield* simulator.stageMatch({
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

const devMatch = (deps: CommandDeps) =>
  Ix.global(
    {
      name: "dev_match",
      description: "Stage a simulated provider match",
      options: [
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "game",
          description: "game",
          required: true,
          choices: gameChoices,
        },
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "result",
          description: "result for the tracked team",
          required: true,
          choices: [
            { name: "Victory", value: "victory" },
            { name: "Defeat", value: "defeat" },
          ],
        },
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "mode",
          description: "ranked by default",
          required: false,
          choices: [
            { name: "Ranked", value: "ranked" },
            { name: "Unranked", value: "unranked" },
          ],
        },
        {
          type: Discord.ApplicationCommandOptionType.BOOLEAN,
          name: "surrendered",
          description: "stage a surrender",
          required: false,
        },
        {
          type: Discord.ApplicationCommandOptionType.USER,
          name: "teammate",
          description: "optional tracked teammate in the shared match",
          required: false,
        },
        {
          type: Discord.ApplicationCommandOptionType.BOOLEAN,
          name: "duplicate",
          description: "reuse the previously staged match ID",
          required: false,
        },
      ],
    },
    (i) =>
      Effect.gen(function* () {
        const user = userFor(i);
        if (!user) return reply("Couldn't tell who ran that command.");
        const teammateDiscordUserId = Option.getOrUndefined(
          i.optionValueOptional("teammate"),
        );
        const game = yield* Schema.decodeUnknownEffect(GameIdSchema)(
          i.optionValue("game"),
        );
        const result = yield* Schema.decodeUnknownEffect(MatchResult)(
          i.optionValue("result"),
        );
        const mode = yield* Schema.decodeUnknownEffect(MatchMode)(
          i.optionValueOrElse("mode", () => "ranked"),
        );
        return reply(
          yield* devStageMatchWorkflow(deps.database, deps.simulator, {
            discordUserId: user.id,
            game,
            result,
            mode,
            surrendered: i.optionValueOrElse("surrendered", () => false),
            duplicate: i.optionValueOrElse("duplicate", () => false),
            ...(teammateDiscordUserId ? { teammateDiscordUserId } : {}),
          }),
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("dev match staging failed", error).pipe(
            Effect.as(reply("Could not stage that match.")),
          ),
        ),
      ),
  );

const devPoll = (deps: CommandDeps) =>
  Ix.global(
    { name: "dev_poll", description: "Run one real polling pass now" },
    (i) =>
      Effect.gen(function* () {
        if (yield* SubscriptionRef.get(deps.pollingState.paused)) {
          return reply("Polling is paused; no pass ran.");
        }
        yield* detachFollowUp(
          deps.rest,
          i.interaction,
          deps.polling.runOnce().pipe(Effect.map(pollResultText)),
          "The polling pass failed; check the bot logs and try again.",
        );
        return deferredReply;
      }),
  );

export const commands = (deps: CommandDeps) => {
  const common = Ix.builder
    .add(signup(deps))
    .add(signout(deps))
    .add(pause(deps))
    .add(resume(deps))
    .add(rankCheck(deps));
  return (
    deps.appMode === "development"
      ? common.add(devAccounts()).add(devMatch(deps)).add(devPoll(deps))
      : common
  ).catchAllCause(Effect.logError);
};
