import { Context, Effect, Layer, Schema } from "effect";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { SqlSchema } from "effect/unstable/sql";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { GameId, MatchId, Puuid } from "../game/index.ts";
import { EpochMillis } from "../game/index.ts";

// -----------------------------------------------------------------------------
// Domain model and service contract
// -----------------------------------------------------------------------------

const ReportedMatch = Schema.Struct({
  matchId: MatchId,
  date: EpochMillis,
});
export interface ReportedMatch extends Schema.Schema.Type<
  typeof ReportedMatch
> {}
const REPORTED_MATCH_CAPACITY = 10;
// maintains a ring buffer of newest N-matches
function pushReportedMatch(
  existing: ReadonlyArray<ReportedMatch>,
  newMatch: ReportedMatch,
) {
  return [...existing, newMatch]
    .sort((a, b) => a.date - b.date)
    .slice(-REPORTED_MATCH_CAPACITY);
}

const GameState = Schema.Struct({
  puuid: Puuid,
  reportedMatches: Schema.Array(ReportedMatch),
});
interface GameState extends Schema.Schema.Type<typeof GameState> {}

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

// -----------------------------------------------------------------------------
// Row codecs (persistence boundary)
// -----------------------------------------------------------------------------

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
});

// -----------------------------------------------------------------------------
// Database implementation
// -----------------------------------------------------------------------------

// Migrations run once, in order, when the database layer is constructed
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

    // single row, so the check constraint keeps it that way
    yield* sql`
      CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        polling_paused INTEGER NOT NULL DEFAULT 0
      )
    `;

    yield* sql`INSERT INTO settings (id, polling_paused) VALUES (1, 0)`;
  }),
});

const makeDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient;

  // addAccount
  // -----------------------------------------------------------------------------
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
        reported_matches
      ) VALUES (
        ${row.discordUserId},
        ${row.game},
        ${row.puuid},
        ${row.reportedMatches}
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
      });
    }
  }, sql.withTransaction);

  // getAccounts
  // -----------------------------------------------------------------------------
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
        reported_matches AS "reportedMatches"
      FROM account_games
    `,
  });

  const getAccounts = Effect.fn("Database.getAccounts")(function* () {
    const [accountRows, gameRows] = yield* Effect.all([
      accountRowsQuery({}),
      gameRowsQuery({}),
    ]);

    // {discordUserId: {gameId: {puuid, reportedMatches}}}
    const gamesByUser = new Map<string, Partial<Record<GameId, GameState>>>();

    for (const row of gameRows) {
      const games = gamesByUser.get(row.discordUserId) ?? {};
      games[row.game] = {
        puuid: row.puuid,
        reportedMatches: row.reportedMatches,
      };
      gamesByUser.set(row.discordUserId, games);
    }

    return accountRows.map((row): Account => ({
      ...row,
      games: gamesByUser.get(row.discordUserId) ?? {},
    }));
  });

  // markMatchAsReported
  // -----------------------------------------------------------------------------
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

  // polling pause flag
  // -----------------------------------------------------------------------------
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

  return Database.of({
    addAccount,
    getAccounts,
    markMatchAsReported,
    getPollingPaused,
    setPollingPaused,
  });
});

// -----------------------------------------------------------------------------
// Live layers
// -----------------------------------------------------------------------------

// Low-level SQLite connection. Its lifetime is managed by the Effect scope
export const SqliteLive = SqliteClient.layer({
  filename: process.env.DB_PATH ?? "riot-tracker.sqlite",
});

// SQLite connection plus pending database migrations
const DatabaseSchemaLive = SqliteMigrator.layer({
  loader: migrations,
}).pipe(Layer.provideMerge(SqliteLive));

// Domain database service, backed by the migrated SQLite connection
export const DatabaseLive = Layer.effect(Database, makeDatabase).pipe(
  Layer.provide(DatabaseSchemaLive),
);
