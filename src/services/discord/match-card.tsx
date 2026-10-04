/** @jsxImportSource satori/jsx */
import { readFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
import {
  Cache,
  Duration,
  Effect,
  Encoding,
  Exit,
  Option,
  Schema,
} from "effect";
import type { DiscordREST } from "dfx";
import * as HttpClient from "effect/unstable/http/HttpClient";
import satori, { type Font } from "satori";
import type { JSXNode } from "satori/jsx";
import { gameNames } from "../game/index.ts";
import type {
  GameId,
  MatchPlayerIdentity,
  MatchTeam,
  PlacementPlayer,
  Puuid,
  RankUpdate,
} from "../game/index.ts";
import type { GameAdapter } from "../game/game-adapters/index.ts";
import {
  formatDuration,
  matchEmbed,
  matchSummary,
  matchVerdict,
  placementSummary,
  placementVerdict,
  teamLabel,
  type MatchReport,
  type PlacementReport,
  type RankEmojis,
  type VersusReport,
} from "./embed.ts";

export class MatchCardError extends Schema.TaggedError<MatchCardError>()(
  "MatchCardError",
  { cause: Schema.Defect() },
) {}

// Discord shows an inline image at most 550x350, so the card is laid out near
// that ratio with the teams side by side, then rasterised at SCALE so text
// stays sharp on high-density screens
const WIDTH = 640;
const PADDING = 12;
const GAP = 10;
const PANEL = (WIDTH - PADDING * 2 - GAP) / 2;
const SCALE = 2;

const colors = {
  card: "#16171b",
  row: "#1d1f24",
  tracked: "#272b35",
  text: "#f2f3f5",
  muted: "#9a9ea6",
  faint: "#5c5f66",
  gold: "#f0b232",
  up: "#3ba55d",
  down: "#ed4245",
} as const;

const verdictColors = {
  win: "#3ba55d",
  loss: "#ed4245",
  draw: "#f0b232",
  unknown: "#9a9ea6",
} as const;

const teamColor = (team: MatchTeam) =>
  team.won === true
    ? verdictColors.win
    : team.won === false
      ? verdictColors.loss
      : verdictColors.draw;

const fontFiles = [
  ["latin", 400],
  ["latin", 600],
  ["latin", 800],
  ["latin-ext", 400],
  ["latin-ext", 600],
  ["latin-ext", 800],
  ["cyrillic", 400],
  ["cyrillic", 600],
  ["greek", 400],
  ["greek", 600],
] as const;

// the Noto family google fonts serves for each script satori detects outside
// Inter, so korean or japanese riot ids render instead of empty boxes. Han
// text arrives as "ja-JP|zh-CN|zh-TW|zh-HK"; the first listed family wins, and
// simplified chinese covers the most shared han glyphs.
const notoFamilies = [
  ["zh-CN", "Noto Sans SC"],
  ["ja-JP", "Noto Sans JP"],
  ["ko-KR", "Noto Sans KR"],
  ["zh-TW", "Noto Sans TC"],
  ["zh-HK", "Noto Sans HK"],
  ["th-TH", "Noto Sans Thai"],
  ["ar-AR", "Noto Sans Arabic"],
  ["he-IL", "Noto Sans Hebrew"],
  ["bn-IN", "Noto Sans Bengali"],
  ["ta-IN", "Noto Sans Tamil"],
  ["te-IN", "Noto Sans Telugu"],
  ["ml-IN", "Noto Sans Malayalam"],
  ["unknown", "Noto Sans"],
] as const;

const rankDelta = (update: RankUpdate | undefined) =>
  update?.delta === undefined
    ? undefined
    : {
        text: `${update.delta > 0 ? "+" : update.delta < 0 ? "−" : "±"}${Math.abs(update.delta)} ${update.unit}`,
        color:
          update.delta > 0
            ? colors.up
            : update.delta < 0
              ? colors.down
              : colors.muted,
      };

const Badge = ({ label, color }: { label: string; color: string }) => (
  <div
    style={{
      display: "flex",
      marginLeft: 4,
      padding: "1px 5px",
      borderRadius: 4,
      backgroundColor: color,
      color: colors.card,
      fontSize: 8.5,
      fontWeight: 800,
      letterSpacing: 0.4,
    }}
  >
    {label.toUpperCase()}
  </div>
);

const Icon = ({
  src,
  size,
  alt,
}: {
  src?: string | undefined;
  size: number;
  alt: string;
}) =>
  src ? (
    <img src={src} width={size} height={size} style={{ borderRadius: 6 }} />
  ) : (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: 6,
        backgroundColor: colors.tracked,
        color: colors.muted,
        fontSize: 14,
        fontWeight: 800,
      }}
    >
      {alt.charAt(0).toUpperCase()}
    </div>
  );

