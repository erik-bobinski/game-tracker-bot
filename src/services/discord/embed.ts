import type { Discord } from "dfx";
import { gameNames } from "../game/index.ts";
import type {
  GameId,
  MatchDetails,
  MatchPlayerIdentity,
  PlacementMatch,
  PlacementPlayer,
  Puuid,
  RankInfo,
  RankUpdate,
  VersusMatch,
  VersusPlayer,
} from "../game/index.ts";

export interface MatchReport {
  readonly discordNames: ReadonlyArray<string>;
  readonly trackedPuuids: ReadonlyArray<Puuid>;
  readonly match: MatchDetails;
  readonly rankUpdates: ReadonlyMap<Puuid, RankUpdate>;
}

export type RankEmojis = Readonly<Record<string, string>>;

const nameList = (names: ReadonlyArray<string>) => {
  const bolded = names.map((name) => `**${name}**`);
  const last = bolded.at(-1) ?? "";
  return bolded.length > 1
    ? `${bolded.slice(0, -1).join(", ")} and ${last}`
    : last;
};

const formatDuration = (seconds: number) =>
  `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

const rankEmoji = (
  player: MatchPlayerIdentity,
  game: GameId,
  emojis: RankEmojis,
) => {
  if (!player.rankIconKey) return "";
  return (
    emojis[`${game}.${player.rankIconKey}`] ?? emojis[player.rankIconKey] ?? ""
  );
};

const formatRankUpdate = (update: RankUpdate | undefined) =>
  update?.delta !== undefined
    ? `${update.delta >= 0 ? "+" : ""}${update.delta} ${update.unit}${update.current ? ` (${update.current})` : ""}`
    : update?.current;

const playerName = (
  player: MatchPlayerIdentity,
  trackedPuuids: ReadonlySet<Puuid>,
) => {
  const rawName = `${player.riotName}#${player.riotTag}`;
  return trackedPuuids.has(player.puuid) ? `**${rawName}**` : rawName;
};

const playerPrefix = (
  player: MatchPlayerIdentity,
  game: GameId,
  emojis: RankEmojis,
) => {
  const icon = rankEmoji(player, game, emojis);
  return {
    icon,
    text: icon
      ? `${icon}${player.rankDivision ? ` \`${player.rankDivision}\`` : ""} `
      : "",
  };
};

const playerExtras = (
  player: MatchPlayerIdentity,
  icon: string,
  rankUpdates: ReadonlyMap<Puuid, RankUpdate>,
) =>
  [
    player.stat,
    formatRankUpdate(rankUpdates.get(player.puuid)),
    icon ? undefined : player.rank,
    player.flair,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => ` · ${value}`)
    .join("");

const leaderboard = (
  players: ReadonlyArray<VersusPlayer>,
  trackedPuuids: ReadonlySet<Puuid>,
  game: GameId,
  emojis: RankEmojis,
  rankUpdates: ReadonlyMap<Puuid, RankUpdate>,
) =>
  [...players]
    .sort((a, b) => b.sortKey - a.sortKey)
    .map((player) => {
      const { icon, text } = playerPrefix(player, game, emojis);
      return `${text}${playerName(player, trackedPuuids)} (${player.character}) ${player.kills}/${player.deaths}/${player.assists}${playerExtras(player, icon, rankUpdates)}`;
    })
    .join("\n");

const ordinal = (n: number) => {
  const mod100 = n % 100;
  const suffix =
    mod100 >= 11 && mod100 <= 13
      ? "th"
      : n % 10 === 1
        ? "st"
        : n % 10 === 2
          ? "nd"
          : n % 10 === 3
            ? "rd"
            : "th";
  return `${n}${suffix}`;
};

export interface RankReport {
  readonly riotName: string;
  readonly game: GameId;
  readonly rank: RankInfo;
  readonly iconUrl: string | undefined;
}

export const rankEmbed = (report: RankReport): Discord.RichEmbed => ({
  title: `${report.riotName}'s ${gameNames[report.game]} Rank`,
  description: `**${report.rank.tier}**${report.rank.detail ? ` · ${report.rank.detail}` : ""}`,
  color: 0x1abc9c,
  ...(report.iconUrl ? { image: { url: report.iconUrl } } : {}),
});

