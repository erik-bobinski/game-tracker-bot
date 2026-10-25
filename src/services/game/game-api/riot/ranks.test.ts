import { describe, expect, test } from "bun:test";
import { riotRankStep } from "./ranks.ts";

const entry = (
  tier: string,
  rank: string,
  leaguePoints: number,
  games: number,
) => ({
  tier,
  rank,
  leaguePoints,
  wins: games,
  losses: 0,
});

describe("riotRankStep", () => {
  test("a first reading has no delta, only a snapshot", () => {
    const { update, snapshot } = riotRankStep(
      undefined,
      entry("GOLD", "II", 40, 10),
    );
    expect(update).not.toHaveProperty("delta");
    expect(snapshot).toEqual({ standing: "GOLD II", points: 40, games: 10 });
  });

  test("a game within a division gains or loses the LP difference", () => {
    const previous = { standing: "GOLD II", points: 40, games: 10 };
    expect(
      riotRankStep(previous, entry("GOLD", "II", 62, 11)).update,
    ).toMatchObject({
      delta: 22,
      tierChange: undefined,
    });
    expect(
      riotRankStep(previous, entry("GOLD", "II", 21, 11)).update,
    ).toMatchObject({
      delta: -19,
    });
  });

  test("a promotion carries the LP over and records the move", () => {
    const { update } = riotRankStep(
      { standing: "GOLD I", points: 90, games: 10 },
      entry("PLATINUM", "IV", 8, 11),
    );
    expect(update).toMatchObject({ delta: 18, tierChange: { promoted: true } });
  });

  test("dropping a division within a tier carries the LP over", () => {
    const { update } = riotRankStep(
      { standing: "GOLD I", points: 10, games: 10 },
      entry("GOLD", "II", 75, 11),
    );
    expect(update).toMatchObject({
      delta: -35,
      tierChange: { promoted: false },
    });
  });

  test("dropping a tier has no delta, since the LP it lands on is set by MMR", () => {
    const { update } = riotRankStep(
      { standing: "PLATINUM IV", points: 0, games: 10 },
      entry("GOLD", "I", 75, 11),
    );
    expect(update).not.toHaveProperty("delta");
    expect(update).toMatchObject({ tierChange: { promoted: false } });
  });

  test("apex tiers share one LP pool", () => {
    const { update } = riotRankStep(
      { standing: "MASTER I", points: 180, games: 10 },
      entry("GRANDMASTER", "I", 210, 11),
    );
    expect(update).toMatchObject({ delta: 30, tierChange: { promoted: true } });
  });

  test("a reading more than one game on isn't pinned on this game", () => {
    const { update } = riotRankStep(
      { standing: "GOLD II", points: 40, games: 10 },
      entry("GOLD", "II", 80, 12),
    );
    expect(update).not.toHaveProperty("delta");
    expect(update).not.toHaveProperty("tierChange");
  });
});
