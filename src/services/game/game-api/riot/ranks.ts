import type { RankSnapshots } from "../../index.ts";

export const riotApexTiers = new Set(["master", "grandmaster", "challenger"]);

const STATIC_ASSETS =
  "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default";

const titleCase = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();

export const riotRankIcons = [
  "iron",
  "bronze",
  "silver",
  "gold",
  "platinum",
  "emerald",
  "diamond",
  "master",
  "grandmaster",
  "challenger",
].map((key) => ({
  key,
  // the winged emblems shrink to an unreadable smudge at emoji size, so use
  // the mini crests; riot ships emerald's as svg only, so it is rasterized
  url:
    key === "emerald"
      ? new URL("../../../../../assets/rank-lol-emerald.png", import.meta.url)
          .href
      : `${STATIC_ASSETS}/images/ranked-mini-crests/${key}.png`,
  largeUrl: `${STATIC_ASSETS}/ranked-emblem/emblem-${key}.png`,
}));

export const riotRankDisplay = (entry: {
  readonly tier: string;
  readonly rank: string;
}) => {
  const iconKey = entry.tier.toLowerCase();
  const division = riotApexTiers.has(iconKey) ? undefined : entry.rank;
  return {
    iconKey,
    division,
    label: division
      ? `${titleCase(entry.tier)} ${division}`
      : titleCase(entry.tier),
  };
};

const divisions = ["IV", "III", "II", "I"];

const riotRankOrder = (entry: {
  readonly tier: string;
  readonly rank: string;
}) =>
  riotRankIcons.findIndex((icon) => icon.key === entry.tier.toLowerCase()) *
    divisions.length +
  divisions.indexOf(entry.rank);

// What a tracked player's league entry says about the game just played, against
// the standing stored after their last one, plus the standing to store now.
// Only a reading exactly one ranked game on from the stored one can be pinned
// on this game: back to back games, a missed one, an entry that hasn't caught
// up yet, or a split reset would otherwise credit someone else's LP or rank
// change to it. LP carries over on a promotion and on a drop within a tier,
// and master and up share one pool, so only dropping a tier, which lands on
// 25, 50 or 75 LP by MMR, has no delta.
export const riotRankStep = (
  previous: RankSnapshots[string] | undefined,
  entry: {
    readonly tier: string;
    readonly rank: string;
    readonly leaguePoints: number;
    readonly wins: number;
    readonly losses: number;
  },
) => {
  const lp = entry.leaguePoints;
  const games = entry.wins + entry.losses;
  const snapshot = {
    standing: `${entry.tier} ${entry.rank}`,
    points: lp,
    games,
  };
  const { label } = riotRankDisplay(entry);
  // "·" already separates the report's fields, so keep LP parenthesised
  const unknown = { current: `${label} (${lp} LP)`, unit: "LP" };
  if (previous?.games !== games - 1) return { update: unknown, snapshot };

  const [tier = "", rank = ""] = previous.standing.split(" ");
  const from = { tier, rank };
  const moved = previous.standing !== snapshot.standing;
  const promoted = riotRankOrder(entry) > riotRankOrder(from);
  const delta =
    !moved ||
    (riotApexTiers.has(tier.toLowerCase()) &&
      riotApexTiers.has(entry.tier.toLowerCase()))
      ? lp - previous.points
      : promoted
        ? 100 - previous.points + lp
        : tier === entry.tier
          ? lp - 100 - previous.points
          : undefined;
  const rankInfo = (standing: typeof from) => {
    const { label, iconKey } = riotRankDisplay(standing);
    return { tier: label, iconKey };
  };
  return {
    update: {
      ...(delta === undefined
        ? unknown
        : { delta, current: label, unit: "LP" }),
      ...(moved
        ? {
            tierChange: { from: rankInfo(from), to: rankInfo(entry), promoted },
          }
        : {}),
    },
    snapshot,
  };
};
