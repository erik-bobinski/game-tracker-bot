import { Discord, DiscordREST, Ix, UI } from "dfx";
import { DateTime, Effect, Option, Schema } from "effect";
import type { Account, Database } from "../database/index.ts";
import {
  logApiError,
  logApiWarning,
  resolveGameState,
  type GameAdapters,
} from "../game/game-adapters/index.ts";
import { discordGameChoices, GameId, gameNames } from "../game/index.ts";
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

// The games a riot id plays, each with its current matches pre-reported so the
// first poll doesn't repost old games. Games that need an opt-in are only
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
          Effect.map((state) =>
            state
              ? [
                  {
                    game: adapter.game,
                    state: adapter.requiresOptIn
                      ? { ...state, optedInAt }
                      : state,
                  },
                ]
              : [],
          ),
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

// Only needs the two services, so the admin cli can call it too.
export const registerAccount = (
  { database, gameAdapters }: Pick<CommandDeps, "database" | "gameAdapters">,
  input: Omit<Account, "games">,
  { optedIn = false }: { readonly optedIn?: boolean } = {},
) =>
  Effect.gen(function* () {
    const resolved = yield* resolveGames(gameAdapters, input, optedIn);
    if (resolved.length === 0) return "not-found" as const;

    const games: Account["games"] = {};
    for (const { game, state } of resolved) games[game] = state;
    yield* database.addAccount({ ...input, games });
    return "ok" as const;
  });

// After a riot sign-in: adds the games that needed it to the account, or,
// for someone who hadn't signed up, signs them up with the riot id they
// signed in as.
export const linkAccount = (
  deps: Pick<CommandDeps, "database" | "gameAdapters">,
  link: {
    readonly discordUserId: string;
    readonly discordName: string;
    readonly guildId: string;
  },
  riotId: { readonly riotName: string; readonly riotTag: string },
) =>
  Effect.gen(function* () {
    const account = yield* deps.database.getAccount(link.discordUserId);
    if (!account) {
      return yield* registerAccount(
        deps,
        { ...link, ...riotId, guildIds: [link.guildId] },
        { optedIn: true },
      );
    }

    const found = yield* resolveGames(
      { all: deps.gameAdapters.all.filter((adapter) => adapter.requiresOptIn) },
      riotId,
      true,
    );
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

const listGameNames = (games: ReadonlyArray<GameId>) =>
  games.map((game) => gameNames[game]).join(", ");

// Rechecks every adapter for a signed-up user. Already-tracked games
// keep their reported matches; only newly found games are inserted.
export const refreshAccount = (
  { database, gameAdapters }: Pick<CommandDeps, "database" | "gameAdapters">,
  account: Account,
) =>
  Effect.gen(function* () {
    const tracked = gameAdapters.all
      .filter((adapter) => account.games[adapter.game] !== undefined)
      .map((adapter) => adapter.game);

    // games that need an opt-in are added by signing in with riot, not by id
    const unresolved = gameAdapters.all.filter(
      (adapter) =>
        account.games[adapter.game] === undefined && !adapter.requiresOptIn,
    );

    const resolved = yield* Effect.forEach(
      unresolved,
      (adapter) =>
        resolveGameState(adapter, account.riotName, account.riotTag).pipe(
          Effect.map((state) => ({ game: adapter.game, state })),
          Effect.catch((error) =>
            logApiWarning("refreshAccount failed", error).pipe(
              Effect.annotateLogs({ game: adapter.game }),
              Effect.as({ game: adapter.game, state: undefined }),
            ),
          ),
        ),
      { concurrency: "unbounded" },
    );

    const added: Array<GameId> = [];
    const missing: Array<GameId> = [];
    for (const { game, state } of resolved) {
      if (!state) {
        missing.push(game);
        continue;
      }
      yield* database.addGame({
        discordUserId: account.discordUserId,
        game,
        state,
      });
      added.push(game);
    }

    return { added, missing, tracked };
  });

export const formatRefreshResult = (result: {
  readonly added: ReadonlyArray<GameId>;
  readonly missing: ReadonlyArray<GameId>;
  readonly tracked: ReadonlyArray<GameId>;
}) => {
  const lines = [
    result.added.length > 0
      ? `Added: ${listGameNames(result.added)}`
      : "No new games found.",
  ];
  if (result.tracked.length > 0) {
    lines.push(`Already tracking: ${listGameNames(result.tracked)}`);
  }
  if (result.missing.length > 0) {
    lines.push(`Still missing: ${listGameNames(result.missing)}`);
  }
  return lines.join("\n");
};

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
            return reply("You're already signed up, dummy");
          }
          yield* deps.database.subscribe({ guildId, discordUserId: user.id });
          return reply(
            `**${user.username}** just signed up!${setupHint}${linkHint}`,
          );
        }

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
            guildIds: [guildId],
          });

          return yield* followUp(
            result === "not-found"
              ? "Couldn't find recent account data for that Riot ID :("
              : existing
                ? `**${user.username}** switched to ${riotName}#${riotTag}.${setupHint}${linkHint}`
                : `**${user.username}** just signed up!${setupHint}${linkHint}`,
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
            content: `Sign in with Riot to get your ${games} matches reported here. Linking makes your match data visible to the members of the servers you sign up in. This link is only for you and works for 15 minutes.`,
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
            : `**${user.username}** signed out of this server's reports.`,
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("signout failed", error).pipe(
            Effect.as(reply("Signout failed, try again in a bit :(")),
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
            content:
              "Match reports will be posted here. Run `/signup` to have yours included.",
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

const refresh = (deps: CommandDeps) =>
  Ix.global(
    {
      name: "refresh",
      description:
        "Recheck your Riot ID for games that weren't found at signup",
      ...inServers,
    },
    (i) =>
      Effect.gen(function* () {
        const user = i.interaction.member?.user ?? i.interaction.user;
        if (!user) return reply("Couldn't tell who ran that command :(");

        const account = yield* deps.database.getAccount(user.id);
        if (!account) return reply("You're not signed up.");

        const followUp = (content: string) =>
          deps.rest.updateOriginalWebhookMessage(
            i.interaction.application_id,
            i.interaction.token,
            { payload: { content } },
          );

        const run = refreshAccount(deps, account).pipe(
          Effect.flatMap((result) => followUp(formatRefreshResult(result))),
          Effect.catch((error) =>
            Effect.logError("refresh failed", error).pipe(
              Effect.andThen(followUp("Refresh failed, try again in a bit :(")),
              Effect.ignore({
                log: "Error",
                message: "refresh follow-up failed",
              }),
            ),
          ),
        );

        yield* Effect.forkDetach(run);
        return deferredReply;
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("refresh lookup failed", error).pipe(
            Effect.as(reply("Refresh failed, try again in a bit :(")),
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
            logApiError("rank_check failed", error).pipe(
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
    .add(signout(deps))
    .add(setup(deps))
    .add(pause(deps))
    .add(resume(deps))
    .add(refresh(deps))
    .add(rankCheck(deps));
  const withLink = signInUrl ? base.add(link(signInUrl, optInGames)) : base;

  return (
    devMode ? withLink.concat(devCommands(deps)) : withLink
  ).catchAllCause(Effect.logError);
};
