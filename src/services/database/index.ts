import { Clock, Context, Effect, Layer, Schema } from "effect";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { SqlSchema } from "effect/unstable/sql";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { AppConfig } from "../config.ts";
import { EpochMillis, GameId, MatchId, Puuid } from "../game/index.ts";

export const ReportedMatch = Schema.Struct({
  matchId: MatchId,
  date: EpochMillis,
});
export interface ReportedMatch extends Schema.Schema.Type<
  typeof ReportedMatch
> {}

export const REPORTED_MATCH_CAPACITY = 10;

export const pushReportedMatch = (
  existing: ReadonlyArray<ReportedMatch>,
  newMatch: ReportedMatch,
) =>
  [...existing.filter((match) => match.matchId !== newMatch.matchId), newMatch]
    .sort((a, b) => a.date - b.date)
    .slice(-REPORTED_MATCH_CAPACITY);

export const GameState = Schema.Struct({
  puuid: Puuid,
  route: Schema.String,
  trackingStartedAt: EpochMillis,
  reportedMatches: Schema.Array(ReportedMatch),
});
export interface GameState extends Schema.Schema.Type<typeof GameState> {}

export interface Account {
  readonly discordUserId: string;
  readonly discordName: string;
  readonly riotName: string;
  readonly riotTag: string;
  readonly games: Partial<Record<GameId, GameState>>;
}

type DatabaseFailure = SqlError | Schema.SchemaError;

export class LegacyImportError extends Schema.TaggedErrorClass<LegacyImportError>()(
  "Database.LegacyImportError",
  { path: Schema.String, cause: Schema.Defect() },
) {}

export class Database extends Context.Service<
  Database,
  {
    readonly addAccount: (
      account: Account,
    ) => Effect.Effect<void, DatabaseFailure>;
    readonly getAccounts: () => Effect.Effect<
      ReadonlyArray<Account>,
      DatabaseFailure
    >;
    readonly getAccount: (
      discordUserId: string,
    ) => Effect.Effect<Account | undefined, DatabaseFailure>;
    readonly hasAccount: (
      discordUserId: string,
    ) => Effect.Effect<boolean, DatabaseFailure>;
    readonly deleteGame: (
      discordUserId: string,
      game: GameId,
    ) => Effect.Effect<boolean, DatabaseFailure>;
    readonly deleteAccount: (
      discordUserId: string,
    ) => Effect.Effect<boolean, DatabaseFailure>;
    readonly markMatchAsReported: (input: {
      readonly discordUserIds: ReadonlyArray<string>;
      readonly game: GameId;
      readonly match: ReportedMatch;
    }) => Effect.Effect<void, DatabaseFailure>;
    readonly getPollingPaused: () => Effect.Effect<boolean, DatabaseFailure>;
    readonly setPollingPaused: (
      paused: boolean,
    ) => Effect.Effect<void, DatabaseFailure>;
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
  route: Schema.String,
  trackingStartedAt: EpochMillis,
  reportedMatches: ReportedMatches,
});

const LegacyAccount = Schema.Struct({
  discord_user_id: Schema.String,
  discord_name: Schema.String,
  riot_name: Schema.String,
  riot_tag: Schema.String,
  val_puuid: Schema.String,
  val_region: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reported_val_match_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  lol_puuid: Schema.String,
  lol_platform: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reported_lol_match_ids: Schema.optionalKey(Schema.Array(Schema.String)),
});

const LegacyDatabaseFile = Schema.Struct({
  schema_version: Schema.Number,
  accounts: Schema.Array(LegacyAccount),
});

export const migrations = SqliteMigrator.fromRecord({
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
  "3_add_game_routes": Effect.gen(function* () {
    const sql = yield* SqlClient;
    const migratedAt = yield* Clock.currentTimeMillis;
    yield* sql`ALTER TABLE account_games ADD COLUMN route TEXT`;
    yield* sql`ALTER TABLE account_games ADD COLUMN tracking_started_at INTEGER`;
    yield* sql`
      UPDATE account_games
      SET route = CASE WHEN game = 'valorant' THEN 'na/pc' ELSE 'na1' END,
          tracking_started_at = ${migratedAt}
      WHERE route IS NULL OR tracking_started_at IS NULL
    `;
  }),
});

const makeDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const { dbPath } = yield* AppConfig;

  const upsertAccountRow = SqlSchema.void({
    Request: AccountRow,
    execute: (account) => sql`
      INSERT INTO accounts (
        discord_user_id, discord_name, riot_name, riot_tag
      ) VALUES (
        ${account.discordUserId}, ${account.discordName},
        ${account.riotName}, ${account.riotTag}
      )
      ON CONFLICT(discord_user_id) DO UPDATE SET
        discord_name = excluded.discord_name,
        riot_name = excluded.riot_name,
        riot_tag = excluded.riot_tag
    `,
  });

  const insertGameRow = SqlSchema.void({
    Request: GameRow,
    execute: (row) => sql`
      INSERT INTO account_games (
        discord_user_id, game, puuid, route,
        tracking_started_at, reported_matches
      ) VALUES (
        ${row.discordUserId}, ${row.game}, ${row.puuid}, ${row.route},
        ${row.trackingStartedAt}, ${row.reportedMatches}
      )
      ON CONFLICT(discord_user_id, game) DO NOTHING
    `,
  });

  const addAccount = Effect.fn("Database.addAccount")(function* (
    account: Account,
  ) {
    yield* upsertAccountRow(account);
    for (const game of GameId.literals) {
      const state = account.games[game];
      if (!state) continue;
      yield* insertGameRow({
        discordUserId: account.discordUserId,
        game,
        ...state,
      });
    }
  }, sql.withTransaction);

  const accountRowsQuery = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: AccountRow,
    execute: () => sql`
      SELECT discord_user_id AS "discordUserId",
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
      SELECT discord_user_id AS "discordUserId", game, puuid, route,
             tracking_started_at AS "trackingStartedAt",
             reported_matches AS "reportedMatches"
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
        route: row.route,
        trackingStartedAt: row.trackingStartedAt,
        reportedMatches: row.reportedMatches,
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
    return (yield* getAccounts()).find(
      (account) => account.discordUserId === discordUserId,
    );
  });

  const hasAccount = Effect.fn("Database.hasAccount")(function* (
    discordUserId: string,
  ) {
    return (yield* getAccount(discordUserId)) !== undefined;
  });

  const deleteGame = Effect.fn("Database.deleteGame")(function* (
    discordUserId: string,
    game: GameId,
  ) {
    const account = yield* getAccount(discordUserId);
    if (!account?.games[game]) return false;
    yield* sql`
        DELETE FROM account_games
        WHERE discord_user_id = ${discordUserId} AND game = ${game}
      `;
    yield* sql`
        DELETE FROM accounts
        WHERE discord_user_id = ${discordUserId}
          AND NOT EXISTS (
            SELECT 1 FROM account_games
            WHERE discord_user_id = ${discordUserId}
          )
      `;
    return true;
  }, sql.withTransaction);

  const deleteAccount = Effect.fn("Database.deleteAccount")(function* (
    discordUserId: string,
  ) {
    if (!(yield* hasAccount(discordUserId))) return false;
    yield* sql`DELETE FROM accounts WHERE discord_user_id = ${discordUserId}`;
    return true;
  }, sql.withTransaction);

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

  const markMatchAsReported = Effect.fn("Database.markMatchAsReported")(
    function* (input: {
      readonly discordUserIds: ReadonlyArray<string>;
      readonly game: GameId;
      readonly match: ReportedMatch;
    }) {
      if (input.discordUserIds.length === 0) return;
      const rows = yield* reportedMatchesQuery({
        ...input,
        discordUserIds: [...input.discordUserIds],
      });
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

  const existingRows = yield* accountRowsQuery({});
  const legacyPath = join(dirname(dbPath), "accounts.json");
  if (
    existingRows.length === 0 &&
    legacyPath !== dbPath &&
    existsSync(legacyPath)
  ) {
    const raw = yield* Effect.try({
      try: () => readFileSync(legacyPath, "utf8"),
      catch: (cause) => new LegacyImportError({ path: legacyPath, cause }),
    });
    const json = yield* Effect.try({
      try: (): unknown =>
        JSON.parse(raw.replace(/("discord_user_id"\s*:\s*)(\d+)/g, '$1"$2"')),
      catch: (cause) => new LegacyImportError({ path: legacyPath, cause }),
    });
    const legacyAccounts = Array.isArray(json)
      ? yield* Schema.decodeUnknownEffect(Schema.Array(LegacyAccount))(json)
      : (yield* Schema.decodeUnknownEffect(LegacyDatabaseFile)(json)).accounts;
    const importedAt = EpochMillis.make(yield* Clock.currentTimeMillis);
    for (const legacy of legacyAccounts) {
      const games: Account["games"] = {};
      if (legacy.lol_puuid !== "") {
        games.lol = {
          puuid: Puuid.make(legacy.lol_puuid),
          route: legacy.lol_platform ?? "na1",
          trackingStartedAt: importedAt,
          reportedMatches: (legacy.reported_lol_match_ids ?? [])
            .slice(0, REPORTED_MATCH_CAPACITY)
            .map((matchId) => ({
              matchId: MatchId.make(matchId),
              date: EpochMillis.make(0),
            })),
        };
      }
      if (legacy.val_puuid !== "") {
        games.valorant = {
          puuid: Puuid.make(legacy.val_puuid),
          route: `${legacy.val_region ?? "na"}/pc`,
          trackingStartedAt: importedAt,
          reportedMatches: (legacy.reported_val_match_ids ?? [])
            .slice(0, REPORTED_MATCH_CAPACITY)
            .map((matchId) => ({
              matchId: MatchId.make(matchId),
              date: EpochMillis.make(0),
            })),
        };
      }
      if (Object.keys(games).length === 0) continue;
      yield* addAccount({
        discordUserId: legacy.discord_user_id,
        discordName: legacy.discord_name,
        riotName: legacy.riot_name,
        riotTag: legacy.riot_tag,
        games,
      });
    }
    yield* Effect.logInfo("imported legacy account database").pipe(
      Effect.annotateLogs({
        path: legacyPath,
        accounts: legacyAccounts.length,
      }),
    );
  }

  return Database.of({
    addAccount,
    getAccounts,
    getAccount,
    hasAccount,
    deleteGame,
    deleteAccount,
    markMatchAsReported,
    getPollingPaused,
    setPollingPaused,
  });
});

const SqliteLive = Layer.unwrap(
  AppConfig.pipe(
    Effect.map(({ dbPath }) => SqliteClient.layer({ filename: dbPath })),
  ),
);

const DatabaseSchemaLive = SqliteMigrator.layer({ loader: migrations }).pipe(
  Layer.provideMerge(SqliteLive),
);

export const DatabaseLive = Layer.effect(Database, makeDatabase).pipe(
  Layer.provide(DatabaseSchemaLive),
);