interface CardImages {
  readonly game?: string | undefined;
  readonly characters: ReadonlyMap<Puuid, string>;
  readonly ranks: ReadonlyMap<Puuid, string>;
}

// Two lines per player: who and at what rank in the middle, how they played on
// the right. The portrait goes first, since players read it faster anyway.
const Row = ({
  player,
  report,
  images,
  tracked,
  mvp,
  portrait,
  headline,
  detail,
}: {
  player: MatchPlayerIdentity;
  report: MatchReport;
  images: CardImages;
  tracked: boolean;
  mvp?: boolean;
  portrait: JSXNode;
  headline: string;
  detail?: string;
}) => {
  const delta = rankDelta(report.rankUpdates.get(player.puuid));
  const rankIcon = images.ranks.get(player.puuid);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        position: "relative",
        height: 58,
        padding: "0 7px 0 5px",
        marginTop: 4,
        borderRadius: 6,
        backgroundColor: tracked ? colors.tracked : colors.row,
        borderLeft: `3px solid ${tracked ? colors.gold : colors.row}`,
      }}
    >
      {mvp || player.flair ? (
        <div
          style={{ display: "flex", position: "absolute", top: -5, right: 8 }}
        >
          {player.flair ? <Badge label={player.flair} color="#ff7a45" /> : null}
          {mvp ? <Badge label="MVP" color={colors.gold} /> : null}
        </div>
      ) : null}
      {portrait}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
          marginLeft: 7,
        }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: tracked ? 800 : 600,
            color: colors.text,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {player.riotName}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginTop: 3,
            fontSize: 11.5,
            color: player.rank ? colors.muted : colors.faint,
          }}
        >
          {rankIcon ? (
            <img
              src={rankIcon}
              width={15}
              height={15}
              style={{ marginRight: 3 }}
            />
          ) : null}
          <div style={{ flexShrink: 0 }}>{player.rank ?? "Unranked"}</div>
          {delta ? (
            <div
              style={{
                flexShrink: 0,
                marginLeft: 5,
                fontWeight: 600,
                color: delta.color,
              }}
            >
              {delta.text}
            </div>
          ) : null}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          flexShrink: 0,
          marginLeft: 6,
        }}
      >
        {headline ? (
          <div style={{ fontSize: 14, fontWeight: 800, color: colors.text }}>
            {headline}
          </div>
        ) : null}
        {detail ? (
          <div style={{ marginTop: 3, fontSize: 11.5, color: colors.muted }}>
            {detail}
          </div>
        ) : null}
      </div>
    </div>
  );
};

interface Column {
  readonly color: string;
  readonly label: string;
  readonly status?: string;
  readonly detail?: string;
  readonly rows: ReadonlyArray<JSXNode>;
}

