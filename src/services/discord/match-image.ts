import { Effect, Schema } from "effect";
import sharp from "sharp";
import type {
  MatchPlayerIdentity,
  PlacementMatch,
  Puuid,
  RankUpdate,
  VersusMatch,
} from "../game/index.ts";
import type { MatchReport } from "./embed.ts";

const WIDTH = 760;
const ROW_HEIGHT = 54;
const HEADER_HEIGHT = 42;
const TEAM_HEADER_HEIGHT = 30;
const PADDING = 12;

export class MatchImageError extends Schema.TaggedError<MatchImageError>()(
  "MatchImageError",
  { cause: Schema.Defect() },
) {}

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const truncate = (value: string, length: number) => {
  const characters = Array.from(value);
  return characters.length > length
    ? `${characters.slice(0, length - 1).join("")}…`
    : value;
};

const rankText = (
  player: MatchPlayerIdentity,
  updates: ReadonlyMap<Puuid, RankUpdate>,
) => {
  const update = updates.get(player.puuid);
  if (update?.delta !== undefined) {
    return `${update.delta >= 0 ? "+" : ""}${update.delta} ${update.unit}`;
  }
  return update?.current ?? player.rank ?? "—";
};

const text = (
  value: string,
  x: number,
  y: number,
  options?: {
    readonly bold?: boolean;
    readonly color?: string;
    readonly size?: number;
  },
) =>
  `<text x="${x}" y="${y}" dominant-baseline="middle" fill="${options?.color ?? "#f2f3f5"}" font-size="${options?.size ?? 30}" font-weight="${options?.bold ? 700 : 500}">${escapeXml(value)}</text>`;

const columnHeader = (value: string, x: number) =>
  `<text x="${x}" y="${HEADER_HEIGHT / 2}" dominant-baseline="middle" fill="#b5bac1" font-size="18" font-weight="700" letter-spacing="1">${escapeXml(value)}</text>`;

const detailLines = (value: string) => {
  const [first = "", ...rest] = value.split(" · ");
  return [first, rest.join(" · ") || " "] as const;
};

const versusBoard = (
  report: MatchReport & { readonly match: VersusMatch },
  trackedPuuids: ReadonlySet<Puuid>,
) => {
  const groups = report.match.teams
    .map((team) => ({
      team,
      players: report.match.players
        .filter((player) => player.team === team.id)
        .sort((a, b) => b.sortKey - a.sortKey),
    }))
    .filter(({ players }) => players.length > 0);
  const height =
    HEADER_HEIGHT +
    groups.reduce(
      (total, group) =>
        total + TEAM_HEADER_HEIGHT + group.players.length * ROW_HEIGHT,
      0,
    ) +
    PADDING;
  let y = HEADER_HEIGHT;
  const body = groups
    .map(({ team, players }) => {
      const accent =
        team.won === true
          ? "#57f287"
          : team.won === false
            ? "#ed4245"
            : "#949ba4";
      const label =
        team.won === true
          ? "WINNING TEAM"
          : team.won === false
            ? "LOSING TEAM"
            : "TEAM";
      const teamY = y;
      y += TEAM_HEADER_HEIGHT;
      const rows = players
        .map((player, index) => {
          const rowY = y;
          const middle = rowY + ROW_HEIGHT / 2;
          const tracked = trackedPuuids.has(player.puuid);
          y += ROW_HEIGHT;
          return [
            `<rect x="${PADDING}" y="${rowY}" width="${WIDTH - PADDING * 2}" height="${ROW_HEIGHT}" rx="8" fill="${tracked ? "#343842" : index % 2 === 0 ? "#27292d" : "#232428"}"/>`,
            ...(tracked
              ? [
                  `<rect x="${PADDING}" y="${rowY}" width="5" height="${ROW_HEIGHT}" rx="2.5" fill="#fee75c"/>`,
                ]
              : []),
            text(
              truncate(`${player.riotName}#${player.riotTag}`, 18),
              24,
              middle - 11,
              {
                bold: tracked,
                size: 28,
              },
            ),
            text(truncate(player.character, 18), 24, middle + 16, {
              color: "#b5bac1",
              size: 20,
            }),
            text(
              `${player.kills}/${player.deaths}/${player.assists}`,
              285,
              middle,
            ),
            text(truncate(detailLines(player.stat)[0], 17), 390, middle - 11, {
              size: 25,
            }),
            text(truncate(detailLines(player.stat)[1], 17), 390, middle + 16, {
              color: "#b5bac1",
              size: 21,
            }),
            text(
              truncate(rankText(player, report.rankUpdates), 11),
              620,
              middle,
              {
                color: tracked ? "#fee75c" : "#dbdee1",
                size: 25,
              },
            ),
          ].join("");
        })
        .join("");
      return [
        `<rect x="${PADDING}" y="${teamY + 8}" width="5" height="${TEAM_HEADER_HEIGHT - 12}" rx="2.5" fill="${accent}"/>`,
        `<text x="24" y="${teamY + TEAM_HEADER_HEIGHT / 2 + 2}" dominant-baseline="middle" fill="${accent}" font-size="16" font-weight="800" letter-spacing="1">${label}</text>`,
        rows,
      ].join("");
    })
    .join("");

  return {
    height,
    body: [
      columnHeader("PLAYER", 24),
      columnHeader("K / D / A", 285),
      columnHeader("PERFORMANCE", 390),
      columnHeader("RANK", 620),
      body,
    ].join(""),
  };
};

