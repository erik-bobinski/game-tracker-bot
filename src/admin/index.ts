import {
  NodeHttpClient,
  NodeRuntime,
  NodeServices,
} from "@effect/platform-node";
import {
  Config,
  Console,
  Effect,
  Layer,
  Logger,
  Option,
  References,
  Runtime,
  Schema,
} from "effect";
import { Argument, Command, Flag, Prompt } from "effect/unstable/cli";
import {
  DiscordConfig,
  DiscordREST,
  DiscordRESTLive,
  MemoryRateLimitStoreLive,
} from "dfx";
import {
  registerAccount,
  refreshAccount,
  formatRefreshResult,
} from "../services/discord/commands.ts";
import { buildMockMatchReport } from "../services/discord/dev-commands.ts";
import { matchEmbed } from "../services/discord/embed.ts";
import {
  Database,
  DatabaseLive,
  databasePath,
  type Account,
} from "../services/database/index.ts";
import {
  GameAdapters,
  GameAdaptersLive,
} from "../services/game/game-adapters/index.ts";
import { RiotApiLive } from "../services/game/game-api/lol/riot-api-client.ts";
import { HenrikApiClientLive } from "../services/game/game-api/val/henrik-api-client.ts";
import { gameIds, gameNames, type GameId } from "../services/game/index.ts";

// Anything the operator caused or can fix: an unknown account, a riot id that
// resolves to nothing, an api that wouldn't answer. Exit 2 belongs to the
// argument parser, so these take 3.
class AdminError extends Schema.TaggedError<AdminError>()("AdminError", {
  message: Schema.String,
}) {
  readonly [Runtime.errorExitCode] = 3;
  // printed as one line by the runner below, not as an effect cause dump
  readonly [Runtime.errorReported] = false;
}

const fail = (message: string) => Effect.fail(new AdminError({ message }));

// keeps the underlying failure readable without dumping a cause
const orFail =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.mapError(effect, (cause) => {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return new AdminError({
        message: detail ? `${message}: ${detail}` : message,
      });
    });

// --json is for scripts, and a script has nobody to answer a prompt
const ask = <A>(json: boolean, missing: string, prompt: Prompt.Prompt<A>) =>
  json ? fail(missing) : Prompt.run(prompt);

const emit = (json: boolean, data: unknown, lines: ReadonlyArray<string>) =>
  Console.log(json ? JSON.stringify(data, null, 2) : lines.join("\n"));

const riotId = (account: Account) => `${account.riotName}#${account.riotTag}`;

const trackedGames = (account: Account) =>
  (Object.keys(account.games) as ReadonlyArray<GameId>).filter(
    (game) => account.games[game] !== undefined,
  );

const accounts = Database.pipe(
  Effect.flatMap((database) => database.getAccounts()),
  orFail("Could not read accounts"),
);

// An operator has a discord name or a riot id at hand far more often than a
// snowflake, so any of the three names an account; with no target at all they
// pick one off the list.
const resolveAccount = (
  json: boolean,
  list: ReadonlyArray<Account>,
  target: Option.Option<string>,
  message: string,
) =>
  Effect.gen(function* () {
    const wanted = Option.getOrUndefined(target)?.trim();

    if (wanted === undefined) {
      if (list.length === 0) {
        return yield* fail("No accounts are signed up yet.");
      }
      return yield* ask(
        json,
        "Pass a discord id, discord name, or riot id.",
        Prompt.autoComplete({
          message,
          choices: list.map((account) => ({
            title: `${account.discordName} — ${riotId(account)}`,
            value: account,
            description: account.discordUserId,
          })),
        }),
      );
    }

    const needle = wanted.replace(/^@/, "").toLowerCase();
    const [match, ...rest] = list.filter(
      (account) =>
        account.discordUserId === wanted ||
        account.discordName.toLowerCase() === needle ||
        riotId(account).toLowerCase() === needle ||
        account.riotName.toLowerCase() === needle,
    );

    if (!match) return yield* fail(`No tracked account matches "${wanted}".`);
    if (rest.length > 0) {
      return yield* fail(
        `"${wanted}" matches ${rest.length + 1} accounts; pass the discord user id instead.`,
      );
    }
    return match;
  });

const GameLive = GameAdaptersLive.pipe(
  Layer.provide(
    Layer.mergeAll(RiotApiLive, HenrikApiClientLive).pipe(
      Layer.provide(NodeHttpClient.layerUndici),
    ),
  ),
);

const DiscordRestLive = DiscordRESTLive.pipe(
  Layer.provide(MemoryRateLimitStoreLive),
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(
    DiscordConfig.layerConfig({
      token: Config.redacted("DISCORD_BOT_TOKEN"),
    }),
  ),
);

