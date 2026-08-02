import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Database } from "../src/services/database/index.ts";
import { EpochMillis, MatchId, Puuid } from "../src/services/game/index.ts";
import { databaseLayer, run } from "./helpers.ts";

const directories: Array<string> = [];

const temporaryDatabase = () => {
  const directory = mkdtempSync(join(tmpdir(), "riot-tracker-test-"));
  directories.push(directory);
  return join(directory, "test.sqlite");
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const account = (games: "lol" | "both" = "both") => ({
  discordUserId: "discord-1",
  discordName: "Tester",
  riotName: "MockAlpha",
  riotTag: "NA1",
  games: {
    lol: {
      puuid: Puuid.make("mock-na-alpha-lol"),
      route: "na1",
      trackingStartedAt: EpochMillis.make(1_000),
      reportedMatches: [],
    },
    ...(games === "both"
      ? {
          valorant: {
            puuid: Puuid.make("mock-na-alpha-val"),
            route: "na/pc",
            trackingStartedAt: EpochMillis.make(1_000),
            reportedMatches: [],
          },
        }
      : {}),
  },
});

describe("Database", () => {
  it("runs fresh migrations and supports game-specific and complete signout", async () => {
    const path = temporaryDatabase();
    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.addAccount(account());
        expect((yield* database.getAccounts())[0]?.games.valorant?.route).toBe(
          "na/pc",
        );
        expect(yield* database.deleteGame("discord-1", "valorant")).toBe(true);
        expect((yield* database.getAccount("discord-1"))?.games.valorant).toBe(
          undefined,
        );
        expect(yield* database.deleteGame("discord-1", "lol")).toBe(true);
        expect(yield* database.hasAccount("discord-1")).toBe(false);
        expect(yield* database.deleteAccount("discord-1")).toBe(false);
      }).pipe(Effect.provide(databaseLayer(path))),
    );
  });

  it("adds a missing game without replacing existing history", async () => {
    const path = temporaryDatabase();
    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.addAccount(account("lol"));
        yield* database.markMatchAsReported({
          discordUserIds: ["discord-1"],
          game: "lol",
          match: {
            matchId: MatchId.make("old"),
            date: EpochMillis.make(2_000),
          },
        });
        yield* database.addAccount(account());
        const stored = yield* database.getAccount("discord-1");
        expect(
          stored?.games.lol?.reportedMatches.map((match) => match.matchId),
        ).toEqual(["old"]);
        expect(stored?.games.valorant?.route).toBe("na/pc");
      }).pipe(Effect.provide(databaseLayer(path))),
    );
  });

  it("keeps only the newest ten unique reported matches", async () => {
    const path = temporaryDatabase();
    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.addAccount(account("lol"));
        for (let index = 0; index < 12; index += 1) {
          yield* database.markMatchAsReported({
            discordUserIds: ["discord-1"],
            game: "lol",
            match: {
              matchId: MatchId.make(`match-${index}`),
              date: EpochMillis.make(2_000 + index),
            },
          });
        }
        const matches = (yield* database.getAccount("discord-1"))?.games.lol
          ?.reportedMatches;
        expect(matches).toHaveLength(10);
        expect(matches?.[0]?.matchId).toBe("match-2");
      }).pipe(Effect.provide(databaseLayer(path))),
    );
  });

  it("migrates the pre-route schema with safe NA defaults", async () => {
    const path = temporaryDatabase();
    const sqlite = new DatabaseSync(path);
    sqlite.exec(`
      CREATE TABLE accounts (
        discord_user_id TEXT PRIMARY KEY NOT NULL,
        discord_name TEXT NOT NULL,
        riot_name TEXT NOT NULL,
        riot_tag TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE account_games (
        discord_user_id TEXT NOT NULL REFERENCES accounts(discord_user_id) ON DELETE CASCADE,
        game TEXT NOT NULL,
        puuid TEXT NOT NULL,
        reported_matches TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (discord_user_id, game),
        UNIQUE (game, puuid)
      );
      CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        polling_paused INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO settings VALUES (1, 0);
      CREATE TABLE effect_sql_migrations (
        migration_id integer PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      );
      INSERT INTO effect_sql_migrations(migration_id, name)
      VALUES (1, 'create_accounts'), (2, 'create_settings');
      INSERT INTO accounts(discord_user_id, discord_name, riot_name, riot_tag)
      VALUES ('legacy', 'Legacy', 'Old', 'NA1');
      INSERT INTO account_games(discord_user_id, game, puuid, reported_matches)
      VALUES
        ('legacy', 'lol', 'legacy-lol', '[{"matchId":"kept","date":1}]'),
        ('legacy', 'valorant', 'legacy-val', '[]');
    `);
    sqlite.close();

    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        const migrated = yield* database.getAccount("legacy");
        expect(migrated?.games.lol?.route).toBe("na1");
        expect(migrated?.games.valorant?.route).toBe("na/pc");
        expect(migrated?.games.lol?.reportedMatches[0]?.matchId).toBe("kept");
        expect(Number(migrated?.games.lol?.trackingStartedAt)).toBeGreaterThan(
          0,
        );
      }).pipe(Effect.provide(databaseLayer(path))),
    );
  });

  it("imports the legacy Railway JSON database once", async () => {
    const path = temporaryDatabase();
    writeFileSync(
      join(dirname(path), "accounts.json"),
      JSON.stringify({
        schema_version: 1,
        accounts: [
          {
            discord_user_id: 123456789012345678n.toString(),
            discord_name: "Legacy",
            riot_name: "MockAlpha",
            riot_tag: "NA1",
            val_puuid: "legacy-val",
            val_region: "na",
            reported_val_match_ids: ["val-old"],
            lol_puuid: "legacy-lol",
            lol_region: "americas",
            lol_platform: "na1",
            reported_lol_match_ids: ["lol-old"],
          },
        ],
      }).replace('"123456789012345678"', "123456789012345678"),
      "utf8",
    );

    await run(
      Effect.gen(function* () {
        const database = yield* Database;
        const imported = yield* database.getAccount("123456789012345678");
        expect(imported?.games.lol?.route).toBe("na1");
        expect(imported?.games.valorant?.route).toBe("na/pc");
        expect(imported?.games.lol?.reportedMatches[0]?.matchId).toBe(
          "lol-old",
        );
      }).pipe(Effect.provide(databaseLayer(path))),
    );
  });
});
