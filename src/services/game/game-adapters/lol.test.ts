import { expect, test } from "bun:test";
import { Schema } from "effect";
import { placementHalves } from "../../discord/embed.ts";
import { LolMatch } from "../game-api/lol/match-schema.ts";
import { lolMatchToDetails } from "./lol.ts";

// Riot's match as it sends it: queueId 1750 is an 18-player arena of six trios
// that Riot hadn't listed, so arena is known by its CHERRY mode
const riotMatch = (gameMode: string, queueId: number) =>
  Schema.decodeUnknownSync(LolMatch)({
    metadata: { matchId: "NA1_1", participants: [] },
    info: {
      gameMode,
      queueId,
      gameDuration: 1200,
      gameStartTimestamp: 0,
      platformId: "NA1",
      participants: [6, 2, 4, 1, 5, 3].flatMap((placement) =>
        ["a", "b", "c"].map((seat) => ({
          puuid: `${placement}${seat}`,
          riotIdGameName: `${placement}${seat}`,
          riotIdTagline: "na1",
          teamId: placement <= 3 ? 100 : 200,
          championId: 1,
          championName: "Annie",
          kills: placement,
          deaths: 1,
          assists: 2,
          win: placement <= 3,
          totalMinionsKilled: 0,
          neutralMinionsKilled: 0,
          totalDamageDealtToChampions: 12_300,
          largestMultiKill: 1,
          placement: gameMode === "CHERRY" ? placement : 0,
        })),
      ),
    },
  });

test("arena is read as placements, with each trio kept together", () => {
  const arena = lolMatchToDetails(riotMatch("CHERRY", 1750));
  expect(arena.kind).toBe("placement");
  expect(arena.mode).toBe("Arena");
  if (arena.kind !== "placement") return;
  const player = arena.players.find((p) => p.puuid === "4a");
  expect(player).toMatchObject({
    placement: 4,
    won: false,
    character: "Annie",
    stat: "4/1/2 · 12.3k dmg",
  });

  const { halves, teams } = placementHalves(arena.players);
  expect(teams).toBe(true);
  expect(halves.map((half) => half.places)).toEqual([3, 3]);
  expect(halves.map((half) => half.players.map((p) => p.puuid).join())).toEqual(
    ["1a,1b,1c,2a,2b,2c,3a,3b,3c", "4a,4b,4c,5a,5b,5c,6a,6b,6c"],
  );

  // every other mode is still two teams
  const aram = lolMatchToDetails(riotMatch("ARAM", 450));
  expect(aram.kind).toBe("versus");
  expect(aram.mode).toBe("ARAM");
});
