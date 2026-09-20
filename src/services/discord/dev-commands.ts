import { Discord, Ix } from "dfx";
import { Effect, Option } from "effect";
import { productionMatchReport } from "../../fixtures/production-matches.ts";
import type { GameId } from "../game/index.ts";
import {
  deferredReply,
  registerAccount,
  reply,
  type CommandDeps,
} from "./commands.ts";

const devClear = ({ database }: CommandDeps) =>
  Ix.global(
    {
      name: "dev_clear",
      description:
        "[dev] Forget reported matches so the next poll re-reports them",
    },
    () =>
      database.clearReportedMatches().pipe(
        Effect.as(
          reply(
            "Cleared reported matches; the next poll re-reports everyone's recent matches.",
          ),
        ),
        Effect.catch((error) =>
          Effect.logError("dev_clear failed", error).pipe(
            Effect.as(reply("Clear failed, check the logs.")),
          ),
        ),
      ),
  );

const devReport = (deps: CommandDeps) =>
  Ix.global(
    {
      name: "dev_report",
      description: "[dev] Post a match report built from a production fixture",
      options: [
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "game",
          description: "which game's production fixture to report",
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
        const game = i.optionValue("game") as GameId;
        const report = yield* productionMatchReport({ game });
        yield* deps.notifyMatch(report);
        return reply("Production fixture report sent.");
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("dev_report failed", error).pipe(
            Effect.as(reply("Fixture report failed, check the logs.")),
          ),
        ),
      ),
  );

const fakeIdentity = (riotName: string, riotTag: string) => ({
  discordUserId: `dev-${riotName}-${riotTag}`.toLowerCase(),
  discordName: `${riotName} (dev)`,
});

const devSignup = (deps: CommandDeps) =>
  Ix.global(
    {
      name: "dev_signup",
      description: "[dev] Track a riot account for a fake or real discord user",
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
        {
          type: Discord.ApplicationCommandOptionType.USER,
          name: "user",
          description: "sign up on this user's behalf (default: a fake user)",
          required: false,
        },
      ],
    },
    (i) =>
      Effect.gen(function* () {
        const riotName = i.optionValue("riot_name");
        const riotTag = i.optionValue("riot_tag");
        const fake = fakeIdentity(riotName, riotTag);
        const { discordUserId, discordName } = Option.match(
          i.optionValueOptional("user"),
          {
            onNone: () => fake,
            onSome: (userId) => ({
              discordUserId: userId,
              discordName: Option.getOrElse(
                i.resolve("user", (id, data) => data.users?.[id]?.username),
                () => fake.discordName,
              ),
            }),
          },
        );

        const existing = yield* deps.database.hasAccount(discordUserId);
        if (existing) return reply(`Already tracking **${discordName}**.`);

        const followUp = (content: string) =>
          deps.rest.updateOriginalWebhookMessage(
            i.interaction.application_id,
            i.interaction.token,
            { payload: { content } },
          );

        const register = registerAccount(deps, {
          discordUserId,
          discordName,
          riotName,
          riotTag,
        }).pipe(
          Effect.flatMap((result) =>
            followUp(
              result === "ok"
                ? `Now tracking **${discordName}**; shared matches report as multi-user.`
                : "Couldn't find recent account data for that Riot ID :(",
            ),
          ),
          Effect.catch((error) =>
            Effect.logError("dev_signup failed", error).pipe(
              Effect.andThen(followUp("dev_signup failed, check the logs.")),
              Effect.ignore({
                log: "Error",
                message: "dev_signup follow-up failed",
              }),
            ),
          ),
        );

        yield* Effect.forkDetach(register);
        return deferredReply;
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("dev_signup lookup failed", error).pipe(
            Effect.as(reply("dev_signup failed, check the logs.")),
          ),
        ),
      ),
  );

const devSignout = ({ database }: CommandDeps) =>
  Ix.global(
    {
      name: "dev_signout",
      description: "[dev] Stop tracking a fake or real discord user's account",
      options: [
        {
          type: Discord.ApplicationCommandOptionType.USER,
          name: "user",
          description: "sign out on this user's behalf",
          required: false,
        },
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "riot_name",
          description: "before the # of a fake dev_signup (e.g. syan)",
          required: false,
        },
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "riot_tag",
          description: "after the # of a fake dev_signup (e.g. NA1)",
          required: false,
        },
      ],
    },
    (i) =>
      Effect.gen(function* () {
        const riotId = Option.all([
          i.optionValueOptional("riot_name"),
          i.optionValueOptional("riot_tag"),
        ]).pipe(
          Option.map(([riotName, riotTag]) => fakeIdentity(riotName, riotTag)),
        );
        const target = Option.orElse(
          i.optionValueOptional("user").pipe(
            Option.map((userId) => ({
              discordUserId: userId,
              discordName: Option.getOrElse(
                i.resolve("user", (id, data) => data.users?.[id]?.username),
                () => userId,
              ),
            })),
          ),
          () => riotId,
        );

        if (Option.isNone(target)) {
          return reply(
            "Pass a user, or the riot_name and riot_tag it was signed up with.",
          );
        }

        const { discordUserId, discordName } = target.value;
        const existing = yield* database.hasAccount(discordUserId);
        if (!existing) return reply(`**${discordName}** isn't signed up.`);

        yield* database.deleteAccount(discordUserId);
        return reply(`**${discordName}** signed out, all data deleted.`);
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("dev_signout failed", error).pipe(
            Effect.as(reply("dev_signout failed, check the logs.")),
          ),
        ),
      ),
  );

export const devCommands = (deps: CommandDeps) =>
  Ix.builder
    .add(devClear(deps))
    .add(devReport(deps))
    .add(devSignup(deps))
    .add(devSignout(deps));