// The verdict header over two side-by-side columns of player rows
const Card = ({
  accent,
  icon,
  game,
  label,
  details,
  score,
  columns,
}: {
  accent: string;
  icon: string | undefined;
  game: GameId;
  label: string;
  details: ReadonlyArray<string | undefined>;
  score?: readonly [number, number] | undefined;
  columns: ReadonlyArray<Column>;
}) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      width: WIDTH,
      padding: PADDING,
      borderRadius: 14,
      backgroundColor: colors.card,
      backgroundImage: `linear-gradient(180deg, ${accent}40 0%, ${colors.card} 90px)`,
      fontFamily: "Inter",
      color: colors.text,
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "0 4px 10px",
      }}
    >
      <Icon src={icon} size={40} alt={gameNames[game]} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          marginLeft: 11,
        }}
      >
        <div
          style={{
            fontSize: 24,
            fontWeight: 800,
            color: accent,
            letterSpacing: 1.5,
          }}
        >
          {label.toUpperCase()}
        </div>
        <div style={{ fontSize: 12, color: colors.muted, marginTop: 1 }}>
          {details.filter(Boolean).join("  ·  ")}
        </div>
      </div>
      {score ? (
        <div style={{ display: "flex", alignItems: "center", fontWeight: 800 }}>
          <div style={{ fontSize: 32, color: colors.text }}>
            {String(score[0])}
          </div>
          <div style={{ fontSize: 22, color: colors.faint, margin: "0 8px" }}>
            –
          </div>
          <div style={{ fontSize: 32, color: colors.muted }}>
            {String(score[1])}
          </div>
        </div>
      ) : null}
    </div>
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "space-between",
        rowGap: 10,
      }}
    >
      {columns.map((column) => (
        <div style={{ display: "flex", flexDirection: "column", width: PANEL }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "0 4px",
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 1,
            }}
          >
            <div
              style={{
                display: "flex",
                width: 3,
                height: 11,
                borderRadius: 2,
                backgroundColor: column.color,
                marginRight: 6,
              }}
            />
            <div style={{ color: colors.text }}>
              {column.label.toUpperCase()}
            </div>
            {column.status ? (
              <div style={{ marginLeft: 6, color: column.color }}>
                {column.status}
              </div>
            ) : null}
            {column.detail ? (
              <div style={{ marginLeft: 8, color: colors.faint }}>
                {column.detail}
              </div>
            ) : null}
          </div>
          {column.rows}
        </div>
      ))}
    </div>
  </div>
);

// Teams side by side with the tracked players' team first, each sorted by
// how well its players did
const versusCard = (report: VersusReport, images: CardImages) => {
  const { match } = report;
  const { key, verdict, trackedTeam, teams } = matchVerdict(report);
  const trackedPuuids = new Set(report.tracked.map((player) => player.puuid));
  const mvp = [...match.players].sort((a, b) => b.sortKey - a.sortKey)[0]
    ?.puuid;

  return (
    <Card
      accent={verdictColors[key]}
      icon={images.game}
      game={match.game}
      label={verdict.label}
      details={[
        match.mode,
        match.map,
        formatDuration(match.durationSeconds),
        match.surrendered ? "Surrender" : undefined,
      ]}
      score={trackedTeam?.score}
      columns={teams.flatMap((team, index) => {
        const players = match.players
          .filter((player) => player.team === team.id)
          .sort((a, b) => b.sortKey - a.sortKey);
        if (players.length === 0) return [];
        return [
          {
            color: teamColor(team),
            label: teamLabel(index),
            status:
              team.won === true ? "WIN" : team.won === false ? "LOSS" : "DRAW",
            detail: `${players.reduce((kills, player) => kills + player.kills, 0)} KILLS`,
            rows: players.map((player) => (
              <Row
                player={player}
                report={report}
                images={images}
                tracked={trackedPuuids.has(player.puuid)}
                mvp={player.puuid === mvp}
                portrait={
                  <Icon
                    src={images.characters.get(player.puuid)}
                    size={34}
                    alt={player.character}
                  />
                }
                headline={`${player.kills} / ${player.deaths} / ${player.assists}`}
                detail={player.stat}
              />
            )),
          },
        ];
      })}
    />
  );
};

