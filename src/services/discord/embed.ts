import type { Discord } from "dfx";
import { gameNames } from "../game/index.ts";
import type {
  GameId,
  MatchDetails,
  MatchPlayer,
  MatchTeam,
  Puuid,
  RankInfo,
  RankUpdate,
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

// "32m 41s", dropping a zero component so a remake reads as "48s"
export const formatDuration = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest}s`;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
};

const joinParts = (parts: ReadonlyArray<string | undefined>) =>
  parts.filter((part): part is string => Boolean(part)).join(" · ");

const rankEmoji = (player: MatchPlayer, game: GameId, emojis: RankEmojis) => {
  if (!player.rankIconKey) return "";
  return (
    emojis[`${game}.${player.rankIconKey}`] ?? emojis[player.rankIconKey] ?? ""
  );
};

// "▲ 18 LP" on its own, and with the new standing appended for rows that have
// no crest to name it: "▲ 18 LP · Challenger"
const rankMovement = (update: RankUpdate | undefined) => {
  if (!update) return undefined;
  const delta =
    update.delta === undefined
      ? undefined
      : `${update.delta > 0 ? "▲" : update.delta < 0 ? "▼" : "▬"} ${Math.abs(update.delta)} ${update.unit}`;
  return { delta, full: joinParts([delta, update.current]) };
};

interface RowContext {
  readonly game: GameId;
  readonly emojis: RankEmojis;
  readonly rankUpdates: ReadonlyMap<Puuid, RankUpdate>;
  readonly trackedPuuids: ReadonlySet<Puuid>;
  readonly mvpPuuid: Puuid | undefined;
}

// Two lines per player: a headline to scan names by, and the numbers below it
// as discord subtext so a ten-player board still reads top to bottom.
const playerRows = (player: MatchPlayer, context: RowContext) => {
  const icon = rankEmoji(player, context.game, context.emojis);
  const movement = rankMovement(context.rankUpdates.get(player.puuid));
  const headline = [
    player.puuid === context.mvpPuuid ? "🥇" : undefined,
    icon || undefined,
    // the lol crests are per-tier, so the division goes beside them
    icon && player.rankDivision ? `\`${player.rankDivision}\`` : undefined,
    `${context.trackedPuuids.has(player.puuid) ? `**${player.riotName}**` : player.riotName} — ${player.character}`,
  ]
    .filter((token): token is string => Boolean(token))
    .join(" ");
  const stats = joinParts([
    `\`${player.kills}/${player.deaths}/${player.assists}\``,
    player.stat,
    // a crest already names the rank, so only the movement is worth repeating
    icon && movement?.delta ? movement.delta : movement?.full,
    icon ? undefined : player.rank,
    player.flair,
  ]);
  return [headline, `-# ${stats}`].join("\n");
};

const teamField = (
  team: MatchTeam,
  players: ReadonlyArray<MatchPlayer>,
  context: RowContext,
): Discord.RichEmbedField => ({
  name: joinParts([
    `${team.won === true ? "🏆 " : ""}${team.name ?? "Team"}`,
    team.score?.[0] === undefined ? undefined : String(team.score[0]),
  ]),
  value: [...players]
    .sort((a, b) => b.sortKey - a.sortKey)
    .map((player) => playerRows(player, context))
    .join("\n"),
});

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

// How the tracked players' result is headlined: the emoji and colour set the
// tone before anything is read, the verb carries it into the description.
const verdicts = {
  win: { emoji: "🏆", label: "Victory", color: 0x57f287, verb: "won" },
  loss: { emoji: "💀", label: "Defeat", color: 0xed4245, verb: "lost" },
  draw: { emoji: "🤝", label: "Draw", color: 0xfee75c, verb: "drew" },
  unknown: {
    emoji: "🎮",
    label: "Match complete",
    color: 0x99aab5,
    verb: "finished",
  },
} as const;

// The tracked players' side, and whether it won, lost, or drew.
export const matchVerdict = (report: MatchReport) => {
  const trackedPuuids = new Set(report.trackedPuuids);
  const trackedPlayer = report.match.players.find((player) =>
    trackedPuuids.has(player.puuid),
  );
  const trackedTeam = report.match.teams.find(
    (team) => team.id === trackedPlayer?.team,
  );
  const key =
    trackedTeam?.won === true
      ? "win"
      : trackedTeam?.won === false
        ? "loss"
        : trackedTeam
          ? "draw"
          : "unknown";
  return { key, verdict: verdicts[key], trackedTeam } as const;
};

// "**A** and **B** won a **Competitive** game on **Ascent**."
export const matchSummary = (report: MatchReport) => {
  const { match } = report;
  const { verdict } = matchVerdict(report);
  return `${nameList(report.discordNames)} ${verdict.verb} a **${match.mode}** game${match.map ? ` on **${match.map}**` : ""}.`;
};

export const matchEmbed = (
  report: MatchReport,
  rankEmojis: RankEmojis,
): Discord.RichEmbed => {
  const { match } = report;
  const trackedPuuids = new Set(report.trackedPuuids);
  const { verdict, trackedTeam } = matchVerdict(report);

  const context: RowContext = {
    game: match.game,
    emojis: rankEmojis,
    rankUpdates: report.rankUpdates,
    trackedPuuids,
    mvpPuuid: [...match.players].sort((a, b) => b.sortKey - a.sortKey)[0]
      ?.puuid,
  };

  // the tracked players' own team leads, so the people being reported on are
  // the first thing under the headline
  const teams = [...match.teams]
    .sort((a, b) => Number(b === trackedTeam) - Number(a === trackedTeam))
    .flatMap((team) => {
      const players = match.players.filter((player) => player.team === team.id);
      return players.length > 0 ? [teamField(team, players, context)] : [];
    });

  return {
    author: { name: gameNames[match.game] },
    title: joinParts([
      `${verdict.emoji} ${verdict.label}`,
      trackedTeam?.score?.join("–"),
    ]),
    description: matchSummary(report),
    color: verdict.color,
    fields: teams,
    footer: {
      text: joinParts([
        formatDuration(match.durationSeconds),
        match.surrendered ? "ended in a surrender" : undefined,
      ]),
    },
    timestamp: new Date(match.date).toISOString(),
  };
};