const withGameAdapters = <A, E>(
  run: (adapters: GameAdapters["Service"]) => Effect.Effect<A, E | AdminError>,
) =>
  Effect.gen(function* () {
    const adapters = yield* GameAdapters;
    return yield* run(adapters);
  }).pipe(
    Effect.provide(GameLive),
    Effect.mapError((cause) =>
      cause instanceof AdminError
        ? cause
        : new AdminError({
            message: `This command needs RIOT_API_KEY and HENRIK_API_KEY${
              cause instanceof Error && cause.message
                ? `: ${cause.message}`
                : ""
            }`,
          }),
    ),
  );

const withDiscordRest = <A, E>(
  run: (
    rest: Effect.Success<typeof DiscordREST>,
  ) => Effect.Effect<A, E | AdminError>,
) =>
  Effect.gen(function* () {
    const rest = yield* DiscordREST;
    return yield* run(rest);
  }).pipe(
    Effect.provide(DiscordRestLive),
    Effect.mapError((cause) =>
      cause instanceof AdminError
        ? cause
        : new AdminError({
            message: `This command needs DISCORD_BOT_TOKEN and NOTIFICATION_CHANNEL_ID${
              cause instanceof Error && cause.message
                ? `: ${cause.message}`
                : ""
            }`,
          }),
    ),
  );

const admin = Command.make("admin").pipe(
  Command.withDescription(
    "Inspect and operate the running bot: accounts, polling, and status.",
  ),
  Command.withSharedFlags({
    json: Flag.boolean("json").pipe(
      Flag.withDescription("Print json instead of text, and never prompt"),
    ),
  }),
);

const status = Command.make(
  "status",
  {},
  Effect.fn(function* () {
    const { json } = yield* admin;
    const database = yield* Database;
    const list = yield* accounts;
    const paused = yield* database
      .getPollingPaused()
      .pipe(orFail("Could not read the polling flag"));
    const path = yield* databasePath;

    const rows = list.map((account) => {
      const games = trackedGames(account);
      const dates = games.flatMap((game) =>
        (account.games[game]?.reportedMatches ?? []).map((match) => match.date),
      );
      return {
        discordUserId: account.discordUserId,
        discordName: account.discordName,
        riotId: riotId(account),
        games,
        lastReportedAt:
          dates.length === 0
            ? undefined
            : new Date(Math.max(...dates)).toISOString(),
      };
    });

    // header plus one line per account, every column but the last padded out
    const table = [
      ["DISCORD", "DISCORD ID", "RIOT ID", "GAMES", "LAST REPORT"],
      ...rows.map((row) => [
        row.discordName,
        row.discordUserId,
        row.riotId,
        row.games.join(", ") || "-",
        row.lastReportedAt?.replace("T", " ").slice(0, 16) ?? "never",
      ]),
    ];
    const widths = table.reduce<Array<number>>(
      (acc, row) =>
        row.map((cell, index) => Math.max(acc[index] ?? 0, cell.length)),
      [],
    );

    yield* emit(
      json,
      { pollingPaused: paused, databasePath: path, accounts: rows },
      [
        `Polling:   ${paused ? "paused" : "active"}`,
        `Accounts:  ${list.length}`,
        `Database:  ${path}`,
        "",
        ...(rows.length === 0
          ? ["No accounts are signed up yet."]
          : table.map((row) =>
              row
                .map((cell, index) =>
                  index === row.length - 1
                    ? cell
                    : cell.padEnd(widths[index] ?? 0),
                )
                .join("  "),
            )),
      ],
    );
  }),
).pipe(
  Command.withDescription(
    "Show polling state, the database in use, and every tracked account",
  ),
);