// The lobby in finishing order, top half on the left, with each player's
// placement where a versus card shows their character
const placementCard = (report: PlacementReport, images: CardImages) => {
  const { match } = report;
  const { key, label, trackedPuuids } = placementVerdict(report);
  const players = [...match.players].sort((a, b) => a.placement - b.placement);
  const half = Math.ceil(players.length / 2);
  const column = (
    title: string,
    color: string,
    group: ReadonlyArray<PlacementPlayer>,
  ) => ({
    label: title,
    color,
    rows: group.map((player) => {
      const tint = player.placement === 1 ? colors.gold : color;
      return (
        <Row
          player={player}
          report={report}
          images={images}
          tracked={trackedPuuids.has(player.puuid)}
          portrait={
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                width: 34,
                height: 34,
                borderRadius: 6,
                backgroundColor: `${tint}2e`,
                color: tint,
                fontSize: 18,
                fontWeight: 800,
              }}
            >
              {String(player.placement)}
            </div>
          }
          headline={player.stat}
        />
      );
    }),
  });

  return (
    <Card
      accent={verdictColors[key]}
      icon={images.game}
      game={match.game}
      label={label}
      details={[match.mode, formatDuration(match.durationSeconds)]}
      columns={[
        column(`Top ${half}`, colors.up, players.slice(0, half)),
        column(
          `Bottom ${players.length - half}`,
          colors.down,
          players.slice(half),
        ),
      ]}
    />
  );
};

