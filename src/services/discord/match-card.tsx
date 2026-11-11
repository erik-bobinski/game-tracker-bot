/** @jsxImportSource satori/jsx */
import { Resvg } from "@resvg/resvg-js";
import {
  Cache,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
} from "effect";
import { Base64 } from "effect/encoding";
import type { DiscordREST } from "dfx";
import * as HttpClient from "effect/http/HttpClient";
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
import { GameAdapters } from "../game/game-adapters/index.ts";
import {
  formatDuration,
  matchEmbed,
  matchHighlights,
  matchSummary,
  matchVerdict,
  ordinal,
  placementVerdict,
  playerName,
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
// that ratio with two columns side by side, then rasterised at SCALE so text
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
  win: colors.up,
  loss: colors.down,
  draw: colors.gold,
  unknown: colors.muted,
} as const;

const teamColor = (team: MatchTeam) =>
  team.won === true
    ? verdictColors.win
    : team.won === false
      ? verdictColors.loss
      : verdictColors.draw;

const fontFiles = [
  "latin",
  "latin-ext",
  "cyrillic",
  "cyrillic-ext",
  "greek",
  "greek-ext",
  "vietnamese",
].flatMap((subset) =>
  ([400, 600, 800] as const).map((weight) => [subset, weight] as const),
);

// Inter draws latin, vietnamese, greek and cyrillic; every other script is
// drawn from the Noto family google fonts serves for it, with Noto Sans as the
// catch-all. Each family is fetched whole, never subset to the text at hand:
// satori keeps the first font it's given per family for the life of the
// process, so a subset would leave every later name in that script as boxes.
const notoFamilies = [
  [/\p{scx=Hira}|\p{scx=Kana}/u, "Noto Sans JP"],
  [/\p{scx=Han}/u, "Noto Sans SC"],
  [/\p{scx=Hangul}/u, "Noto Sans KR"],
  ...[
    "Arabic",
    "Armenian",
    "Bengali",
    "Devanagari",
    "Ethiopic",
    "Georgian",
    "Gujarati",
    "Gurmukhi",
    "Hebrew",
    "Kannada",
    "Khmer",
    "Lao",
    "Malayalam",
    "Myanmar",
    "Oriya",
    "Sinhala",
    "Tamil",
    "Telugu",
    "Thaana",
    "Thai",
  ].map(
    (script) =>
      [new RegExp(`\\p{scx=${script}}`, "u"), `Noto Sans ${script}`] as const,
  ),
  [
    /\p{Symbol}|\p{Math}/u,
    "Noto Sans Symbols",
    "Noto Sans Symbols 2",
    "Noto Sans Math",
  ],
  [/./u, "Noto Sans"],
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
      fontSize: 9.5,
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
  readonly previousRanks: ReadonlyMap<Puuid, string>;
}

const Row = ({
  player,
  name,
  report,
  images,
  tracked,
  mvp,
  portrait,
  headline,
  detail,
}: {
  player: MatchPlayerIdentity;
  name: string;
  report: MatchReport;
  images: CardImages;
  tracked: boolean;
  mvp?: boolean;
  portrait: JSXNode;
  headline: string;
  detail?: string;
}) => {
  // how their rank moved is told by their spotlight; the row only marks a step
  const change = report.rankUpdates.get(player.puuid)?.tierChange;
  const rankIcon = images.ranks.get(player.puuid);
  // a player shown without a name was left anonymous, not unranked
  const label =
    change?.to.tier ??
    player.rank ??
    (player.riotName && report.match.players.some((candidate) => candidate.rank)
      ? "Unranked"
      : undefined);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        position: "relative",
        height: 54,
        padding: "0 7px 0 5px",
        marginTop: 4,
        borderRadius: 6,
        backgroundColor: tracked ? colors.tracked : colors.row,
        borderLeft: `3px solid ${tracked ? colors.gold : colors.row}`,
      }}
    >
      {mvp || player.flairs?.length || change ? (
        <div
          style={{ display: "flex", position: "absolute", top: -5, right: 8 }}
        >
          {change ? (
            <Badge
              label={change.promoted ? "Rank up" : "Derank"}
              color={change.promoted ? colors.up : colors.down}
            />
          ) : null}
          {player.flairs?.map((flair) => (
            <Badge label={flair} color="#ff7a45" />
          ))}
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
          {name}
        </div>
        {label ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              marginTop: 2,
              fontSize: 13,
              color: player.rank ? colors.muted : colors.faint,
            }}
          >
            {rankIcon ? (
              <img
                src={rankIcon}
                width={16}
                height={16}
                style={{ marginRight: 4 }}
              />
            ) : null}
            <div style={{ flexShrink: 0 }}>{label}</div>
          </div>
        ) : null}
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
          <div style={{ marginTop: 2, fontSize: 13, color: colors.muted }}>
            {detail}
          </div>
        ) : null}
      </div>
    </div>
  );
};

