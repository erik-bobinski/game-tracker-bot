import assert from "node:assert/strict";
import { it } from "node:test";
import { Schema } from "effect";
import { ValMmrHistoryResponse } from "../src/services/game/game-api/val/match-schema.ts";
import { MatchId } from "../src/services/game/index.ts";

it("decodes Henrik MMR history into the adapter contract", () => {
  const response = Schema.decodeUnknownSync(ValMmrHistoryResponse)({
    status: 200,
    data: [
      {
        match_id: "match",
        mmr_change_to_last_game: 18,
        currenttierpatched: "Gold 2",
      },
    ],
  });

  assert.deepEqual(response.data, [
    { matchId: MatchId.make("match"), delta: 18, current: "Gold 2" },
  ]);
});
