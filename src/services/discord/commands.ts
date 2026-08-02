import { Discord, DiscordREST, Ix } from "dfx";
import { Effect, Option, Schema, SubscriptionRef } from "effect";
import type { AppMode } from "../config.ts";
import type { Database } from "../database/index.ts";
import type { DevSimulator } from "../game/dev-simulator.ts";
import type { GameAdapters } from "../game/game-adapters/index.ts";
import { GameId as GameIdSchema } from "../game/index.ts";
import type { Polling } from "../polling/index.ts";
import type { PollingState } from "../polling/state.ts";
import {
  devStageMatchWorkflow,
  pollResultText,
  rankCheckWorkflow,
  signoutWorkflow,
  signupWorkflow,
} from "./workflows.ts";
import { rankEmbed } from "./embed.ts";

export interface CommandDeps {
  readonly appMode: AppMode;
  readonly database: Database["Service"];
  readonly gameAdapters: GameAdapters["Service"];
  readonly polling: Polling["Service"];
  readonly rest: Effect.Success<typeof DiscordREST>;
  readonly pollingState: PollingState["Service"];
  readonly simulator: DevSimulator["Service"];
}

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

const followUp = (
  rest: CommandDeps["rest"],
  interaction: Discord.APIInteraction,
  content: string,
) =>
  rest.updateOriginalWebhookMessage(
    interaction.application_id,
    interaction.token,
    { payload: { content } },
  );

const detachFollowUp = <E>(
  rest: CommandDeps["rest"],
  interaction: Discord.APIInteraction,
  operation: Effect.Effect<string, E>,
  failureMessage: string,
) =>
  operation.pipe(
    Effect.flatMap((content) => followUp(rest, interaction, content)),
    Effect.catch((error) =>
      Effect.logError("deferred command failed", error).pipe(
        Effect.andThen(followUp(rest, interaction, failureMessage)),
        Effect.ignore({ log: "Error", message: "command follow-up failed" }),
      ),
    ),
    Effect.forkDetach,
  );

const detachPayloadFollowUp = <E>(
  rest: CommandDeps["rest"],
  interaction: Discord.APIInteraction,
  operation: Effect.Effect<Discord.IncomingWebhookUpdateRequestPartial, E>,
  failureMessage: string,
) =>
  operation.pipe(
    Effect.flatMap((payload) =>
      rest.updateOriginalWebhookMessage(
        interaction.application_id,
        interaction.token,
        { payload },
      ),
    ),
    Effect.catch((error) =>
      Effect.logError("deferred command failed", error).pipe(
        Effect.andThen(
          rest.updateOriginalWebhookMessage(
            interaction.application_id,
            interaction.token,
            { payload: { content: failureMessage } },
          ),
        ),
        Effect.ignore({ log: "Error", message: "command follow-up failed" }),
      ),
    ),
    Effect.forkDetach,
  );

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
          signupWorkflow(deps, {
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
        yield* detachPayloadFollowUp(
          deps.rest,
          i.interaction,
          rankCheckWorkflow(deps, i.optionValue("user"), game).pipe(
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

const devAccounts = (deps: CommandDeps) =>
  Ix.global(
    { name: "dev_accounts", description: "List simulated Riot accounts" },
    () =>
      deps.simulator.listAccounts().pipe(
        Effect.map((accounts) =>
          reply(
            accounts
              .map((account) => {
                const games = [
                  account.lol ? `LoL ${account.lol.route}` : undefined,
                  account.valorant
                    ? `Valorant ${account.valorant.route}`
                    : undefined,
                ].filter((value): value is string => Boolean(value));
                return `**${account.riotName}#${account.riotTag}** — ${games.join(", ")}`;
              })
              .join("\n"),
          ),
        ),
      ),
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
          yield* devStageMatchWorkflow(deps, {
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
      ? common.add(devAccounts(deps)).add(devMatch(deps)).add(devPoll(deps))
      : common
  ).catchAllCause(Effect.logError);
};
