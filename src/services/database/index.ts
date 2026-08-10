import { Config, Context, Effect, Layer, Schema } from "effect";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { SqlSchema } from "effect/unstable/sql";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { GameId, MatchId, Puuid } from "../game/index.ts";
import { EpochMillis } from "../game/index.ts";

const ReportedMatch = Schema.Struct({
  matchId: MatchId,
  date: EpochMillis,
});
export interface ReportedMatch extends Schema.Schema.Type<
  typeof ReportedMatch
> {}
const REPORTED_MATCH_CAPACITY = 10;
function pushReportedMatch(
  existing: ReadonlyArray<ReportedMatch>,
  newMatch: ReportedMatch,
) {
  return [...existing, newMatch]
    .sort((a, b) => a.date - b.date)
    .slice(-REPORTED_MATCH_CAPACITY);
}

export interface GameState {
  readonly puuid: Puuid;
  readonly reportedMatches: ReadonlyArray<ReportedMatch>;
  // riot platformId for lol ("na1"), henrik region for val ("na")
  readonly region: string | undefined;
}

export interface Account {
  readonly discordUserId: string;
  readonly discordName: string;
  readonly riotName: string;
  readonly riotTag: string;
  readonly games: Partial<Record<GameId, GameState>>;
}

export class Database extends Context.Service<
  Database,
  {
    readonly addAccount: (
      account: Account,
    ) => Effect.Effect<void, SqlError | Schema.SchemaError>;
    readonly getAccounts: () => Effect.Effect<
      ReadonlyArray<Account>,
      SqlError | Schema.SchemaError
    >;
    readonly getAccount: (
      discordUserId: string,
    ) => Effect.Effect<Account | undefined, SqlError | Schema.SchemaError>;
    readonly hasAccount: (
      discordUserId: string,
    ) => Effect.Effect<boolean, SqlError | Schema.SchemaError>;
    readonly deleteAccount: (
      discordUserId: string,
    ) => Effect.Effect<void, SqlError | Schema.SchemaError>;
    readonly clearReportedMatches: () => Effect.Effect<
      void,
      SqlError | Schema.SchemaError
    >;
    readonly markMatchAsReported: (input: {
      readonly discordUserIds: ReadonlyArray<string>;
      readonly game: GameId;
      readonly match: ReportedMatch;
    }) => Effect.Effect<void, SqlError | Schema.SchemaError>;
    readonly getPollingPaused: () => Effect.Effect<
      boolean,
      SqlError | Schema.SchemaError
    >;
    readonly setPollingPaused: (
      paused: boolean,
    ) => Effect.Effect<void, SqlError | Schema.SchemaError>;
  }
>()("app/Database") {}

const ReportedMatches = Schema.fromJsonString(Schema.Array(ReportedMatch));

const AccountRow = Schema.Struct({
  discordUserId: Schema.String,
  discordName: Schema.String,
  riotName: Schema.String,
  riotTag: Schema.String,
});

const GameRow = Schema.Struct({
  discordUserId: Schema.String,
  game: GameId,
  puuid: Puuid,
  reportedMatches: ReportedMatches,
  // null for accounts signed up before the region column existed
  region: Schema.NullOr(Schema.String),
});

const LegacyAccount = Schema.Struct({
  discord_user_id: Schema.Union([Schema.String, Schema.Number]),
  discord_name: Schema.String,
  riot_name: Schema.String,
  riot_tag: Schema.String,
  val_puuid: Schema.String,
  val_region: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reported_val_match_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  lol_puuid: Schema.String,
  lol_region: Schema.optionalKey(Schema.NullOr(Schema.String)),
  lol_platform: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reported_lol_match_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  added_at: Schema.String,
});

const LegacyDatabase = Schema.Union([
  Schema.Array(LegacyAccount),
  Schema.Struct({
    schema_version: Schema.Literal(1),
    accounts: Schema.Array(LegacyAccount),
  }),
]);
const LegacyDatabaseJson = Schema.fromJsonString(LegacyDatabase);

