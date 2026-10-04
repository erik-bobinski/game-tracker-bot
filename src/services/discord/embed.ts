import type { Discord } from "dfx";
import { Array } from "effect";
import { gameNames } from "../game/index.ts";
import type {
  GameId,
  MatchDetails,
  MatchPlayerIdentity,
  MatchTeam,
  PlacementMatch,
  PlacementPlayer,
  Puuid,
  RankInfo,
  RankUpdate,
  VersusMatch,
  VersusPlayer,
} from "../game/index.ts";

export interface MatchReport {
  readonly tracked: ReadonlyArray<{
    readonly discordName: string;
    readonly puuid: Puuid;
  }>;
  readonly match: MatchDetails;
  readonly rankUpdates: ReadonlyMap<Puuid, RankUpdate>;
}

// reports on a team match, which get a verdict and a match card
export type VersusReport = MatchReport & { readonly match: VersusMatch };

// reports on a free-for-all match, ranked by where each player finished
export type PlacementReport = MatchReport & { readonly match: PlacementMatch };

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
const playerRows = (player: VersusPlayer, context: RowContext) => {
  const icon = rankEmoji(player, context.game, context.emojis);
  const update = context.rankUpdates.get(player.puuid);
  const movement = rankMovement(update);
  const headline = [
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
    icon || update?.current ? undefined : player.rank,
    player.flair,
    player.puuid === context.mvpPuuid ? "MVP" : undefined,
  ]);
  return [headline, `-# ${stats}`].join("\n");
};

const teamField = (
  team: MatchTeam,
  label: string,
  players: ReadonlyArray<VersusPlayer>,
  context: RowContext,
): Discord.RichEmbedField => ({
  name: joinParts([
    label,
    team.won === true ? "Win" : undefined,
    team.score?.[0] === undefined ? undefined : String(team.score[0]),
  ]),
  value: [...players]
    .sort((a, b) => b.sortKey - a.sortKey)
    .map((player) => playerRows(player, context))
    .join("\n"),
});

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

// How the tracked players' result is headlined: the colour sets the tone
// before anything is read, the verb carries it into the description.
const verdicts = {
  win: { label: "Victory", color: 0x57f287, verb: "won" },
  loss: { label: "Defeat", color: 0xed4245, verb: "lost" },
  draw: { label: "Draw", color: 0xfee75c, verb: "drew" },
  unknown: { label: "Match complete", color: 0x99aab5, verb: "finished" },
} as const;

const teamOutcome = (team: MatchTeam | undefined) =>
  team === undefined
    ? "unknown"
    : team.won === true
      ? "win"
      : team.won === false
        ? "loss"
        : "draw";

// Each tracked player's outcome from their own side. The verdict is the one
// they all share, or the neutral "unknown" when tracked players were
// opponents; trackedTeam is the first tracked player's side, and teams puts it
// first so the people being reported on lead both scoreboards.
export const matchVerdict = (report: VersusReport) => {
  const { match } = report;
  const teamOf = (puuid: Puuid) => {
    const teamId = match.players.find((player) => player.puuid === puuid)?.team;
    return match.teams.find((team) => team.id === teamId);
  };
  const tracked = report.tracked.map(
    (player) =>
      ({ ...player, outcome: teamOutcome(teamOf(player.puuid)) }) as const,
  );
  const [first, ...rest] = tracked;
  const key =
    first && rest.every((player) => player.outcome === first.outcome)
      ? first.outcome
      : "unknown";
  const trackedTeam = first && teamOf(first.puuid);
  return {
    key,
    verdict: verdicts[key],
    trackedTeam,
    teams: [...match.teams].sort(
      (a, b) => Number(b === trackedTeam) - Number(a === trackedTeam),
    ),
    tracked,
  } as const;
};

// How a scoreboard heads the team at this position in matchVerdict's teams
export const teamLabel = (index: number) =>
  `Team ${String.fromCharCode(65 + index)}`;

// "**A** and **B** won a **Competitive** game on **Ascent**.", or one clause
// per outcome when tracked players were opponents:
// "**A** and **B** won, **C** lost a **Competitive** game on **Ascent**."
const versusSummary = (report: VersusReport) => {
  const { match } = report;
  const clauses = Object.values(
    Array.groupBy(matchVerdict(report).tracked, (player) => player.outcome),
  ).map(
    (group) =>
      `${nameList(group.map((player) => player.discordName))} ${verdicts[group[0].outcome].verb}`,
  );
  return `${clauses.join(", ")} a **${match.mode}** game${match.map ? ` on **${match.map}**` : ""}.`;
};

