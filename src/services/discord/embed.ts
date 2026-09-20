import { Discord, UI } from "dfx";
import { gameNames } from "../game/index.ts";
import type {
  GameId,
  MatchDetails,
  MatchPlayer,
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
export type GameLogos = Readonly<Record<string, string>>;

const nameList = (names: ReadonlyArray<string>) => {
  const bolded = names.map((name) => `**${name}**`);
  const last = bolded.at(-1) ?? "";
  return bolded.length > 1
    ? `${bolded.slice(0, -1).join(", ")} and ${last}`
    : last;
};

const formatDuration = (seconds: number) =>
  `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

const rankAsset = (
  player: MatchPlayer,
  game: GameId,
  assets: Readonly<Record<string, string>>,
) => {
  if (!player.rankIconKey) return "";
  return (
    assets[`${game}.${player.rankIconKey}`] ?? assets[player.rankIconKey] ?? ""
  );
};

const leaderboard = (
  players: ReadonlyArray<MatchPlayer>,
  trackedPuuids: ReadonlySet<Puuid>,
  game: GameId,
  emojis: RankEmojis,
  rankUpdates: ReadonlyMap<Puuid, RankUpdate>,
) =>
  [...players]
    .sort((a, b) => b.sortKey - a.sortKey)
    .map((player) => {
      const rawName = `${player.riotName}#${player.riotTag}`;
      const name = trackedPuuids.has(player.puuid) ? `**${rawName}**` : rawName;
      const icon = rankAsset(player, game, emojis);
      const update = rankUpdates.get(player.puuid);
      const rankUpdate =
        update?.delta !== undefined
          ? `${update.delta >= 0 ? "+" : ""}${update.delta} ${update.unit}${update.current ? ` (${update.current})` : ""}`
          : update?.current;
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

const httpUrl = (url: string) =>
  url.startsWith("https:") || url.startsWith("http:") ? url : "";

// Discord's media proxy needs a real image file. Renderers without an
// extension (cdn.communitydragon.org/.../square) become a broken blur tile.
const renderableImageUrl = (url: string) => {
  const href = httpUrl(url);
  if (!href) return "";
  try {
    return /\.(png|jpe?g|webp|gif)$/i.test(new URL(href).pathname) ? href : "";
  } catch {
    return "";
  }
};

export const gameLogosFrom = (
  adapters: ReadonlyArray<{
    readonly game: GameId;
    readonly logoUrl: string;
  }>,
): GameLogos =>
  Object.fromEntries(
    adapters.flatMap((adapter) => {
      const url = renderableImageUrl(adapter.logoUrl);
      return url ? [[adapter.game, url] as const] : [];
    }),
  );

// posted by notifyMatch and admin report-mock. Components V2 so the
// scoreboard can use layout and images instead of a classic embed.
export const matchReportMessage = (
  report: MatchReport,
  rankEmojis: RankEmojis,
  gameLogos: GameLogos = {},
) => {
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
  const subtitle = [
    gameNames[report.match.game],
    report.match.mode,
    report.match.map,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  const thumbnailUrl = renderableImageUrl(gameLogos[report.match.game] ?? "");
  const header = thumbnailUrl
    ? [
        UI.section({
          components: [
            UI.textDisplay(`# ${verdict}`),
            UI.textDisplay(`**${subtitle}**`),
          ],
          accessory: UI.thumbnail({
            url: thumbnailUrl,
            description: gameNames[report.match.game],
          }),
        }),
      ]
    : [UI.textDisplay(`# ${verdict}`), UI.textDisplay(`**${subtitle}**`)];
  const boards = teams.map((players) =>
    UI.textDisplay(
      leaderboard(
        players,
        trackedPuuids,
        report.match.game,
        rankEmojis,
        report.rankUpdates,
      ),
    ),
  );
  const teamBlocks = boards.flatMap((board, index) =>
    index === 0
      ? [board]
      : [
          UI.seperator({
            divider: true,
            spacing: Discord.MessageComponentSeparatorSpacingSize.SMALL,
          }),
          board,
        ],
  );

  // No Media Gallery. Discord stores a blurhash placeholder per item, and a
  // 10-image gallery (especially 1024px Valorant icons, or a forwarded V2
  // message) paints as one large blue/purple blur block under the scoreboard.
  return UI.components([
    UI.container({
      accent_color: color,
      components: [
        ...header,
        UI.textDisplay(`${nameList(report.discordNames)} just finished a game`),
        ...(info.length > 0 ? [UI.textDisplay(info.join(" · "))] : []),
        UI.seperator({
          divider: true,
          spacing: Discord.MessageComponentSeparatorSpacingSize.LARGE,
        }),
        ...teamBlocks,
      ],
    }),
  ]);
};
