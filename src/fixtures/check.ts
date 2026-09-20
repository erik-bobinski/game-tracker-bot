import { Effect } from "effect";
import { matchEmbed } from "../services/discord/embed.ts";
import type { GameId } from "../services/game/index.ts";
import {
  productionMatches,
  productionMatchesByGame,
  productionMatchReport,
} from "./production-matches.ts";

const games = ["lol", "valorant"] as const satisfies ReadonlyArray<GameId>;

const uniqueModes = (game: GameId) => [
  ...new Set(productionMatchesByGame(game).map((match) => match.mode)),
];

const program = Effect.gen(function* () {
  const lol = productionMatchesByGame("lol").length;
  const valorant = productionMatchesByGame("valorant").length;
  const modes = {
    lol: uniqueModes("lol"),
    valorant: uniqueModes("valorant"),
  };
  const payload = { ok: true, lol, valorant, modes };

  if (productionMatches.length !== 50 || lol !== 25 || valorant !== 25) {
    console.log(JSON.stringify({ ...payload, ok: false }));
    return yield* Effect.fail(
      new Error(
        `expected 50 matches (25 lol + 25 valorant), got ${productionMatches.length} (${lol} lol, ${valorant} valorant)`,
      ),
    );
  }

  for (const game of games) {
    const matches = productionMatchesByGame(game);
    for (let index = 0; index < matches.length; index++) {
      const report = yield* productionMatchReport({ game, index });
      const embed = matchEmbed(report, {});
      if (!embed.title || !embed.description) {
        console.log(JSON.stringify({ ...payload, ok: false }));
        return yield* Effect.fail(
          new Error(`${game}[${index}] embed missing title or description`),
        );
      }
    }
  }

  console.log(JSON.stringify(payload));
});

program.pipe(Effect.runPromise).catch(() => {
  process.exit(1);
});