const versusEmbed = (
  report: VersusReport,
  rankEmojis: RankEmojis,
): Discord.RichEmbed => {
  const { match } = report;
  const trackedPuuids = new Set(report.tracked.map((player) => player.puuid));
  const { verdict, trackedTeam, teams } = matchVerdict(report);

  const context: RowContext = {
    game: match.game,
    emojis: rankEmojis,
    rankUpdates: report.rankUpdates,
    trackedPuuids,
    mvpPuuid: [...match.players].sort((a, b) => b.sortKey - a.sortKey)[0]
      ?.puuid,
  };

  const fields = teams.flatMap((team, index) => {
    const players = match.players.filter((player) => player.team === team.id);
    return players.length > 0
      ? [teamField(team, teamLabel(index), players, context)]
      : [];
  });

  return {
    author: { name: gameNames[match.game] },
    title: joinParts([verdict.label, trackedTeam?.score?.join("–")]),
    description: versusSummary(report),
    color: verdict.color,
    fields,
    footer: {
      text: joinParts([
        formatDuration(match.durationSeconds),
        match.surrendered ? "ended in a surrender" : undefined,
      ]),
    },
    timestamp: new Date(match.date).toISOString(),
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
      const rawName = `${player.riotName}#${player.riotTag}`;
      const name = trackedPuuids.has(player.puuid) ? `**${rawName}**` : rawName;
      const icon = rankEmoji(player, game, emojis);
      const update = rankUpdates.get(player.puuid);
      const prefix = icon
        ? `${icon}${player.rankDivision ? ` \`${player.rankDivision}\`` : ""} `
        : "";
      return joinParts([
        `${prefix}${name} — ${ordinal(player.placement)} Place`,
        player.stat,
        update?.delta !== undefined
          ? `${update.delta >= 0 ? "+" : ""}${update.delta} ${update.unit}${update.current ? ` (${update.current})` : ""}`
          : update?.current,
        icon || update?.current ? undefined : player.rank,
        player.flair,
      ]);
    })
    .join("\n");

// A lone tracked player's finish, where the top half counts as a win, or a
// neutral headline when several tracked players shared the lobby.
export const placementVerdict = (report: PlacementReport) => {
  const trackedPuuids = new Set(report.tracked.map(({ puuid }) => puuid));
  const tracked = report.match.players.filter((player) =>
    trackedPuuids.has(player.puuid),
  );
  const primary = tracked.length === 1 ? tracked[0] : undefined;
  const half = Math.ceil(report.match.players.length / 2);
  const key =
    primary === undefined
      ? "unknown"
      : primary.placement <= half
        ? "win"
        : "loss";
  const label = primary
    ? `${ordinal(primary.placement)} Place`
    : verdicts.unknown.label;
  return { key, label, trackedPuuids, half } as const;
};

// "**A** finished 4th, **B** finished 7th in a **Ranked TFT** game."
const placementSummary = (report: PlacementReport) => {
  const placements = new Map(
    report.match.players.map((player) => [player.puuid, player.placement]),
  );
  const clauses = report.tracked.flatMap(({ discordName, puuid }) => {
    const placement = placements.get(puuid);
    return placement === undefined
      ? []
      : [`**${discordName}** finished ${ordinal(placement)}`];
  });
  return `${clauses.join(", ")} in a **${report.match.mode}** game.`;
};

// The one line a match card is posted under
export const matchSummary = (report: MatchReport) => {
  const { match } = report;
  return match.kind === "versus"
    ? versusSummary({ ...report, match })
    : placementSummary({ ...report, match });
};

const placementEmbed = (
  report: PlacementReport,
  rankEmojis: RankEmojis,
): Discord.RichEmbed => {
  const { key, label, trackedPuuids } = placementVerdict(report);
  const info = [
    `Started <t:${Math.floor(report.match.date / 1000)}:t>`,
    formatDuration(report.match.durationSeconds),
  ];
  return {
    title: `${label} — ${report.match.mode}${report.match.map ? ` · ${report.match.map}` : ""}`,
    description: [
      `${nameList(report.tracked.map(({ discordName }) => discordName))} just finished a **${gameNames[report.match.game]}** game`,
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
    color: verdicts[key].color,
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
