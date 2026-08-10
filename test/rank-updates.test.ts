import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatRankUpdate, matchEmbed } from "../src/services/discord/embed.ts";
import { lolRankUpdate } from "../src/services/game/game-adapters/lol.ts";
import type { LolLeagueEntry } from "../src/services/game/game-api/lol/match-schema.ts";
import { EpochMillis, MatchId, Puuid } from "../src/services/game/index.ts";

const entry = (tier: string, rank: string, leaguePoints: number) =>
  ({
    queueType: "RANKED_SOLO_5x5",
    tier,
    rank,
    leaguePoints,
    wins: 10,
    losses: 8,
  }) satisfies LolLeagueEntry;

describe("rank updates", () => {
  it("formats positive, negative, zero, and unavailable deltas", () => {
    assert.equal(
      formatRankUpdate({ delta: 18, current: "Gold 2", unit: "RR" }),
      "+18 RR (Gold 2)",
    );
    assert.equal(
      formatRankUpdate({ delta: -21, current: "Gold 2", unit: "RR" }),
      "-21 RR (Gold 2)",
    );
    assert.equal(
      formatRankUpdate({ delta: 0, current: "Emerald II", unit: "LP" }),
      "+0 LP (Emerald II)",
    );
    assert.equal(
      formatRankUpdate({ current: "Emerald II · 42 LP", unit: "LP" }),
      "Emerald II · 42 LP",
    );
  });

  it("diffs comparable League snapshots", () => {
    assert.deepEqual(
      lolRankUpdate(entry("EMERALD", "II", 64), {
        tier: "EMERALD",
        division: "II",
        points: 40,
      }),
      { delta: 24, current: "Emerald II", unit: "LP" },
    );
  });

  it("does not invent deltas for initial snapshots or rank changes", () => {
    assert.deepEqual(lolRankUpdate(entry("EMERALD", "II", 64), undefined), {
      current: "Emerald II · 64 LP",
      unit: "LP",
    });
    assert.deepEqual(
      lolRankUpdate(entry("EMERALD", "IV", 12), {
        tier: "PLATINUM",
        division: "I",
        points: 90,
      }),
      { current: "Emerald IV · 12 LP", unit: "LP" },
    );
  });

  it("associates updates with tracked players on opposing teams", () => {
    const embed = matchEmbed(
      {
        discordNames: ["One", "Two"],
        trackedPuuids: ["one", "two"],
        rankUpdates: new Map([
          ["one", { delta: 18, current: "Gold 2", unit: "RR" }],
          ["two", { delta: -21, current: "Silver 3", unit: "RR" }],
        ]),
        match: {
          matchId: MatchId.make("match"),
          game: "valorant",
          date: EpochMillis.make(0),
          mode: "Competitive",
          durationSeconds: 60,
          surrendered: false,
          teams: [
            { id: "blue", won: true },
            { id: "red", won: false },
          ],
          players: [
            {
              puuid: Puuid.make("one"),
              team: "blue",
              riotName: "PlayerOne",
              riotTag: "NA1",
              character: "Jett",
              kills: 1,
              deaths: 2,
              assists: 3,
              stat: "100 ACS",
              sortKey: 1,
            },
            {
              puuid: Puuid.make("two"),
              team: "red",
              riotName: "PlayerTwo",
              riotTag: "NA1",
              character: "Sage",
              kills: 3,
              deaths: 2,
              assists: 1,
              stat: "200 ACS",
              sortKey: 2,
            },
          ],
        },
      },
      {},
    );

    assert.match(embed.description ?? "", /PlayerOne.*\+18 RR \(Gold 2\)/);
    assert.match(embed.description ?? "", /PlayerTwo.*-21 RR \(Silver 3\)/);
  });
});
