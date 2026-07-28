import { Discord, DiscordREST, Ix } from "dfx";
import { Effect, SubscriptionRef } from "effect";
import type { Account, Database } from "../database/index.ts";
import type { GameAdapters } from "../game/game-adapters/index.ts";
import type { GameId, Puuid } from "../game/index.ts";
import type { PollingState } from "../polling/state.ts";

export interface CommandDeps {
  readonly database: Database["Service"];
  readonly gameAdapters: GameAdapters["Service"];
  readonly rest: Effect.Success<typeof DiscordREST>;
  readonly pollingState: PollingState["Service"];
}

const reply = (content: string): Discord.CreateInteractionResponseRequest => ({
  type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
  data: { content },
});

// discord needs <= 3s to respond, the follow-up edits this placeholder
const deferredReply: Discord.CreateInteractionResponseRequest = {
  type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
};

const todo = (name: string) =>
  Effect.succeed(reply(`\`/${name}\` isn't implemented yet.`));

const signup = ({ database, gameAdapters, rest }: CommandDeps) =>
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

        const existing = yield* database
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
          rest.updateOriginalWebhookMessage(
            i.interaction.application_id,
            i.interaction.token,
            { payload: { content } },
          );

        const register = Effect.gen(function* () {
          // a riot id may exist in only one game, so each lookup fails on its own
          const resolved = yield* Effect.forEach(
            gameAdapters.all,
            (adapter) =>
              adapter.resolveAccount(riotName, riotTag).pipe(
                Effect.map(
                  (puuid): { game: GameId; puuid: Puuid } | undefined => ({
                    game: adapter.game,
                    puuid,
                  }),
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

          // tracked matches start empty
          const games: Account["games"] = {};
          for (const entry of resolved) {
            if (entry)
              games[entry.game] = { puuid: entry.puuid, reportedMatches: [] };
          }

          // discord user has no puuid for any game
          if (Object.keys(games).length === 0) {
            return yield* followUp(
              "Couldn't find recent account data for that Riot ID :(",
            );
          }

          yield* database.addAccount({
            discordUserId: user.id,
            discordName: user.username,
            riotName,
            riotTag,
            games,
          });

          return yield* followUp(`**${user.username}** just signed up!`);
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

// TODO: needs Database.deleteAccount.
const signout = Ix.global(
  {
    name: "signout",
    description: "Stop tracking all your data",
  },
  () => todo("signout"),
);

const pause = ({ pollingState }: CommandDeps) =>
  Ix.global(
    {
      name: "pause",
      description: "Pause all match reports (the bot will appear as idle)",
    },
    () =>
      SubscriptionRef.set(pollingState.paused, true).pipe(
        Effect.as(reply("Match reports paused.")),
      ),
  );

const resume = ({ pollingState }: CommandDeps) =>
  Ix.global(
    {
      name: "resume",
      description: "Resume all match reports (the bot will appear as online)",
    },
    () =>
      SubscriptionRef.set(pollingState.paused, false).pipe(
        Effect.as(reply("Match reports resumed.")),
      ),
  );

// TODO: needs a GameAdapter.getRank and the account's stored region.
const rankCheck = Ix.global(
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
  () => todo("rank_check"),
);

export const commands = (deps: CommandDeps) =>
  Ix.builder
    .add(signup(deps))
    .add(signout)
    .add(pause(deps))
    .add(resume(deps))
    .add(rankCheck)
    .catchAllCause(Effect.logError);