const signup = Command.make(
  "signup",
  {
    target: Argument.string("riot-id").pipe(
      Argument.withDescription("riot id to track, as name#tag (e.g. syan#NA1)"),
      Argument.optional,
    ),
    discordId: Flag.string("discord-id").pipe(
      Flag.withDescription("discord user id that owns this riot account"),
      Flag.optional,
    ),
    discordName: Flag.string("discord-name").pipe(
      Flag.withDescription(
        "name shown in match reports (defaults to the riot name)",
      ),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ target, discordId, discordName }) {
    const { json } = yield* admin;
    const database = yield* Database;

    const rawRiotId = yield* Option.match(target, {
      onNone: () =>
        ask(
          json,
          "Pass a riot id as name#tag.",
          Prompt.text({ message: "Riot id (name#tag)" }),
        ),
      onSome: Effect.succeed,
    });
    const [riotName, riotTag, ...extra] = rawRiotId
      .trim()
      .replace(/^@/, "")
      .split("#");
    if (!riotName || !riotTag || extra.length > 0) {
      return yield* fail(`"${rawRiotId}" is not a riot id; expected name#tag.`);
    }

    const discordUserId = yield* Option.match(discordId, {
      onNone: () =>
        ask(
          json,
          "Pass --discord-id.",
          Prompt.text({ message: "Discord user id" }),
        ),
      onSome: Effect.succeed,
    });

    const existing = yield* database
      .hasAccount(discordUserId)
      .pipe(orFail("Could not check for an existing account"));
    if (existing) {
      return yield* fail(`Discord user ${discordUserId} is already signed up.`);
    }

    const result = yield* withGameAdapters((adapters) =>
      registerAccount(
        { database, gameAdapters: adapters },
        {
          discordUserId,
          discordName: Option.getOrElse(discordName, () => riotName),
          riotName,
          riotTag,
        },
      ).pipe(orFail("Signup failed")),
    );

    if (result === "not-found") {
      return yield* fail(
        `No recent data in any supported game for ${riotName}#${riotTag}; nothing was saved.`,
      );
    }

    const account = yield* database
      .getAccount(discordUserId)
      .pipe(orFail("Signup saved but could not be read back"));
    const games = account ? trackedGames(account) : [];

    yield* emit(
      json,
      { discordUserId, riotId: `${riotName}#${riotTag}`, games },
      [
        `Signed up ${riotName}#${riotTag} for discord user ${discordUserId}.`,
        `Tracking: ${games.map((game) => gameNames[game]).join(", ") || "nothing"}`,
      ],
    );
  }),
).pipe(
  Command.withDescription("Track a riot account on a discord user's behalf"),
  Command.withExamples([
    {
      command: "admin signup syan#NA1 --discord-id 195042765893632000",
      description: "Sign someone up without them running /signup",
    },
  ]),
);

const signout = Command.make(
  "signout",
  {
    target: Argument.string("target").pipe(
      Argument.withDescription("discord id, discord name, or riot id"),
      Argument.optional,
    ),
    yes: Flag.boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("Skip the confirmation prompt"),
    ),
  },
  Effect.fn(function* ({ target, yes }) {
    const { json } = yield* admin;
    const database = yield* Database;
    const list = yield* accounts;
    const account = yield* resolveAccount(
      json,
      list,
      target,
      "Sign out which account?",
    );

    const confirmed =
      yes ||
      json ||
      (yield* Prompt.run(
        Prompt.confirm({
          message: `Delete ${account.discordName} (${riotId(account)}) and all their tracked data?`,
        }),
      ));
    if (!confirmed) return yield* fail("Cancelled; nothing was deleted.");

    yield* database
      .deleteAccount(account.discordUserId)
      .pipe(orFail("Signout failed"));

    yield* emit(
      json,
      { discordUserId: account.discordUserId, riotId: riotId(account) },
      [
        `Signed out ${account.discordName} (${riotId(account)}); all their data is deleted.`,
        `Accounts remaining: ${list.length - 1}`,
      ],
    );
  }),
).pipe(Command.withDescription("Stop tracking an account and delete its data"));

// The bot re-reads this flag every few seconds, so it takes effect without a
// restart and without this process talking to it.
const setPolling = (paused: boolean) =>
  Effect.fn(function* () {
    const { json } = yield* admin;
    const database = yield* Database;
    yield* database
      .setPollingPaused(paused)
      .pipe(orFail(`Could not ${paused ? "pause" : "resume"} polling`));

    yield* emit(json, { pollingPaused: paused }, [
      `Match reports ${paused ? "paused" : "resumed"}; the bot picks this up within a few seconds.`,
    ]);
  });

const pause = Command.make("pause", {}, setPolling(true)).pipe(
  Command.withDescription("Stop posting match reports (the bot shows as idle)"),
);

const resume = Command.make("resume", {}, setPolling(false)).pipe(
  Command.withDescription("Start posting match reports again"),
);