const placementBoard = (
  report: MatchReport & { readonly match: PlacementMatch },
  trackedPuuids: ReadonlySet<Puuid>,
) => {
  const players = [...report.match.players].sort(
    (a, b) => a.placement - b.placement,
  );
  const height = HEADER_HEIGHT + players.length * ROW_HEIGHT + PADDING;
  const body = players
    .map((player, index) => {
      const rowY = HEADER_HEIGHT + index * ROW_HEIGHT;
      const middle = rowY + ROW_HEIGHT / 2;
      const tracked = trackedPuuids.has(player.puuid);
      return [
        `<rect x="${PADDING}" y="${rowY}" width="${WIDTH - PADDING * 2}" height="${ROW_HEIGHT}" rx="8" fill="${tracked ? "#343842" : index % 2 === 0 ? "#27292d" : "#232428"}"/>`,
        ...(tracked
          ? [
              `<rect x="${PADDING}" y="${rowY}" width="5" height="${ROW_HEIGHT}" rx="2.5" fill="#fee75c"/>`,
            ]
          : []),
        text(truncate(`${player.riotName}#${player.riotTag}`, 20), 24, middle, {
          bold: tracked,
          size: 28,
        }),
        text(`#${player.placement}`, 310, middle, {
          bold: true,
          color: player.placement <= 4 ? "#57f287" : "#ed4245",
        }),
        text(truncate(detailLines(player.stat)[0], 17), 400, middle - 11, {
          size: 25,
        }),
        text(truncate(detailLines(player.stat)[1], 17), 400, middle + 16, {
          color: "#b5bac1",
          size: 21,
        }),
        text(truncate(rankText(player, report.rankUpdates), 11), 625, middle, {
          color: tracked ? "#fee75c" : "#dbdee1",
          size: 25,
        }),
      ].join("");
    })
    .join("");

  return {
    height,
    body: [
      columnHeader("PLAYER", 24),
      columnHeader("PLACE", 310),
      columnHeader("PERFORMANCE", 400),
      columnHeader("RANK", 625),
      body,
    ].join(""),
  };
};

export const renderMatchImage = Effect.fn("Discord.renderMatchImage")(
  function* (report: MatchReport) {
    const trackedPuuids = new Set(report.trackedPuuids);
    const board =
      report.match.kind === "versus"
        ? versusBoard({ ...report, match: report.match }, trackedPuuids)
        : placementBoard({ ...report, match: report.match }, trackedPuuids);
    const svg = Buffer.from(`
      <svg width="${WIDTH}" height="${board.height}" viewBox="0 0 ${WIDTH} ${board.height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${WIDTH}" height="${board.height}" rx="14" fill="#1e1f22"/>
        <rect x="${PADDING}" y="0" width="${WIDTH - PADDING * 2}" height="${HEADER_HEIGHT}" rx="8" fill="#2b2d31"/>
        <g font-family="Arial, Helvetica, sans-serif">${board.body}</g>
      </svg>
    `);

    return yield* Effect.tryPromise({
      try: () => sharp(svg).png({ compressionLevel: 9 }).toBuffer(),
      catch: (cause) => new MatchImageError({ cause }),
    });
  },
);
