import { Discord, DiscordREST, Ix, UI } from "dfx";
import { Effect, Option, Schema } from "effect";
import type { Database } from "../database/index.ts";
import {
  listGameNames,
  registerAccount,
  reportedGames,
  trackGames,
  untrackGames,
  formatTrackResult,
  formatUntrackResult,
} from "../account/index.ts";
import { logApiError, type GameAdapters } from "../game/game-adapters/index.ts";
import {
  discordGameChoices,
  GameId,
  gameIds,
  gameNames,
} from "../game/index.ts";
import type { Rso, RsoLink } from "../rso/index.ts";
import type { DiscordError, ReportTarget } from "./index.ts";
import { rankEmbed, type MatchReport } from "./embed.ts";
import { devCommands } from "./dev-commands.ts";

export interface CommandDeps {
  readonly database: Database["Service"];
  readonly gameAdapters: GameAdapters["Service"];
  readonly rest: Effect.Success<typeof DiscordREST>;
  readonly notifyMatch: (
    target: ReportTarget,
    report: MatchReport,
  ) => Effect.Effect<void, DiscordError>;
  readonly rso: Rso["Service"];
}

export const reply = (
  content: string,
): Discord.CreateInteractionResponseRequest => ({
  type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
  data: { content },
});

// only the person who ran the command sees it
const privateReply = (
  content: string,
): Discord.CreateInteractionResponseRequest => ({
  type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
  data: { content, flags: Discord.MessageFlags.Ephemeral },
});

// discord needs <= 3s to respond, the follow-up edits this placeholder
export const deferredReply: Discord.CreateInteractionResponseRequest = {
  type: Discord.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
};

// every command acts on the server it's run in, so none work in DMs
export const inServers = {
  contexts: [Discord.InteractionContextType.GUILD],
} as const;

// server settings can still hand these to other roles
const forManagers = {
  default_member_permissions: Number(Discord.Permissions.ManageGuild),
};

export const trackPrompt =
  "Pick the games to report, in every server you're signed up in:";
export const signedUpMessage = (username: string) =>
  `**${username}** just signed up! Pick games to report now, or anytime with \`/track\`.`;
export const setupChannelMessage =
  "Match reports will be posted here. Run `/signup` to have yours included.";

// One select for picking several games at once. Ephemeral, so only the person
// it's for can pick.
const gamePicker = (
  action: "track" | "untrack",
  games: ReadonlyArray<GameId>,
) => ({
  content:
    action === "track"
      ? trackPrompt
      : "Pick the games to stop reporting, in every server you're signed up in:",
  flags: Discord.MessageFlags.Ephemeral,
  components: [
    UI.row([
      UI.select({
        custom_id: `games:${action}`,
        min_values: 1,
        max_values: games.length,
        options: games.map((game) => ({ label: gameNames[game], value: game })),
      }),
    ]),
  ],
});

