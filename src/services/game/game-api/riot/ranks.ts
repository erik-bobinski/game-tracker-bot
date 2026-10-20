import type { RankUpdate } from "../../index.ts";

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

// The LP a game moved a stored "GOLD II" standing by. LP carries over on a
// promotion and on a drop within a tier, and master and up share one pool, so
// only dropping a tier, which lands on 25, 50 or 75 LP by MMR, has no delta.
export const riotRankChange = (
  previous: { readonly standing: string; readonly points: number } | undefined,
  entry: {
    readonly tier: string;
    readonly rank: string;
    readonly leaguePoints: number;
  },
): Pick<RankUpdate, "delta" | "tierChange"> => {
  if (!previous) return {};
  const [tier = "", rank = ""] = previous.standing.split(" ");
  const lp = entry.leaguePoints;
  if (tier === entry.tier && rank === entry.rank) {
    return { delta: lp - previous.points };
  }
  const from = { tier, rank };
  const promoted = riotRankOrder(entry) > riotRankOrder(from);
  const delta =
    riotApexTiers.has(tier.toLowerCase()) &&
    riotApexTiers.has(entry.tier.toLowerCase())
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
    ...(delta === undefined ? {} : { delta }),
    tierChange: { from: rankInfo(from), to: rankInfo(entry), promoted },
  };
};
