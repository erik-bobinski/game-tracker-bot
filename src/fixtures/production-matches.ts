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

export class ProductionFixtureError extends Schema.TaggedError<ProductionFixtureError>()(
  "ProductionFixtureError",
  { message: Schema.String },
) {}

const catalogText = readFileSync(
  new URL("./production-matches.json", import.meta.url),
  "utf8",
);

export const productionMatches: ReadonlyArray<MatchDetails> = Effect.runSync(
  Schema.decodeUnknownEffect(Schema.fromJsonString(ProductionCatalog))(
    catalogText,
  ).pipe(
    Effect.flatMap((catalog) =>
      Effect.forEach(catalog.matches, (entry) =>
        gameFixtures[entry.game].decode(entry.raw),
      ),
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
    const index = input.index ?? 0;
    const discordNames = input.discordNames ?? ["VerifyAgent"];
    const trackedCount = input.trackedCount ?? 2;
    const matches = productionMatchesByGame(input.game);
    const match = matches[index];
    if (!match) {
      return yield* new ProductionFixtureError({
        message: `No ${input.game} production fixture at index ${index} (${matches.length} available)`,
      });
    }
    return {
      discordNames,
      trackedPuuids: match.players
        .slice(0, trackedCount)
        .map((player) => player.puuid),
      match,
      rankUpdates: new Map(),
    } satisfies MatchReport;
  });