function legacyReportedMatches(
  matchIds: ReadonlyArray<string> | undefined,
  addedAt: string,
): ReadonlyArray<ReportedMatch> {
  const baseDate = Date.parse(addedAt);
  return [...(matchIds ?? [])]
    .slice(0, REPORTED_MATCH_CAPACITY)
    .reverse()
    .map((matchId, index) => ({
      matchId: MatchId.make(matchId),
      date: EpochMillis.make(baseDate + index),
    }));
}

const migrations = SqliteMigrator.fromRecord({
  "1_create_accounts": Effect.gen(function* () {
    const sql = yield* SqlClient;

    yield* sql`
      CREATE TABLE accounts (
        discord_user_id TEXT PRIMARY KEY NOT NULL,
        discord_name TEXT NOT NULL,
        riot_name TEXT NOT NULL,
        riot_tag TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `;

    yield* sql`
      CREATE TABLE account_games (
        discord_user_id TEXT NOT NULL
          REFERENCES accounts (discord_user_id) ON DELETE CASCADE,
        game TEXT NOT NULL,
        puuid TEXT NOT NULL,
        reported_matches TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (discord_user_id, game),
        -- A given riot account (per game) maps to at most one discord user.
        UNIQUE (game, puuid)
      )
    `;
  }),

  "2_create_settings": Effect.gen(function* () {
    const sql = yield* SqlClient;

    yield* sql`
      CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        polling_paused INTEGER NOT NULL DEFAULT 0
      )
    `;

    yield* sql`INSERT INTO settings (id, polling_paused) VALUES (1, 0)`;
  }),

  "3_add_account_region": Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`ALTER TABLE account_games ADD COLUMN region TEXT`;
  }),
});

export const databasePath = Config.string("DB_PATH").pipe(
  Config.withDefault("riot-tracker.sqlite"),
);

const makeDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const dbPath = yield* databasePath;

  const accountGameColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(account_games)
  `;
  if (!accountGameColumns.some((column) => column.name === "region")) {
    yield* sql`ALTER TABLE account_games ADD COLUMN region TEXT`;
  }

  const legacyPath = yield* Config.string("LEGACY_DB_PATH").pipe(
    Config.withDefault(""),
  );
  if (legacyPath) {
    const backupPath = `${legacyPath}.migrated.bak`;
    const legacyJson = yield* Effect.sync(() =>
      existsSync(legacyPath) ? readFileSync(legacyPath, "utf8") : undefined,
    );

    if (legacyJson !== undefined) {
      const decoded =
        yield* Schema.decodeUnknownEffect(LegacyDatabaseJson)(legacyJson);
      const legacyAccounts = "accounts" in decoded ? decoded.accounts : decoded;

      yield* Effect.gen(function* () {
        yield* sql`DELETE FROM account_games`;
        yield* sql`DELETE FROM accounts`;

        for (const account of legacyAccounts) {
          const discordUserId = String(account.discord_user_id);
          yield* sql`
            INSERT INTO accounts (
              discord_user_id, discord_name, riot_name, riot_tag, created_at
            ) VALUES (
              ${discordUserId}, ${account.discord_name}, ${account.riot_name},
              ${account.riot_tag}, ${account.added_at}
            )
          `;

          if (account.val_puuid) {
            yield* sql`
              INSERT INTO account_games (
                discord_user_id, game, puuid, reported_matches, region
              ) VALUES (
                ${discordUserId}, 'valorant', ${account.val_puuid},
                ${JSON.stringify(legacyReportedMatches(account.reported_val_match_ids, account.added_at))},
                ${account.val_region ?? null}
              )
            `;
          }

          if (account.lol_puuid) {
            yield* sql`
              INSERT INTO account_games (
                discord_user_id, game, puuid, reported_matches, region
              ) VALUES (
                ${discordUserId}, 'lol', ${account.lol_puuid},
                ${JSON.stringify(legacyReportedMatches(account.reported_lol_match_ids, account.added_at))},
                ${account.lol_platform ?? account.lol_region ?? null}
              )
            `;
          }
        }
      }).pipe(sql.withTransaction);

      yield* Effect.sync(() => renameSync(legacyPath, backupPath));
      yield* Effect.logInfo("migrated legacy database").pipe(
        Effect.annotateLogs({ accounts: legacyAccounts.length, backupPath }),
      );
    }
  }

  const insertAccountRow = SqlSchema.void({
    Request: AccountRow,
    execute: (account) => sql`
      INSERT OR REPLACE INTO accounts (
        discord_user_id,
        discord_name,
        riot_name,
        riot_tag
      ) VALUES (
        ${account.discordUserId},
        ${account.discordName},
        ${account.riotName},
        ${account.riotTag}
      )
    `,
  });

  const insertGameRow = SqlSchema.void({
    Request: GameRow,
    execute: (row) => sql`
      INSERT OR REPLACE INTO account_games (
        discord_user_id,
        game,
        puuid,
        reported_matches,
        region
      ) VALUES (
        ${row.discordUserId},
        ${row.game},
        ${row.puuid},
        ${row.reportedMatches},
        ${row.region}
      )
    `,
  });

  const addAccount = Effect.fn("Database.addAccount")(function* (
    account: Account,
  ) {
    yield* insertAccountRow(account);
    for (const [game, state] of Object.entries(account.games)) {
      if (state === undefined || !state?.puuid) continue;
      yield* insertGameRow({
        discordUserId: account.discordUserId,
        game: game as GameId,
        puuid: state.puuid,
        reportedMatches: state.reportedMatches,
        region: state.region ?? null,
      });
    }
  }, sql.withTransaction);

  const accountRowsQuery = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: AccountRow,
    execute: () => sql`
      SELECT
        discord_user_id AS "discordUserId",
        discord_name AS "discordName",
        riot_name AS "riotName",
        riot_tag AS "riotTag"
      FROM accounts
      ORDER BY discord_user_id
    `,
  });

  const gameRowsQuery = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: GameRow,
    execute: () => sql`
      SELECT
        discord_user_id AS "discordUserId",
        game,
        puuid,
        reported_matches AS "reportedMatches",
        region
      FROM account_games
    `,
  });

  const getAccounts = Effect.fn("Database.getAccounts")(function* () {
    const [accountRows, gameRows] = yield* Effect.all([
      accountRowsQuery({}),
      gameRowsQuery({}),
    ]);

    const gamesByUser = new Map<string, Partial<Record<GameId, GameState>>>();

    for (const row of gameRows) {
      const games = gamesByUser.get(row.discordUserId) ?? {};
      games[row.game] = {
        puuid: row.puuid,
        reportedMatches: row.reportedMatches,
        region: row.region ?? undefined,
      };
      gamesByUser.set(row.discordUserId, games);
    }

    return accountRows.map((row): Account => ({
      ...row,
      games: gamesByUser.get(row.discordUserId) ?? {},
    }));
  });

  const getAccount = Effect.fn("Database.getAccount")(function* (
    discordUserId: string,
  ) {
    const accounts = yield* getAccounts();
    return accounts.find((account) => account.discordUserId === discordUserId);
  });

  const accountExistsQuery = SqlSchema.findAll({
    Request: Schema.Struct({ discordUserId: Schema.String }),
    Result: Schema.Struct({ discordUserId: Schema.String }),
    execute: ({ discordUserId }) => sql`
      SELECT discord_user_id AS "discordUserId"
      FROM accounts
      WHERE discord_user_id = ${discordUserId}
    `,
  });

  const hasAccount = Effect.fn("Database.hasAccount")(function* (
    discordUserId: string,
  ) {
    const rows = yield* accountExistsQuery({ discordUserId });
    return rows.length > 0;
  });

  const deleteGameRows = SqlSchema.void({
    Request: Schema.Struct({ discordUserId: Schema.String }),
    execute: ({ discordUserId }) => sql`
      DELETE FROM account_games WHERE discord_user_id = ${discordUserId}
    `,
  });

  const deleteAccountRow = SqlSchema.void({
    Request: Schema.Struct({ discordUserId: Schema.String }),
    execute: ({ discordUserId }) => sql`
      DELETE FROM accounts WHERE discord_user_id = ${discordUserId}
    `,
  });

  const deleteAccount = Effect.fn("Database.deleteAccount")(function* (
    discordUserId: string,
  ) {
    yield* deleteGameRows({ discordUserId });
    yield* deleteAccountRow({ discordUserId });
  }, sql.withTransaction);

  const clearReportedMatchesQuery = SqlSchema.void({
    Request: Schema.Struct({}),
    execute: () => sql`UPDATE account_games SET reported_matches = '[]'`,
  });

  const clearReportedMatches = Effect.fn("Database.clearReportedMatches")(
    function* () {
      yield* clearReportedMatchesQuery({});
    },
  );

  const reportedMatchesQuery = SqlSchema.findAll({
    Request: Schema.Struct({
      game: GameId,
      discordUserIds: Schema.Array(Schema.String),
    }),
    Result: Schema.Struct({
      discordUserId: Schema.String,
      reportedMatches: ReportedMatches,
    }),
    execute: ({ game, discordUserIds }) => sql`
    SELECT discord_user_id AS "discordUserId",
           reported_matches AS "reportedMatches"
    FROM account_games
    WHERE game = ${game} AND ${sql.in("discord_user_id", discordUserIds)}
  `,
  });

  const updateReportedMatches = SqlSchema.void({
    Request: Schema.Struct({
      discordUserId: Schema.String,
      game: GameId,
      reportedMatches: ReportedMatches,
    }),
    execute: (row) => sql`
    UPDATE account_games
    SET reported_matches = ${row.reportedMatches}
    WHERE discord_user_id = ${row.discordUserId} AND game = ${row.game}
  `,
  });

  const markMatchAsReported = Effect.fn("Database.markReported")(
    function* (input: {
      readonly discordUserIds: ReadonlyArray<string>;
      readonly game: GameId;
      readonly match: ReportedMatch;
    }) {
      const rows = yield* reportedMatchesQuery(input);
      for (const row of rows) {
        yield* updateReportedMatches({
          discordUserId: row.discordUserId,
          game: input.game,
          reportedMatches: pushReportedMatch(row.reportedMatches, input.match),
        });
      }
    },
    sql.withTransaction,
  );

  const settingsQuery = SqlSchema.findAll({
    Request: Schema.Struct({}),
    // sqlite has no boolean type, map the flag from 0 or 1
    Result: Schema.Struct({ pollingPaused: Schema.Number }),
    execute: () => sql`
      SELECT polling_paused AS "pollingPaused" FROM settings WHERE id = 1
    `,
  });

  const updatePollingPaused = SqlSchema.void({
    Request: Schema.Struct({ pollingPaused: Schema.Number }),
    execute: ({ pollingPaused }) => sql`
      UPDATE settings SET polling_paused = ${pollingPaused} WHERE id = 1
    `,
  });

  const getPollingPaused = Effect.fn("Database.getPollingPaused")(function* () {
    const rows = yield* settingsQuery({});
    return (rows[0]?.pollingPaused ?? 0) !== 0;
  });

  const setPollingPaused = Effect.fn("Database.setPollingPaused")(function* (
    paused: boolean,
  ) {
    yield* updatePollingPaused({ pollingPaused: paused ? 1 : 0 });
  });

  yield* Effect.logInfo("database ready; migrations applied").pipe(
    Effect.annotateLogs({ dbPath }),
  );

  return Database.of({
    addAccount,
    getAccounts,
    getAccount,
    hasAccount,
    deleteAccount,
    clearReportedMatches,
    markMatchAsReported,
    getPollingPaused,
    setPollingPaused,
  });
});

export const SqliteLive = Layer.unwrap(
  databasePath.pipe(Effect.map((filename) => SqliteClient.layer({ filename }))),
);

const DatabaseSchemaLive = SqliteMigrator.layer({
  loader: migrations,
}).pipe(Layer.provideMerge(SqliteLive));

export const DatabaseLive = Layer.effect(Database, makeDatabase).pipe(
  Layer.provide(DatabaseSchemaLive),
);
