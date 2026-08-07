import type { Discord } from "dfx";
import type {
  GameId,
  MatchDetails,
  MatchPlayer,
  RankSummary,
} from "../game/index.ts";

export interface RankCheckRanks {
  readonly discordName: string;
  readonly game: GameId;
  readonly ranks: ReadonlyArray<RankSummary>;
  readonly iconUrl?: string;
}

export interface MatchReport {
  readonly discordNames: ReadonlyArray<string>;
  readonly trackedPuuids: ReadonlyArray<string>;
  readonly match: MatchDetails;
}

export type RankEmojis = Readonly<Record<string, string>>;

const rankColors: Record<GameId, number> = {
  lol: 0x0ac8b9,
  valorant: 0xff4655,
};

const gameNames: Record<GameId, string> = {
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

const lolDivision = (rank: string | undefined) =>
  rank?.match(/\b(IV|III|II|I)$/)?.[1];

const leaderboard = (
  players: ReadonlyArray<MatchPlayer>,
  trackedPuuids: ReadonlySet<string>,
  game: GameId,
  emojis: RankEmojis,
) =>
  [...players]
    .sort((left, right) => right.sortKey - left.sortKey)
    .map((player) => {
      const rawName = `${player.riotName}#${player.riotTag}`;
      const name = trackedPuuids.has(player.puuid) ? `**${rawName}**` : rawName;
      const icon = rankEmoji(player, game, emojis);
      const division = game === "lol" && icon ? lolDivision(player.rank) : "";
      return [
        icon ? `${icon}${division ? ` ${division}` : ""}` : undefined,
        `${name} (${player.character})`,
        `${player.kills}/${player.deaths}/${player.assists}`,
        player.stat,
        player.flair,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · ");
    })
    .join("\n");

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
          leaderboard(players, trackedPuuids, report.match.game, rankEmojis),
        )
        .join("\n\n"),
    ].join("\n"),
    color,
    ...(thumbnail ? { thumbnail: { url: thumbnail } } : {}),
  };
};

export const rankEmbed = (result: RankCheckRanks): Discord.RichEmbed => ({
  title: `${result.discordName}'s ${result.game === "lol" ? "League" : "Valorant"} Rank`,
  description: result.ranks
    .map((rank) => {
      const points = rank.pointsLabel ? ` \u00b7 ${rank.pointsLabel}` : "";
      const queue = rank.queueLabel
        ? ` (${rank.queueLabel.replace(/^Ranked /, "")})`
        : "";
      return `**${rank.label}**${points}${queue}`;
    })
    .join("\n"),
  color: rankColors[result.game],
  ...(result.iconUrl
    ? result.game === "lol"
      ? { image: { url: result.iconUrl } }
      : { thumbnail: { url: result.iconUrl } }
    : {}),
});
