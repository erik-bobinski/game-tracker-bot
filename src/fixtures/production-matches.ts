import { readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import type { MatchReport } from "../services/discord/embed.ts";
import { lolMatchToDetails } from "../services/game/game-adapters/lol.ts";
import { valMatchToDetails } from "../services/game/game-adapters/valorant.ts";
import { LolMatch } from "../services/game/game-api/lol/match-schema.ts";
import { ValRawMatch } from "../services/game/game-api/val/match-schema.ts";
import { GameId, type MatchDetails } from "../services/game/index.ts";

const defineGameFixture = <S extends Schema.Top>(
  schema: S,
  toDetails: (match: S["Type"]) => MatchDetails,
) => ({
  schema,
  toDetails,
  decode: (raw: unknown) =>
    Schema.decodeUnknownEffect(schema)(raw).pipe(Effect.map(toDetails)),
});

const gameFixtures = {
  lol: defineGameFixture(LolMatch, lolMatchToDetails),
  valorant: defineGameFixture(ValRawMatch, valMatchToDetails),
};

const CatalogEntry = Schema.Struct({
  game: GameId,
  raw: Schema.Unknown,
});

const ProductionCatalog = Schema.Struct({
  source: Schema.String,
  capturedAt: Schema.String,
  counts: Schema.Struct({
    lol: Schema.Number,
    valorant: Schema.Number,
    total: Schema.Number,
  }),
  matches: Schema.Array(CatalogEntry),
});

const ProductionMatchReportInput = Schema.Struct({
  game: GameId,
  index: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  discordNames: Schema.Array(Schema.String),
  trackedCount: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
});

const catalogText = readFileSync(
  new URL("./production-matches.json", import.meta.url),
  "utf8",
);

const decodeCatalogMatch = (entry: typeof CatalogEntry.Type) =>
  gameFixtures[entry.game].decode(entry.raw);

// Import-time decode so admin and /dev_report fail on a bad catalog.
export const productionMatches: readonly MatchDetails[] = Effect.runSync(
  Schema.decodeUnknownEffect(Schema.fromJsonString(ProductionCatalog))(
    catalogText,
  ).pipe(
    Effect.flatMap((catalog) =>
      Effect.forEach(catalog.matches, decodeCatalogMatch),
    ),
  ),
);

export const productionMatchesByGame = (game: GameId) =>
  productionMatches.filter((match) => match.game === game);

export const productionMatchReport = (input: {
  readonly game: GameId;
  readonly index?: number;
  readonly discordNames?: ReadonlyArray<string>;
  readonly trackedCount?: number;
}) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(
      ProductionMatchReportInput,
    )({
      game: input.game,
      index: input.index ?? 0,
      discordNames: input.discordNames ?? ["VerifyAgent"],
      trackedCount: input.trackedCount ?? 2,
    });
    const matches = productionMatchesByGame(request.game);
    if (matches.length === 0) {
      return yield* Schema.decodeUnknownEffect(Schema.Never)(request.game);
    }
    const index = yield* Schema.decodeUnknownEffect(
      Schema.Number.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 0, maximum: matches.length - 1 }),
      ),
    )(request.index);
    const match = matches[index];
    if (match === undefined) {
      return yield* Schema.decodeUnknownEffect(Schema.Never)(request.index);
    }
    return {
      discordNames: request.discordNames,
      trackedPuuids: match.players
        .slice(0, request.trackedCount)
        .map((player) => player.puuid),
      match,
      rankUpdates: new Map(),
    } satisfies MatchReport;
  });