// What the card leads with: a strip per tracked player saying how the game went
// for them and where it left their rank, at a size that still reads on a phone
const Spotlight = ({
  player,
  name,
  report,
  images,
  portrait,
  result,
  color,
  headline,
}: {
  player: MatchPlayerIdentity;
  name: string;
  report: MatchReport;
  images: CardImages;
  portrait: JSXNode;
  result: string;
  color: string;
  headline?: string;
}) => {
  const update = report.rankUpdates.get(player.puuid);
  const delta = rankDelta(update);
  const change = update?.tierChange;
  const rankIcon = images.ranks.get(player.puuid);
  const previousRankIcon = images.previousRanks.get(player.puuid);
  const label = change?.to.tier ?? update?.current ?? player.rank;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 44,
        padding: "0 10px 0 5px",
        marginBottom: 4,
        borderRadius: 6,
        backgroundColor: colors.tracked,
        borderLeft: `3px solid ${color}`,
        fontSize: 17,
        fontWeight: 800,
      }}
    >
      {portrait}
      <div
        style={{
          flexShrink: 1,
          minWidth: 0,
          marginLeft: 9,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {name}
      </div>
      <div style={{ flexShrink: 0, marginLeft: 10, color }}>{result}</div>
      {headline ? (
        <div style={{ flexShrink: 0, marginLeft: 10 }}>{headline}</div>
      ) : null}
      <div style={{ display: "flex", flexGrow: 1 }} />
      {label ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
            marginLeft: 10,
            fontSize: 14,
            fontWeight: 600,
            color: colors.muted,
          }}
        >
          {change ? (
            <div
              style={{ display: "flex", alignItems: "center", marginRight: 5 }}
            >
              {previousRankIcon ? (
                <img src={previousRankIcon} width={18} height={18} />
              ) : (
                <div>{change.from.tier}</div>
              )}
              <div
                style={{
                  marginLeft: 5,
                  color: change.promoted ? colors.up : colors.down,
                }}
              >
                ›
              </div>
            </div>
          ) : null}
          {rankIcon ? (
            <img
              src={rankIcon}
              width={18}
              height={18}
              style={{ marginRight: 5 }}
            />
          ) : null}
          <div>{label}</div>
        </div>
      ) : null}
      {delta ? (
        <div
          style={{
            flexShrink: 0,
            marginLeft: 8,
            fontSize: 15,
            color: delta.color,
          }}
        >
          {delta.text}
        </div>
      ) : null}
    </div>
  );
};

const placementTint = (player: PlacementPlayer) =>
  player.placement === 1 ? colors.gold : player.won ? colors.up : colors.down;

const PlacementTile = ({ player }: { player: PlacementPlayer }) => {
  const tint = placementTint(player);
  return (
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
  );
};

interface Column {
  readonly color: string;
  readonly label: string;
  readonly status?: string;
  readonly detail?: string;
  readonly rows: ReadonlyArray<JSXNode>;
}

