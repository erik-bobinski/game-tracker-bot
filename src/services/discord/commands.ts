import { Discord, DiscordREST, Ix } from "dfx";
import { Effect, Option } from "effect";
import type { AccountDeps } from "../accounts/index.ts";
import { registerAccount } from "../accounts/index.ts";
import { gameNames, type GameId } from "../game/index.ts";
import type { PollingState } from "../polling/state.ts";
import type { DiscordError } from "./index.ts";
import { rankEmbed, type MatchReport } from "./embed.ts";
import { devCommands } from "./dev-commands.ts";

export interface CommandDeps extends AccountDeps {
  readonly rest: Effect.Success<typeof DiscordREST>;
  readonly pollingState: PollingState["Service"];
  readonly notifyMatch: (
    report: MatchReport,
  ) => Effect.Effect<void, DiscordError>;
}

export const reply = (
  content: string,
): Discord.CreateInteractionResponseRequest => ({
  type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
  data: { content },
});

// discord needs <= 3s to respond, the follow-up edits this placeholder
export const deferredReply: Discord.CreateInteractionResponseRequest = {
  type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
};

const signup = (deps: CommandDeps) =>
  Ix.global(
    {
      name: "signup",
      description: "Get your riot account's match results reported",
      options: [
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "riot_name",
          description: "before the # (e.g. syan)",
          required: true,
        },
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "riot_tag",
          description: "after the # (e.g. NA1)",
          required: true,
        },
      ],
    },
    (i) =>
      Effect.gen(function* () {
        const riotName = i.optionValue("riot_name");
        const riotTag = i.optionValue("riot_tag");
        const user = i.interaction.member?.user ?? i.interaction.user;

        if (!user) return reply("Couldn't tell who ran that command :(");

        const existing = yield* deps.database
          .hasAccount(user.id)
          .pipe(
            Effect.catch((error) =>
              Effect.logError("signup lookup failed", error).pipe(
                Effect.as(undefined),
              ),
            ),
          );
        if (existing === undefined) {
          return reply("Signup failed, try again in a bit :(");
        }
        if (existing) return reply("You're already signed up, dummy");

        const followUp = (content: string) =>
          deps.rest.updateOriginalWebhookMessage(
            i.interaction.application_id,
            i.interaction.token,
            { payload: { content } },
          );

        const register = Effect.gen(function* () {
          const result = yield* registerAccount(deps, {
            discordUserId: user.id,
            discordName: user.username,
            riotName,
            riotTag,
          });

          return yield* followUp(
            result === "ok"
              ? `**${user.username}** just signed up!`
              : "Couldn't find recent account data for that Riot ID :(",
          );
        }).pipe(
          Effect.catch((error) =>
            Effect.logError("signup failed", error).pipe(
              Effect.andThen(followUp("Signup failed, try again in a bit :(")),
              Effect.ignore({
                log: "Error",
                message: "signup follow-up failed",
              }),
            ),
          ),
        );

        yield* Effect.forkDetach(register);
        return deferredReply;
      }),
  );

const signout = ({ database }: CommandDeps) =>
  Ix.global(
    {
      name: "signout",
      description: "Stop tracking all your data",
    },
    (i) =>
      Effect.gen(function* () {
        const user = i.interaction.member?.user ?? i.interaction.user;
        if (!user) return reply("Couldn't tell who ran that command :(");

        const existing = yield* database.hasAccount(user.id);
        if (!existing) return reply("You're not signed up.");

        yield* database.deleteAccount(user.id);
        return reply(`**${user.username}** signed out, all data deleted.`);
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("signout failed", error).pipe(
            Effect.as(reply("Signout failed, try again in a bit :(")),
          ),
        ),
      ),
  );

const pause = ({ pollingState }: CommandDeps) =>
  Ix.global(
    {
      name: "pause",
      description: "Pause all match reports (the bot will appear as idle)",
    },
    () =>
      pollingState.setPaused(true).pipe(
        Effect.as(reply("Match reports paused.")),
        Effect.catch((error) =>
          Effect.logError("pause failed", error).pipe(
            Effect.as(reply("Pause failed, try again in a bit :(")),
          ),
        ),
      ),
  );

const resume = ({ pollingState }: CommandDeps) =>
  Ix.global(
    {
      name: "resume",
      description: "Resume all match reports (the bot will appear as online)",
    },
    () =>
      pollingState.setPaused(false).pipe(
        Effect.as(reply("Match reports resumed.")),
        Effect.catch((error) =>
          Effect.logError("resume failed", error).pipe(
            Effect.as(reply("Resume failed, try again in a bit :(")),
          ),
        ),
      ),
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
          description: "the discord user to check",
          required: true,
        },
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "game",
          description: "which game's rank to check",
          required: true,
          choices: [
            { name: "val", value: "valorant" },
            { name: "lol", value: "lol" },
          ],
        },
      ],
    },
    (i) =>
      Effect.gen(function* () {
        const userId = i.optionValue("user");
        const game = i.optionValue("game") as GameId;
        // the username rather than a <@id> mention, which would ping them
        const target = Option.getOrElse(
          i.resolve("user", (id, data) => data.users?.[id]?.username),
          () => "That user",
        );

        const account = yield* deps.database.getAccount(userId);
        const gameState = account?.games[game];
        if (!account || !gameState) {
          return reply(`**${target}** isn't signed up for ${gameNames[game]}.`);
        }

        const adapter = deps.gameAdapters.all.find(
          (candidate) => candidate.game === game,
        );
        if (!adapter) return reply(`${gameNames[game]} isn't supported.`);

        const followUp = (
          payload: Discord.IncomingWebhookUpdateRequestPartial,
        ) =>
          deps.rest.updateOriginalWebhookMessage(
            i.interaction.application_id,
            i.interaction.token,
            { payload },
          );

        const lookUp = adapter.getRank(gameState.puuid, gameState.region).pipe(
          Effect.flatMap((rank) => {
            const icon = adapter.rankIcons.find(
              (candidate) => candidate.key === rank?.iconKey,
            );
            return rank
              ? followUp({
                  embeds: [
                    rankEmbed({
                      riotName: account.riotName,
                      game,
                      rank,
                      iconUrl: icon?.largeUrl ?? icon?.url,
                    }),
                  ],
                })
              : followUp({
                  content: `**${account.riotName}#${account.riotTag}** has no ranked data for ${gameNames[game]}.`,
                });
          }),
          Effect.catch((error) =>
            Effect.logError("rank_check failed", error).pipe(
              Effect.andThen(
                followUp({ content: "Rank lookup failed, try again :(" }),
              ),
              Effect.ignore({
                log: "Error",
                message: "rank_check follow-up failed",
              }),
            ),
          ),
        );

        yield* Effect.forkDetach(lookUp);
        return deferredReply;
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("rank_check lookup failed", error).pipe(
            Effect.as(reply("Rank lookup failed, try again :(")),
          ),
        ),
      ),
  );

export const commands = (deps: CommandDeps, devMode: boolean) => {
  const base = Ix.builder
    .add(signup(deps))
    .add(signout(deps))
    .add(pause(deps))
    .add(resume(deps))
    .add(rankCheck(deps));

  return (devMode ? base.concat(devCommands(deps)) : base).catchAllCause(
    Effect.logError,
  );
};
