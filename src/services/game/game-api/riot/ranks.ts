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