// Renders a match report to a png scoreboard. Icons are fetched once and kept;
// one that fails to load is left out of the card rather than failing it.
export const makeMatchCard = Effect.fn("MatchCard.make")(function* (
  adapters: ReadonlyArray<GameAdapter>,
) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({ times: 2 }),
  );

  const fonts: Array<Font> = yield* Effect.forEach(
    fontFiles,
    ([subset, weight]) =>
      Effect.promise(() =>
        readFile(
          new URL(
            import.meta.resolve(
              `@fontsource/inter/files/inter-${subset}-${weight}-normal.woff`,
            ),
          ),
        ),
      ).pipe(
        Effect.map((data) => ({
          name: "Inter",
          data,
          weight,
          style: "normal" as const,
        })),
      ),
  );

  const images = yield* Cache.makeWith(
    (url: string) =>
      Effect.gen(function* () {
        const bytes = url.startsWith("file:")
          ? yield* Effect.tryPromise(() => readFile(new URL(url)))
          : new Uint8Array(yield* (yield* client.get(url)).arrayBuffer);
        return `data:image/png;base64,${Encoding.encodeBase64(bytes)}`;
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("match card icon unavailable", error).pipe(
            Effect.annotateLogs({ url }),
          ),
        ),
      ),
    {
      capacity: 1_024,
      // a missing icon is retried later instead of being cached for good
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? Duration.infinity : Duration.minutes(10),
    },
  );
  const image = (url: string | undefined): Effect.Effect<string | undefined> =>
    url === undefined
      ? Effect.undefined
      : Cache.get(images, url).pipe(Effect.orElseSucceed(() => undefined));

  // keyed by family and text, since google fonts serves only the glyphs asked for
  const scriptFonts = yield* Cache.makeWith(
    ({ family, text }: { readonly family: string; readonly text: string }) =>
      Effect.gen(function* () {
        const css = yield* (yield* client.get(
          "https://fonts.googleapis.com/css2",
          { urlParams: { family: `${family}:wght@700`, text } },
        )).text;
        const url = /url\((.+?)\) format\('(?:truetype|opentype)'\)/.exec(
          css,
        )?.[1];
        if (!url) {
          return yield* Effect.fail(new Error(`no ${family} font served`));
        }
        return yield* (yield* client.get(url)).arrayBuffer;
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("match card font unavailable", error).pipe(
            Effect.annotateLogs({ family, text }),
          ),
        ),
      ),
    {
      capacity: 256,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? Duration.infinity : Duration.minutes(10),
    },
  );

  const iconsByGame = new Map(
    adapters.map((adapter) => [
      adapter.game,
      {
        game: adapter.iconUrl,
        ranks: new Map(adapter.rankIcons.map((icon) => [icon.key, icon.url])),
      },
    ]),
  );

  return Effect.fn("MatchCard.render")(
    function* (report: MatchReport) {
      const { match } = report;
      const icons = iconsByGame.get(match.game);
      const perPlayer = <P extends MatchPlayerIdentity>(
        players: ReadonlyArray<P>,
        url: (player: P) => string | undefined,
      ) =>
        Effect.forEach(
          players,
          (player) =>
            image(url(player)).pipe(
              Effect.map((src) => [player.puuid, src] as const),
            ),
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map(
            (entries) =>
              new Map(
                entries.flatMap(([puuid, src]) =>
                  src ? [[puuid, src] as const] : [],
                ),
              ),
          ),
        );

      const { game, characters, ranks } = yield* Effect.all(
        {
          game: image(icons?.game),
          characters: perPlayer(
            match.kind === "versus" ? match.players : [],
            (player) => player.characterIconUrl,
          ),
          ranks: perPlayer(match.players, (player: MatchPlayerIdentity) =>
            player.rankIconKey
              ? icons?.ranks.get(player.rankIconKey)
              : undefined,
          ),
        },
        { concurrency: "unbounded" },
      );

      const images = { game, characters, ranks };
      const runPromise = Effect.runPromiseWith(yield* Effect.context());
      return yield* Effect.tryPromise(async () => {
        const svg = await satori(
          match.kind === "versus"
            ? versusCard({ ...report, match }, images)
            : placementCard({ ...report, match }, images),
          {
            width: WIDTH,
            fonts,
            loadAdditionalAsset: (code, text) => {
              const codes = code.split("|");
              const family = notoFamilies.find(([script]) =>
                codes.includes(script),
              )?.[1];
              if (!family) return Promise.resolve([]);
              return runPromise(
                Cache.get(scriptFonts, { family, text }).pipe(
                  Effect.map((data) => [
                    {
                      name: family,
                      data,
                      weight: 700 as const,
                      style: "normal" as const,
                    },
                  ]),
                  Effect.orElseSucceed(() => []),
                ),
              );
            },
          },
        );
        return new Uint8Array(
          new Resvg(svg, { fitTo: { mode: "zoom", value: SCALE } })
            .render()
            .asPng(),
        );
      });
    },
    Effect.mapError((cause) => new MatchCardError({ cause })),
  );
});

export type MatchCard = Effect.Success<ReturnType<typeof makeMatchCard>>;

// Posts a match as its card under a one-line summary. A card that fails to
// render falls back to the embed scoreboard so the match is still reported.
export const postMatchReport = Effect.fn("Discord.postMatchReport")(function* (
  {
    rest,
    channelId,
    card,
    rankEmojis,
  }: {
    readonly rest: DiscordREST["Service"];
    readonly channelId: string;
    readonly card: MatchCard;
    readonly rankEmojis: RankEmojis;
  },
  report: MatchReport,
) {
  const png = yield* card(report).pipe(
    Effect.tapError((error) =>
      Effect.logError("match card render failed; posting the embed", error),
    ),
    Effect.option,
  );
  if (Option.isNone(png)) {
    return yield* rest.createMessage(channelId, {
      embeds: [matchEmbed(report, rankEmojis)],
    });
  }
  const { match } = report;
  const filename = "match-report.png";
  return yield* rest
    .createMessage(channelId, {
      content:
        match.kind === "versus"
          ? matchSummary({ ...report, match })
          : placementSummary({ ...report, match }),
      attachments: [{ id: "0", filename }],
    })
    .pipe(
      rest.withFiles([new File([png.value], filename, { type: "image/png" })]),
    );
});