const versusEmbed = (
  report: MatchReport & { match: VersusMatch },
  rankEmojis: RankEmojis,
): Discord.RichEmbed => {
  const trackedPuuids = new Set(report.trackedPuuids);
  const trackedPlayer = report.match.players.find((player) =>
    trackedPuuids.has(player.puuid),
  );
  const trackedTeam = report.match.teams.find(
    (team) => team.id === trackedPlayer?.team,
  );
  const verdict =
    trackedTeam?.won === true
      ? "Victory"
      : trackedTeam?.won === false
        ? "Defeat"
        : "Match complete";
  const color =
    trackedTeam?.won === true
      ? 0x57f287
      : trackedTeam?.won === false
        ? 0xed4245
        : 0x95a5a6;
  const teams = report.match.teams
    .map((team) =>
      report.match.players.filter((player) => player.team === team.id),
    )
    .filter((players) => players.length > 0);
  const info = [
    `Started <t:${Math.floor(report.match.date / 1000)}:t>`,
    `${formatDuration(report.match.durationSeconds)}${report.match.surrendered ? " (surrender)" : ""}`,
    trackedTeam?.score?.join("–"),
  ].filter((value): value is string => Boolean(value));
  return {
    title: `${verdict} — ${report.match.mode}${report.match.map ? ` · ${report.match.map}` : ""}`,
    description: [
      `${nameList(report.discordNames)} just finished a **${gameNames[report.match.game]}** game`,
      info.join(" · "),
      "",
      teams
        .map((players) =>
          leaderboard(
            players,
            trackedPuuids,
            report.match.game,
            rankEmojis,
            report.rankUpdates,
          ),
        )
        .join("\n\n"),
    ].join("\n"),
    color,
  };
};

const placementBoard = (
  players: ReadonlyArray<PlacementPlayer>,
  trackedPuuids: ReadonlySet<Puuid>,
  game: GameId,
  emojis: RankEmojis,
  rankUpdates: ReadonlyMap<Puuid, RankUpdate>,
) =>
  [...players]
    .sort((a, b) => a.placement - b.placement)
    .map((player) => {
      const { icon, text } = playerPrefix(player, game, emojis);
      return `${text}${playerName(player, trackedPuuids)} — ${ordinal(player.placement)} Place${playerExtras(player, icon, rankUpdates)}`;
    })
    .join("\n");

const placementEmbed = (
  report: MatchReport & { match: PlacementMatch },
  rankEmojis: RankEmojis,
): Discord.RichEmbed => {
  const trackedPuuids = new Set(report.trackedPuuids);
  const tracked = report.match.players.filter((player) =>
    trackedPuuids.has(player.puuid),
  );
  const primary = tracked.length === 1 ? tracked[0] : undefined;
  const verdict =
    tracked.length > 1
      ? "TFT Results"
      : primary
        ? `${ordinal(primary.placement)} Place`
        : "Match complete";
  const color =
    tracked.length !== 1
      ? 0x95a5a6
      : primary && primary.placement <= 4
        ? 0x57f287
        : 0xed4245;
  const info = [
    `Started <t:${Math.floor(report.match.date / 1000)}:t>`,
    formatDuration(report.match.durationSeconds),
  ];
  return {
    title: `${verdict} — ${report.match.mode}${report.match.map ? ` · ${report.match.map}` : ""}`,
    description: [
      `${nameList(report.discordNames)} just finished a **${gameNames[report.match.game]}** game`,
      info.join(" · "),
      "",
      placementBoard(
        report.match.players,
        trackedPuuids,
        report.match.game,
        rankEmojis,
        report.rankUpdates,
      ),
    ].join("\n"),
    color,
  };
};

export const matchEmbed = (
  report: MatchReport,
  rankEmojis: RankEmojis,
): Discord.RichEmbed => {
  switch (report.match.kind) {
    case "versus":
      return versusEmbed({ ...report, match: report.match }, rankEmojis);
    case "placement":
      return placementEmbed({ ...report, match: report.match }, rankEmojis);
    default: {
      const _exhaustive: never = report.match;
      throw new Error(`unhandled match kind: ${_exhaustive}`);
    }
  }
};
