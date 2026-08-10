import type { Discord } from "dfx";
import type {
  GameId,
  MatchDetails,
  MatchPlayer,
  RankInfo,
  RankUpdate,
} from "../game/index.ts";

export interface MatchReport {
  readonly discordNames: ReadonlyArray<string>;
  readonly trackedPuuids: ReadonlyArray<string>;
  readonly match: MatchDetails;
  readonly rankUpdates: ReadonlyMap<string, RankUpdate>;
}

export type RankEmojis = Readonly<Record<string, string>>;

export const gameNames: Record<GameId, string> = {
  lol: "League of Legends",
  valorant: "Valorant",
};

const nameList = (names: ReadonlyArray<string>) => {
  const bolded = names.map((name) => `**${name}**`);
  const last = bolded.at(-1) ?? "";
  return bolded.length > 1
    ? `${bolded.slice(0, -1).join(", ")} and ${last}`
    : last;
};

const formatDuration = (seconds: number) =>
  `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

const rankEmoji = (player: MatchPlayer, game: GameId, emojis: RankEmojis) => {
  if (!player.rankIconKey) return "";
  return (
    emojis[`${game}.${player.rankIconKey}`] ?? emojis[player.rankIconKey] ?? ""
  );
};

export const formatRankUpdate = (update: RankUpdate) =>
  update.delta !== undefined
    ? `${update.delta >= 0 ? "+" : ""}${update.delta} ${update.unit}${update.current ? ` (${update.current})` : ""}`
    : update.current;

const leaderboard = (
  players: ReadonlyArray<MatchPlayer>,
  trackedPuuids: ReadonlySet<string>,
  game: GameId,
  emojis: RankEmojis,
  rankUpdates: ReadonlyMap<string, RankUpdate>,
) =>
  [...players]
    .sort((a, b) => b.sortKey - a.sortKey)
    .map((player) => {
      const rawName = `${player.riotName}#${player.riotTag}`;
      const name = trackedPuuids.has(player.puuid) ? `**${rawName}**` : rawName;
      const icon = rankEmoji(player, game, emojis);
      const update = rankUpdates.get(player.puuid);
      const rankUpdate = update ? formatRankUpdate(update) : undefined;
      const prefix = icon
        ? `${icon}${player.rankDivision ? ` \`${player.rankDivision}\`` : ""} `
        : "";
      const extras = [
        player.stat,
        rankUpdate,
        icon ? undefined : player.rank,
        player.flair,
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => ` · ${value}`)
        .join("");
      return `${prefix}${name} (${player.character}) ${player.kills}/${player.deaths}/${player.assists}${extras}`;
    })
    .join("\n");

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

export const matchEmbed = (
  report: MatchReport,
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
  const thumbnail = trackedPlayer?.thumbnailUrl;

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
    ...(thumbnail ? { thumbnail: { url: thumbnail } } : {}),
  };
};