// `linkHint` points at /link when some game can only be added by signing in
const signup = (deps: CommandDeps, linkHint: string) =>
  Ix.global(
    {
      name: "signup",
      description: "Get your riot account's match results reported here",
      ...inServers,
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
          type: Discord.ApplicationCommandOptionType.BOOLEAN,
          name: "replace_account",
          description:
            "Confirm replacing your Riot account in every subscribed server",
        },
      ],
    },
    (i) =>
      Effect.gen(function* () {
        const riotName = i.optionValue("riot_name");
        const riotTag = i.optionValue("riot_tag");
        const user = i.interaction.member?.user ?? i.interaction.user;
        const guildId = i.interaction.guild_id;

        if (!user || !guildId) {
          return reply("Couldn't tell who ran that command :(");
        }

        const [existing, guild] = yield* Effect.all([
          deps.database.getAccount(user.id),
          deps.database.getGuild(guildId),
        ]);
        const setupHint = guild?.channelId
          ? ""
          : "\nReports start once a server admin picks a channel with `/setup`.";

        // riot ids ignore case, so this is the account they already track
        if (
          existing &&
          existing.riotName.toLowerCase() === riotName.toLowerCase() &&
          existing.riotTag.toLowerCase() === riotTag.toLowerCase()
        ) {
          if (existing.guildIds.includes(guildId)) {
            return privateReply(
              `You are already signed up here as ${existing.riotName}#${existing.riotTag}. Run \`/status\` to check reporting or \`/track\` to choose games.`,
            );
          }
          yield* deps.database.subscribe({ guildId, discordUserId: user.id });
          return reply(
            `**${user.username}** just signed up!${setupHint}${linkHint}`,
          );
        }

        if (
          existing &&
          i.optionValueOrElse("replace_account", () => false) !== true
        ) {
          return privateReply(
            `Replacing ${existing.riotName}#${existing.riotTag} changes your account in every server you signed up in and resets game history and Riot consent. Run \`/signup\` again with \`replace_account: true\` to confirm; consent-based games need \`/link\` again.`,
          );
        }

        const followUp = (content: string) =>
          deps.rest.updateOriginalWebhookMessage(
            i.interaction.application_id,
            i.interaction.token,
            { payload: { content } },
          );

        const register = Effect.gen(function* () {
          const result = yield* registerAccount(
            deps,
            {
              discordUserId: user.id,
              discordName: user.username,
              riotName,
              riotTag,
              guildIds: [guildId],
            },
            // a new riot id keeps the games they picked; the ones behind a
            // riot sign-in need /link again
            deps.gameAdapters.all
              .filter(
                (adapter) =>
                  !adapter.requiresOptIn && existing?.games[adapter.game],
              )
              .map((adapter) => adapter.game),
          );
          if (result === "not-found") {
            return yield* followUp("Couldn't find that Riot ID :(");
          }

          yield* followUp(
            existing
              ? `**${user.username}** switched to ${riotName}#${riotTag} in every subscribed server.${setupHint}${linkHint}`
              : `${signedUpMessage(user.username)}${setupHint}${linkHint}`,
          );
          const account = yield* deps.database.getAccount(user.id);
          const reported = account
            ? reportedGames(deps.gameAdapters, account)
            : [];
          const pickable = deps.gameAdapters.all
            .map((adapter) => adapter.game)
            .filter((game) => !reported.includes(game));
          if (pickable.length === 0) return;
          // they're signed up either way, so a failed picker isn't a failed signup
          yield* deps.rest
            .executeWebhook(i.interaction.application_id, i.interaction.token, {
              payload: gamePicker("track", pickable),
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("signup game picker not sent", error),
              ),
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
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("signup lookup failed", error).pipe(
            Effect.as(reply("Signup failed, try again in a bit :(")),
          ),
        ),
      ),
  );

// also on the site, so riot's reviewers see what players agree to
export const linkMessage = (games: string) =>
  `Sign in with Riot to get your ${games} matches reported here. Linking makes your match data visible to the members of the servers you sign up in. This link is only for you and works for 15 minutes.`;

// Riot only lets some games' data be shown for players who signed in with riot
// to opt in. The sign-in link carries who asked for it, so it's only shown to
// them.
const link = (
  signInUrl: (link: RsoLink) => Effect.Effect<string>,
  games: string,
) =>
  Ix.global(
    {
      name: "link",
      description: `Sign in with Riot to get your ${games} matches reported here`,
      ...inServers,
    },
    (i) =>
      Effect.gen(function* () {
        const user = i.interaction.member?.user ?? i.interaction.user;
        const guildId = i.interaction.guild_id;
        if (!user || !guildId) {
          return reply("Couldn't tell who ran that command :(");
        }

        const url = yield* signInUrl({
          discordUserId: user.id,
          discordName: user.username,
          guildId,
        });
        return {
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: linkMessage(games),
            flags: Discord.MessageFlags.Ephemeral,
            components: [
              UI.row([
                UI.button({
                  style: Discord.ButtonStyleTypes.LINK,
                  label: "Sign in with Riot",
                  url,
                }),
              ]),
            ],
          },
        } satisfies Discord.CreateInteractionResponseRequest;
      }),
  );

const signout = ({ database }: CommandDeps) =>
  Ix.global(
    {
      name: "signout",
      description:
        "Stop reporting your matches here (your data goes with the last server)",
      ...inServers,
    },
    (i) =>
      Effect.gen(function* () {
        const user = i.interaction.member?.user ?? i.interaction.user;
        const guildId = i.interaction.guild_id;
        if (!user || !guildId) {
          return reply("Couldn't tell who ran that command :(");
        }

        const account = yield* database.getAccount(user.id);
        if (!account?.guildIds.includes(guildId)) {
          return reply("You're not signed up here.");
        }

        const { accountDeleted } = yield* database.leaveGuild({
          guildId,
          discordUserId: user.id,
        });
        return reply(
          accountDeleted
            ? `**${user.username}** signed out, all data deleted.`
            : `**${user.username}** signed out of this server's reports. Reporting in your other servers continues.`,
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("signout failed", error).pipe(
            Effect.as(reply("Signout failed, try again in a bit :(")),
          ),
        ),
      ),
  );

const status = ({ database, gameAdapters, rso }: CommandDeps) =>
  Ix.global(
    {
      name: "status",
      description: "Check your account and reporting in this server",
      ...inServers,
    },
    (i) =>
      Effect.gen(function* () {
        const user = i.interaction.member?.user ?? i.interaction.user;
        const guildId = i.interaction.guild_id;
        if (!user || !guildId) return privateReply("Run this in a server.");
        const [account, guild, paused] = yield* Effect.all([
          database.getAccount(user.id),
          database.getGuild(guildId),
          database.getPollingPaused(),
        ]);
        const selected = gameIds.filter((game) => account?.games[game]);
        const missingConsent = gameAdapters.all
          .filter(
            (adapter) =>
              adapter.requiresOptIn && !account?.games[adapter.game]?.optedInAt,
          )
          .map((adapter) => adapter.game);
        const next = [
          !account?.guildIds.includes(guildId) &&
            "Run `/signup` to receive reports here.",
          selected.length === 0 &&
            "Run `/track` to choose games (applies to every subscribed server).",
          !guild?.channelId && "Ask a server admin to run `/setup`.",
          guild?.paused && "Ask a server admin to run `/resume`.",
          paused &&
            "Bot polling is paused globally; ask the bot operator to resume it.",
          missingConsent.length > 0 &&
            (Option.isSome(rso)
              ? "Run `/link` to consent to reporting those games."
              : "Riot sign-in is not available yet for consent-based games."),
        ].filter((line) => typeof line === "string");
        return privateReply(
          [
            `Account: ${account ? `${account.riotName}#${account.riotTag}` : "not signed up"}`,
            `Subscribed here: ${account?.guildIds.includes(guildId) ? "yes" : "no"}`,
            `Selected games: ${listGameNames(selected) || "none"}`,
            `Report channel: ${guild?.channelId ? `<#${guild.channelId}>` : "not configured"}`,
            `Server reports: ${guild?.paused ? "paused" : "enabled"}; bot polling: ${paused ? "paused" : "enabled"}`,
            `Missing consent: ${listGameNames(missingConsent) || "none"}`,
            ...next,
          ].join("\n"),
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("status failed", error).pipe(
            Effect.as(privateReply("Couldn't load status. Try again shortly.")),
          ),
        ),
      ),
  );

const setup = ({ database, rest }: CommandDeps) =>
  Ix.global(
    {
      name: "setup",
      description: "Pick the channel match reports are posted in",
      ...inServers,
      ...forManagers,
      options: [
        {
          type: Discord.ApplicationCommandOptionType.CHANNEL,
          name: "channel",
          description: "where match reports go",
          required: true,
          channel_types: [
            Discord.ChannelTypes.GUILD_TEXT,
            Discord.ChannelTypes.GUILD_ANNOUNCEMENT,
          ],
        },
      ],
    },
    (i) =>
      Effect.gen(function* () {
        const guildId = i.interaction.guild_id;
        if (!guildId) return reply("This only works in a server.");
        const channelId = i.optionValue("channel");

        // posting now shows missing permissions here, instead of as
        // reports that never arrive
        const posted = yield* rest
          .createMessage(channelId, {
            content: setupChannelMessage,
          })
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("setup channel unusable", error).pipe(
                Effect.as(false),
              ),
            ),
          );
        if (!posted) {
          return reply(
            `I can't post in <#${channelId}>. Let me view it, send messages, embed links and attach files there, then run this again.`,
          );
        }

        yield* database.updateGuild(guildId, { channelId });
        return reply(`Match reports will be posted in <#${channelId}>.`);
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("setup failed", error).pipe(
            Effect.as(reply("Setup failed, try again in a bit :(")),
          ),
        ),
      ),
  );

const pause = ({ database }: CommandDeps) =>
  Ix.global(
    {
      name: "pause",
      description: "Pause match reports in this server",
      ...inServers,
      ...forManagers,
    },
    (i) =>
      Effect.gen(function* () {
        const guildId = i.interaction.guild_id;
        if (!guildId) return reply("This only works in a server.");
        yield* database.updateGuild(guildId, { paused: true });
        return reply("Match reports paused.");
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("pause failed", error).pipe(
            Effect.as(reply("Pause failed, try again in a bit :(")),
          ),
        ),
      ),
  );

const resume = ({ database }: CommandDeps) =>
  Ix.global(
    {
      name: "resume",
      description: "Resume match reports in this server",
      ...inServers,
      ...forManagers,
    },
    (i) =>
      Effect.gen(function* () {
        const guildId = i.interaction.guild_id;
        if (!guildId) return reply("This only works in a server.");
        yield* database.updateGuild(guildId, { paused: false });
        return reply("Match reports resumed.");
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("resume failed", error).pipe(
            Effect.as(reply("Resume failed, try again in a bit :(")),
          ),
        ),
      ),
  );

const track = ({ database, gameAdapters }: CommandDeps) =>
  Ix.global(
    {
      name: "track",
      description: "Pick one or more games to report your matches for",
      ...inServers,
    },
    (i) =>
      Effect.gen(function* () {
        const user = i.interaction.member?.user ?? i.interaction.user;
        if (!user) return privateReply("Couldn't tell who ran that command :(");

        const account = yield* database.getAccount(user.id);
        if (!account) return privateReply("Run `/signup` first.");

        const reported = reportedGames(gameAdapters, account);
        const pickable = gameAdapters.all
          .map((adapter) => adapter.game)
          .filter((game) => !reported.includes(game));
        if (pickable.length === 0) {
          return privateReply("You're already tracking every game.");
        }
        return {
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: gamePicker("track", pickable),
        } satisfies Discord.CreateInteractionResponseRequest;
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("track lookup failed", error).pipe(
            Effect.as(privateReply("Track failed, try again in a bit :(")),
          ),
        ),
      ),
  );

const untrack = ({ database }: CommandDeps) =>
  Ix.global(
    {
      name: "untrack",
      description:
        "Stop reporting one or more of your games, in every server you're in",
      ...inServers,
    },
    (i) =>
      Effect.gen(function* () {
        const user = i.interaction.member?.user ?? i.interaction.user;
        if (!user) return privateReply("Couldn't tell who ran that command :(");

        const account = yield* database.getAccount(user.id);
        if (!account) return privateReply("You're not signed up.");

        const tracked = gameIds.filter(
          (game) => account.games[game] !== undefined,
        );
        if (tracked.length === 0)
          return privateReply("You're not tracking any games.");
        return {
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: gamePicker("untrack", tracked),
        } satisfies Discord.CreateInteractionResponseRequest;
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("untrack lookup failed", error).pipe(
            Effect.as(privateReply("Untrack failed, try again in a bit :(")),
          ),
        ),
      ),
  );

// replaces the picker, so it can't be submitted twice
const pickerResult = (
  content: string,
): Discord.CreateInteractionResponseRequest => ({
  type: Discord.InteractionCallbackTypes.UPDATE_MESSAGE,
  data: { content, components: [] },
});

// The picker is ephemeral, so whoever picks is the person it was sent to.
const pickedGames = Effect.gen(function* () {
  const interaction = yield* Ix.Interaction;
  const data = yield* Ix.MessageComponentData;
  const games = yield* Schema.decodeUnknownEffect(Schema.Array(GameId))(
    "values" in data ? data.values : [],
  );
  return {
    interaction,
    user: interaction.member?.user ?? interaction.user,
    games,
  };
});

const trackPicked = (deps: CommandDeps, canLink: boolean) =>
  Ix.messageComponent(
    Ix.id("games:track"),
    Effect.gen(function* () {
      const { interaction, user, games } = yield* pickedGames;
      if (!user) return pickerResult("Couldn't tell who picked that :(");
      const account = yield* deps.database.getAccount(user.id);
      if (!account) return pickerResult("Run `/signup` first.");

      const followUp = (content: string) =>
        deps.rest.updateOriginalWebhookMessage(
          interaction.application_id,
          interaction.token,
          { payload: { content, components: [] } },
        );

      // looking games up can take longer than discord waits for a response
      const run = trackGames(deps, account, games).pipe(
        Effect.flatMap((result) =>
          followUp(formatTrackResult(result, canLink)),
        ),
        Effect.catch((error) =>
          Effect.logError("track failed", error).pipe(
            Effect.andThen(followUp("Track failed, try again in a bit :(")),
            Effect.ignore({ log: "Error", message: "track follow-up failed" }),
          ),
        ),
      );
      yield* Effect.forkDetach(run);
      return {
        type: Discord.InteractionCallbackTypes.DEFERRED_UPDATE_MESSAGE,
      } satisfies Discord.CreateInteractionResponseRequest;
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("track pick failed", error).pipe(
          Effect.as(pickerResult("Track failed, try again in a bit :(")),
        ),
      ),
    ),
  );

const untrackPicked = ({ database }: CommandDeps) =>
  Ix.messageComponent(
    Ix.id("games:untrack"),
    Effect.gen(function* () {
      const { user, games } = yield* pickedGames;
      if (!user) return pickerResult("Couldn't tell who picked that :(");
      const account = yield* database.getAccount(user.id);
      if (!account) return pickerResult("You're not signed up.");

      const result = yield* untrackGames(database, account, games);
      return pickerResult(formatUntrackResult(result));
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("untrack failed", error).pipe(
          Effect.as(pickerResult("Untrack failed, try again in a bit :(")),
        ),
      ),
    ),
  );

const rankCheck = (deps: CommandDeps) =>
  Ix.global(
    {
      name: "rank_check",
      description: "Check the rank of someone signed up here",
      ...inServers,
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
          choices: discordGameChoices,
        },
      ],
    },
    (i) =>
      Effect.gen(function* () {
        const userId = i.optionValue("user");
        const guildId = i.interaction.guild_id;
        const game = yield* Schema.decodeUnknownEffect(GameId)(
          i.optionValue("game"),
        );
        // the username rather than a <@id> mention, which would ping them
        const target = Option.getOrElse(
          i.resolve("user", (id, data) => data.users?.[id]?.username),
          () => "That user",
        );

        // only people who chose to be reported in this server can be looked up
        const account = yield* deps.database.getAccount(userId);
        const gameState =
          guildId && account?.guildIds.includes(guildId)
            ? account.games[game]
            : undefined;
        if (!account || !gameState) {
          return reply(
            `**${target}** isn't signed up for ${gameNames[game]} here.`,
          );
        }

        const adapter = deps.gameAdapters.all.find(
          (candidate) => candidate.game === game,
        );
        if (!adapter) return reply(`${gameNames[game]} isn't supported.`);
        if (adapter.requiresOptIn && !gameState.optedInAt) {
          return reply(
            `**${target}** hasn't linked their Riot account for ${gameNames[game]}.`,
          );
        }

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
            (error._tag === "GameApiError"
              ? logApiError("rank_check failed", error)
              : Effect.logError("rank_check failed", error)
            ).pipe(
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
  const optInGames = listGameNames(
    deps.gameAdapters.all
      .filter((adapter) => adapter.requiresOptIn)
      .map((adapter) => adapter.game),
  );
  // /link only exists once riot grants a sign-in client
  const signInUrl =
    Option.isSome(deps.rso) && optInGames
      ? deps.rso.value.signInUrl
      : undefined;

  const base = Ix.builder
    .add(
      signup(
        deps,
        signInUrl ? `\nRun \`/link\` to add ${optInGames} as well.` : "",
      ),
    )
    .add(status(deps))
    .add(signout(deps))
    .add(setup(deps))
    .add(pause(deps))
    .add(resume(deps))
    .add(track(deps))
    .add(trackPicked(deps, signInUrl !== undefined))
    .add(untrack(deps))
    .add(untrackPicked(deps))
    .add(rankCheck(deps));
  const withLink = signInUrl ? base.add(link(signInUrl, optInGames)) : base;

  return (
    devMode ? withLink.concat(devCommands(deps)) : withLink
  ).catchAllCause(Effect.logError);
};
