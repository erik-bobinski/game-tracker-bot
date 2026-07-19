import { Context, Effect, Layer, Schema } from "effect";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { SqlSchema } from "effect/unstable/sql";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { GameId, Puuid } from "../game/index.js";
import { EpochMillis } from "../game/game-adapters/index.js";

// -----------------------------------------------------------------------------
// Domain model and service contract
// -----------------------------------------------------------------------------

const ReportedMatch = Schema.Struct({
  matchId: Schema.String,
  date: EpochMillis,
});

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

/** Migrations run once, in order, when the database layer is constructed. */
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
});

const makeDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient;

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

    return accountRows.map(
      (row): Account => ({
        ...row,
        games: gamesByUser.get(row.discordUserId) ?? {},
      }),
    );
  });

  return Database.of({ addAccount, getAccounts });
});

// -----------------------------------------------------------------------------
// Live layers
// -----------------------------------------------------------------------------

/** Low-level SQLite connection. Its lifetime is managed by the Effect scope. */
export const SqliteLive = SqliteClient.layer({
  filename: process.env.DB_PATH ?? "riot-tracker.sqlite",
});

/** SQLite connection plus pending database migrations. */
const DatabaseSchemaLive = SqliteMigrator.layer({
  loader: migrations,
}).pipe(Layer.provideMerge(SqliteLive));

/** Domain database service, backed by the migrated SQLite connection. */
export const DatabaseLive = Layer.effect(Database, makeDatabase).pipe(
  Layer.provide(DatabaseSchemaLive),
);