const rankCheck = Command.make(
  "rank-check",
  {
    target: Argument.string("target").pipe(
      Argument.withDescription("discord id, discord name, or riot id"),
      Argument.optional,
    ),
    game: Flag.choice("game", gameIds).pipe(
      Flag.withDescription("which game's rank to look up"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ target, game }) {
    const { json } = yield* admin;
    const list = yield* accounts;
    const account = yield* resolveAccount(
      json,
      list,
      target,
      "Check whose rank?",
    );
    const played = trackedGames(account);

    const chosen = yield* Option.match(game, {
      onNone: () =>
        played.length === 1 && played[0] !== undefined
          ? Effect.succeed(played[0])
          : ask(
              json,
              "Pass --game.",
              Prompt.select({
                message: `Which game for ${account.discordName}?`,
                choices: played.map((id) => ({
                  title: gameNames[id],
                  value: id,
                })),
              }),
            ),
      onSome: Effect.succeed<GameId>,
    });

    const state = account.games[chosen];
    if (!state) {
      return yield* fail(
        `${account.discordName} isn't signed up for ${gameNames[chosen]}.`,
      );
    }

    const rank = yield* withGameAdapters((adapters) => {
      const adapter = adapters.all.find(
        (candidate) => candidate.game === chosen,
      );
      if (!adapter) return fail(`${gameNames[chosen]} isn't supported.`);
      return adapter
        .getRank(state.puuid, state.region)
        .pipe(orFail("Rank lookup failed"));
    });

    yield* emit(
      json,
      {
        discordUserId: account.discordUserId,
        riotId: riotId(account),
        game: chosen,
        rank: rank ?? null,
      },
      [
        rank
          ? `${riotId(account)} — ${gameNames[chosen]}: ${[rank.tier, rank.detail].filter(Boolean).join(" · ")}`
          : `${riotId(account)} has no ranked ${gameNames[chosen]} data.`,
      ],
    );
  }),
).pipe(
  Command.withDescription("Look up a tracked account's current rank"),
  Command.withAlias("rank"),
);

const refresh = Command.make(
  "refresh",
  {
    target: Argument.string("target").pipe(
      Argument.withDescription("discord id, discord name, or riot id"),
      Argument.optional,
    ),
  },
  Effect.fn(function* ({ target }) {
    const { json } = yield* admin;
    const database = yield* Database;
    const list = yield* accounts;
    const account = yield* resolveAccount(
      json,
      list,
      target,
      "Refresh which account?",
    );

    const result = yield* withGameAdapters((adapters) =>
      refreshAccount({ database, gameAdapters: adapters }, account).pipe(
        orFail("Refresh failed"),
      ),
    );

    yield* emit(
      json,
      {
        discordUserId: account.discordUserId,
        riotId: riotId(account),
        added: result.added,
        tracked: result.tracked,
        missing: result.missing,
      },
      [
        `Refreshed ${account.discordName} (${riotId(account)}).`,
        formatRefreshResult(result),
      ],
    );
  }),
).pipe(
  Command.withDescription(
    "Recheck a signed-up account for games that weren't found at signup",
  ),
);

const reportMock = Command.make(
  "report-mock",
  {
    game: Flag.choice("game", gameIds).pipe(
      Flag.withDescription("which game's mock match to post"),
      Flag.withDefault("lol"),
    ),
  },
  Effect.fn(function* ({ game }) {
    const { json } = yield* admin;
    const channelId = yield* Config.nonEmptyString("NOTIFICATION_CHANNEL_ID");
    const report = yield* buildMockMatchReport(game).pipe(
      orFail("Could not build mock match report"),
    );

    yield* withDiscordRest((rest) =>
      rest
        .createMessage(channelId, {
          embeds: [matchEmbed(report, {})],
        })
        .pipe(orFail("Could not post mock match report")),
    );

    yield* emit(json, { game, channelId, matchId: report.match.matchId }, [
      `Posted a mock ${gameNames[game]} match report to channel ${channelId}.`,
    ]);
  }),
).pipe(
  Command.withDescription(
    "Post a mock match report embed to the notification channel",
  ),
);

const cli = admin.pipe(
  Command.withSubcommands([
    status,
    signup,
    signout,
    pause,
    resume,
    rankCheck,
    refresh,
    reportMock,
  ]),
  Command.run({ version: "1.0.0" }),
);

// Command output is the product here, so the bot's own info logging stays out
// of the way unless LOG_LEVEL asks for it.
const LoggerLive = Layer.unwrap(
  Config.logLevel("LOG_LEVEL").pipe(
    Config.withDefault("Warn"),
    Effect.map((logLevel) =>
      Layer.mergeAll(
        Logger.layer([Logger.consolePretty({ colors: "auto" })]),
        Layer.succeed(References.MinimumLogLevel, logLevel),
      ),
    ),
  ),
);

const runner = cli.pipe(
  // a prompt the operator escaped out of, which is not a crash
  Effect.catchTag("QuitError", () => fail("Cancelled.")),
  Effect.tapError((error) =>
    error._tag === "AdminError" ? Console.error(error.message) : Effect.void,
  ),
  Effect.provide(DatabaseLive),
  Effect.provide(LoggerLive),
  Effect.provide(NodeServices.layer),
  Effect.scoped,
);

NodeRuntime.runMain(runner);
