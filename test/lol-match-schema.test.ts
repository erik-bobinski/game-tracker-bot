import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { LolMatch } from "../src/services/game/game-api/lol/match-schema.ts";

describe("LoL match schema", () => {
  it("accepts provider-defined numeric team ids", () => {
    const participant = (teamId: number) => ({
      puuid: `puuid-${teamId}`,
      riotIdGameName: "Player",
      riotIdTagline: "NA1",
      teamId,
      championName: "Annie",
      kills: 1,
      deaths: 2,
      assists: 3,
      win: false,
      totalMinionsKilled: 4,
      neutralMinionsKilled: 5,
      totalDamageDealtToChampions: 6,
      largestMultiKill: 1,
      gameEndedInSurrender: false,
    });

    const match = Schema.decodeUnknownSync(LolMatch)({
      metadata: {
        matchId: "NA1_123",
        participants: ["puuid-100", "puuid-300"],
      },
      info: {
        gameMode: "CHERRY",
        gameDuration: 1200,
        gameStartTimestamp: 1_700_000_000_000,
        queueId: 1700,
        platformId: "NA1",
        participants: [participant(100), participant(300)],
      },
    });

    expect(match.info.participants.map(({ teamId }) => teamId)).toEqual([
      100, 300,
    ]);
  });
});
