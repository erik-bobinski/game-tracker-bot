import { Context, Effect, Layer, Schema } from "effect";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { SqlSchema } from "effect/unstable/sql";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

// -----------------------------------------------------------------------------
// Domain model and service contract
// -----------------------------------------------------------------------------

const Account = Schema.Struct({
  discordUserId: Schema.String,
  discordName: Schema.String,
  riotName: Schema.String,
  riotTag: Schema.String,
  valPuuid: Schema.NullOr(Schema.String),
  lolPuuid: Schema.NullOr(Schema.String),
});
type Account = Schema.Schema.Type<typeof Account>;

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
        val_puuid TEXT,
        lol_puuid TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `;
  }),
});

const makeDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient;

  const addAccount = SqlSchema.void({
    Request: Account,
    execute: (account) => sql`INSERT OR REPLACE INTO accounts (
        discord_user_id,
        discord_name,
        riot_name,
        riot_tag,
        val_puuid,
        lol_puuid
      ) VALUES (
        ${account.discordUserId},
        ${account.discordName},
        ${account.riotName},
        ${account.riotTag},
        ${account.valPuuid},
        ${account.lolPuuid}
      )
    `,
  });

  const getAccountsQuery = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: Account,
    execute: () => sql`
      SELECT
        discord_user_id AS "discordUserId",
        discord_name AS "discordName",
        riot_name AS "riotName",
        riot_tag AS "riotTag",
        val_puuid AS "valPuuid",
        lol_puuid AS "lolPuuid"
      FROM accounts
      ORDER BY discord_user_id
    `,
  });
  const getAccounts = () => getAccountsQuery({});

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