const Card = ({
  accent,
  icon,
  game,
  label,
  details,
  score,
  spotlights,
  columns,
}: {
  accent: string;
  icon: string | undefined;
  game: GameId;
  label: string;
  details: ReadonlyArray<string | undefined>;
  score?: readonly [number, number] | undefined;
  spotlights: ReadonlyArray<JSXNode>;
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
            display: "flex",
            alignSelf: "flex-start",
            padding: "4px 10px",
            borderRadius: 6,
            backgroundColor: accent,
            color: colors.card,
            fontSize: 24,
            fontWeight: 800,
            letterSpacing: 1.5,
            whiteSpace: "nowrap",
          }}
        >
          {label.toUpperCase()}
        </div>
        <div style={{ fontSize: 13.5, color: colors.muted, marginTop: 2 }}>
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
    <div style={{ display: "flex", flexDirection: "column", marginBottom: 6 }}>
      {spotlights}
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
              fontSize: 11.5,
              fontWeight: 800,
              letterSpacing: 1,
            }}
          >
            <div
              style={{
                display: "flex",
                width: 3,
                height: 12,
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

const versusCard = (report: VersusReport, images: CardImages) => {
  const { match } = report;
  const { key, verdict, trackedTeam, teams, tracked } = matchVerdict(report);
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
      spotlights={tracked.flatMap(({ discordName, puuid, outcome }) => {
        const player = match.players.find(
          (candidate) => candidate.puuid === puuid,
        );
        return player
          ? [
              <Spotlight
                player={player}
                name={discordName}
                report={report}
                images={images}
                portrait={
                  <Icon
                    src={images.characters.get(puuid)}
                    size={34}
                    alt={player.character}
                  />
                }
                result={outcome === "unknown" ? "" : outcome.toUpperCase()}
                color={verdictColors[outcome]}
                headline={`${player.kills} / ${player.deaths} / ${player.assists}`}
              />,
            ]
          : [];
      })}
      columns={teams.flatMap((team, index) => {
        const players = match.players.filter(
          (player) => player.team === team.id,
        );
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
                name={playerName(player)}
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

const placementCard = (report: PlacementReport, images: CardImages) => {
  const { match } = report;
  const { key, label, trackedPuuids } = placementVerdict(report);
  const players = [...match.players].sort((a, b) => a.placement - b.placement);
  const half = Math.ceil(players.length / 2);
  const column = (title: string, group: ReadonlyArray<PlacementPlayer>) => ({
    label: title,
    color: group.every((player) => player.won) ? colors.up : colors.down,
    rows: group.map((player) => (
      <Row
        player={player}
        name={playerName(player)}
        report={report}
        images={images}
        tracked={trackedPuuids.has(player.puuid)}
        portrait={<PlacementTile player={player} />}
        headline={player.stat}
      />
    )),
  });

  return (
    <Card
      accent={verdictColors[key]}
      icon={images.game}
      game={match.game}
      label={label}
      details={[match.mode, match.map, formatDuration(match.durationSeconds)]}
      spotlights={report.tracked.flatMap(({ discordName, puuid }) => {
        const player = players.find((candidate) => candidate.puuid === puuid);
        return player
          ? [
              <Spotlight
                player={player}
                name={discordName}
                report={report}
                images={images}
                portrait={<PlacementTile player={player} />}
                result={`${ordinal(player.placement)} place`.toUpperCase()}
                color={placementTint(player)}
              />,
            ]
          : [];
      })}
      columns={[
        column(`Top ${half}`, players.slice(0, half)),
        column(`Bottom ${players.length - half}`, players.slice(half)),
      ]}
    />
  );
};

// Renders a match report to a png scoreboard. Icons are fetched once and kept;
// one that fails to load is left out of the card rather than failing it.
const make = Effect.gen(function* () {
  const { all: adapters } = yield* GameAdapters;
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({ times: 2 }),
  );

  const fonts: Array<Font> = yield* Effect.forEach(
    fontFiles,
    ([subset, weight]) =>
      Effect.promise(() =>
        Bun.file(
          new URL(
            import.meta.resolve(
              `@fontsource/inter/files/inter-${subset}-${weight}-normal.woff`,
            ),
          ),
        ).arrayBuffer(),
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
          ? yield* Effect.tryPromise(() => Bun.file(new URL(url)).bytes())
          : new Uint8Array(yield* (yield* client.get(url)).arrayBuffer);
        const type = url.endsWith(".svg") ? "image/svg+xml" : "image/png";
        return `data:${type};base64,${Base64.encode(bytes)}`;
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

  const stylesheet = (family: string) =>
    client
      .get("https://fonts.googleapis.com/css2", { urlParams: { family } })
      .pipe(Effect.flatMap((response) => response.text));
  const notoFonts = yield* Cache.makeWith(
    (family: string) =>
      Effect.gen(function* () {
        // bold to sit with Inter's heavy weights; google answers 400 for a
        // family without a bold cut
        const css = yield* stylesheet(`${family}:wght@700`).pipe(
          Effect.catchIf(
            (error) => error.response?.status === 400,
            () => stylesheet(family),
          ),
        );
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
            Effect.annotateLogs({ family }),
          ),
        ),
      ),
    {
      capacity: 64,
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

  const render = Effect.fn("MatchCard.render")(
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

      const rankIcon = (key: string | undefined) =>
        key ? icons?.ranks.get(key) : undefined;
      const tierChange = (player: MatchPlayerIdentity) =>
        report.rankUpdates.get(player.puuid)?.tierChange;
      const images = yield* Effect.all(
        {
          game: image(icons?.game),
          characters: perPlayer(
            match.kind === "versus" ? match.players : [],
            (player) => player.characterIconUrl,
          ),
          ranks: perPlayer(match.players, (player: MatchPlayerIdentity) =>
            rankIcon(tierChange(player)?.to.iconKey ?? player.rankIconKey),
          ),
          previousRanks: perPlayer(
            match.players,
            (player: MatchPlayerIdentity) =>
              rankIcon(tierChange(player)?.from.iconKey),
          ),
        },
        { concurrency: "unbounded" },
      );

      const runPromise = Effect.runPromiseWith(yield* Effect.context());
      return yield* Effect.tryPromise(async () => {
        const svg = await satori(
          match.kind === "versus"
            ? versusCard({ ...report, match }, images)
            : placementCard({ ...report, match }, images),
          {
            width: WIDTH,
            fonts,
            loadAdditionalAsset: (code, text) =>
              code === "emoji"
                ? runPromise(
                    // twemoji names its files by codepoint, dropping the
                    // variation selector unless the emoji is zero width joined
                    image(
                      `https://cdn.jsdelivr.net/gh/jdecked/twemoji@16.0.1/assets/svg/${Array.from(
                        text.includes("\u200d")
                          ? text
                          : text.replaceAll("\ufe0f", ""),
                        (char) => char.codePointAt(0)?.toString(16),
                      ).join("-")}.svg`,
                    ).pipe(Effect.map((src) => src ?? [])),
                  )
                : runPromise(
                    Effect.forEach(
                      notoFamilies.flatMap(([script, ...families]) =>
                        script.test(text) ? families : [],
                      ),
                      (family) =>
                        Cache.get(notoFonts, family).pipe(
                          Effect.map((data) => [
                            { name: family, data, style: "normal" as const },
                          ]),
                          Effect.orElseSucceed(() => []),
                        ),
                      { concurrency: "unbounded" },
                    ).pipe(Effect.map((fonts) => fonts.flat())),
                  ),
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

  return { render };
});

export class MatchCard extends Context.Service<
  MatchCard,
  Effect.Success<typeof make>
>()("app/MatchCard") {}

export const MatchCardLive = Layer.effect(MatchCard, make);

export const postMatchReport = Effect.fn("Discord.postMatchReport")(function* (
  {
    rest,
    channelId,
    card,
    rankEmojis,
  }: {
    readonly rest: DiscordREST["Service"];
    readonly channelId: string;
    readonly card: MatchCard["Service"];
    readonly rankEmojis: RankEmojis;
  },
  report: MatchReport,
) {
  const png = yield* card.render(report).pipe(
    Effect.tapError((error) =>
      Effect.logError("match card render failed; posting the embed", error),
    ),
    Effect.option,
  );
  if (Option.isNone(png)) {
    return yield* rest.createMessage(channelId, {
      embeds: [matchEmbed(report, rankEmojis)],
      allowed_mentions: { parse: [] },
    });
  }
  const filename = "match-report.png";
  return yield* rest
    .createMessage(channelId, {
      content: [matchSummary(report), ...matchHighlights(report)].join("\n"),
      allowed_mentions: { parse: [] },
      attachments: [{ id: "0", filename }],
    })
    .pipe(
      rest.withFiles([new File([png.value], filename, { type: "image/png" })]),
    );
});
