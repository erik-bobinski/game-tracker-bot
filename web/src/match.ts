// One reported match, drawn from its data rather than the Discord card's
// image, so every name and number is text: selectable, searchable, linkable.
// The feed lists each as a one-line summary; opening it shows the whole
// lobby, with the tracked friends marked. Verdicts and wording come from the
// same helpers the Discord report uses.

import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import { Html as HtmlComponent } from "@effect/ui/html";
import { Dialog } from "@effect/ui-kit";
import { Match, Schema } from "effect";
import {
  formatDuration,
  matchVerdict,
  ordinal,
  placementHalves,
  placementVerdict,
  playerName,
  teamLabel,
} from "../../src/services/discord/embed.ts";
import type {
  MatchPlayerIdentity,
  MatchTeam,
  PlacementMatch,
  RankUpdate,
  VersusMatch,
} from "../../src/services/game/index.ts";
import { FeedMatch, Game } from "../../src/services/web/api.ts";
import { CloseIcon } from "./icons.ts";

type Game = typeof Game.Type;
type Friend = FeedMatch["players"][number];
type Outcome = "win" | "loss" | "draw" | "unknown";

const MatchRowMessage = UiSchema.TaggedEnum({
  RequestedOpenReport: {},
  RequestedCloseReport: {},
  ClickedFriend: { discordUserId: Schema.String },
});
type MatchRowMessage = typeof MatchRowMessage.Type;
type H = Html.H<MatchRowMessage>;

const MatchRowEvents = UiSchema.TaggedEnum({
  PickedPlayer: { discordUserId: Schema.String },
});

const tone = {
  win: "text-win",
  loss: "text-loss",
  draw: "text-draw",
  unknown: "text-muted",
} as const satisfies Record<Outcome, string>;

// the embed's left bar, as Discord colours a report's
const bar = {
  win: "border-win",
  loss: "border-loss",
  draw: "border-draw",
  unknown: "border-faint",
} as const satisfies Record<Outcome, string>;

const teamOutcome = (team: MatchTeam): Outcome =>
  team.won === undefined ? "draw" : team.won ? "win" : "loss";

const teamWords = { win: "won", loss: "lost", draw: "drew", unknown: "" };

const clock = new Intl.DateTimeFormat("en", {
  hour: "numeric",
  minute: "2-digit",
});
const calendar = new Intl.DateTimeFormat("en", { dateStyle: "short" });
const fullDate = new Intl.DateTimeFormat("en", {
  dateStyle: "full",
  timeStyle: "short",
});

// when it was played, the way Discord stamps a message: "Today at 9:41 PM",
// or on a phone just "9:41 PM", "Yesterday" or the date
const stamp = (date: number, short: boolean) => {
  const startOfDay = (at: Date) =>
    new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const daysAgo = Math.round(
    (startOfDay(new Date()) - startOfDay(new Date(date))) / 86_400_000,
  );
  const time = clock.format(date);
  return Match.value(daysAgo).pipe(
    Match.when(0, () => (short ? time : `Today at ${time}`)),
    Match.when(1, () => (short ? "Yesterday" : `Yesterday at ${time}`)),
    Match.orElse(() =>
      short ? calendar.format(date) : `${calendar.format(date)} ${time}`,
    ),
  );
};

const Portrait = (h: H, src: string | undefined, name: string) =>
  src
    ? h.img
        .attrs({ src, alt: "", loading: "lazy" })
        .class("size-8 rounded-full bg-raised")
    : h.span
        .attr("aria-hidden", "true")
        .class(
          "grid size-8 place-items-center rounded-full bg-raised text-xs font-bold text-muted",
        )
        .children(name.charAt(0).toUpperCase());

const Rank = (
  h: H,
  options: {
    readonly player: MatchPlayerIdentity;
    readonly update: RankUpdate | null;
    readonly game: Game | undefined;
    // whether anyone in the match has a rank, as only then is "Unranked" news
    readonly ranked: boolean;
  },
) => {
  const { player, update, game, ranked } = options;
  const change = update?.tierChange;
  const iconFor = (key: string | undefined) =>
    game?.rankIcons.find((rank) => rank.key === key)?.url;
  const icon = iconFor(change?.to.iconKey ?? player.rankIconKey);
  const label = change ? change.to.tier : player.rank;
  const delta = update?.delta;
  if (!label && delta === undefined)
    return ranked ? h.span.children("Unranked") : null;
  const changeTone = change?.promoted ? "text-win" : "text-loss";
  const previousIcon = iconFor(change?.from.iconKey);
  return h.span.class("flex items-center gap-1.5").children(
    // a new tier reads as the card draws it: old emblem › new one
    change &&
      h.span.class("flex items-center gap-1").children(
        previousIcon
          ? h.img
              .attrs({
                src: previousIcon,
                alt: change.from.tier,
                title: change.from.tier,
                loading: "lazy",
              })
              .class("size-4")
          : h.span.children(change.from.tier),
        h.span
          .attr("aria-hidden", "true")
          .class(`font-bold ${changeTone}`)
          .children("›"),
      ),
    icon &&
      h.img.attrs({ src: icon, alt: "", loading: "lazy" }).class("size-4"),
    label &&
      h.span
        .class(change ? `font-bold ${changeTone}` : "text-ink")
        .children(label),
    delta !== undefined &&
      update &&
      h.span
        .class(delta > 0 ? "text-win" : delta < 0 ? "text-loss" : "text-muted")
        .children(
          `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta)} ${update.unit}`,
        ),
  );
};

// the badges beside a name, in the card's order: a new tier, flairs, MVP.
// promoted is set when the match moved them into another tier.
const Flairs = (
  h: H,
  flairs: ReadonlyArray<string>,
  mvp: boolean,
  promoted: boolean | undefined,
) => [
  promoted !== undefined &&
    h.span
      .class(
        `shrink-0 rounded-sm px-1 text-[11px] font-bold text-rail ${promoted ? "bg-win" : "bg-loss"}`,
      )
      .children(promoted ? "RANK UP" : "DERANK"),
  mvp &&
    h.span
      .class(
        "shrink-0 rounded-sm bg-accent px-1 text-[11px] font-bold text-rail",
      )
      .children("MVP"),
  ...flairs.map((flair) =>
    h.span
      .key(flair)
      .class("shrink-0 rounded-sm bg-raised px-1 text-[11px] font-bold")
      .children(flair),
  ),
];

// one player's line in the scoreboard; a tracked friend is marked in the
// accent colour and their discord name filters the feed to them
const PlayerRow = (
  h: H,
  options: {
    readonly player: MatchPlayerIdentity;
    readonly friend: Friend | undefined;
    readonly portrait: {
      readonly src: string | undefined;
      readonly name: string;
    };
    readonly mvp: boolean;
    readonly result: string;
    readonly resultTone: string;
    readonly game: Game | undefined;
    readonly ranked: boolean;
  },
) => {
  const { player, friend, portrait, mvp, result, resultTone, game, ranked } =
    options;
  return h.li
    .key(player.puuid)
    .class(
      `grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-2 border-l-2 sm:gap-x-3 py-1.5 pr-2 pl-2 ${friend ? "border-accent bg-accent/10" : "border-transparent"}`,
    )
    .children(
      Portrait(h, portrait.src, portrait.name),
      h.div.class("min-w-0").children(
        h.p
          .class("flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5")
          .children(
            h.span
              .class(
                `truncate text-sm font-bold ${friend ? "text-accent" : ""}`,
              )
              .children(playerName(player)),
            Flairs(
              h,
              player.flairs ?? [],
              mvp,
              friend?.rankUpdate?.tierChange?.promoted,
            ),
          ),
        h.div
          .class("flex flex-wrap items-center gap-x-3 text-xs text-muted")
          .children(
            friend &&
              h.button
                .attrs({
                  type: "button",
                  title: `Show only ${friend.discordName}'s matches`,
                })
                .class(
                  "rounded-sm px-0.5 text-accent hover:bg-accent hover:text-rail",
                )
                .on(
                  "click",
                  MatchRowMessage.ClickedFriend({
                    discordUserId: friend.discordUserId,
                  }),
                )
                .children(`@${friend.discordName}`),
            Rank(h, {
              player,
              update: friend?.rankUpdate ?? null,
              game,
              ranked,
            }),
          ),
      ),
      h.div
        .class("text-right")
        .children(
          h.p
            .class(`text-sm font-bold tabular-nums ${resultTone}`)
            .children(result),
          player.stat &&
            h.p
              .class("hidden text-[11px] whitespace-nowrap text-muted sm:block")
              .children(player.stat),
        ),
    );
};

const Time = (h: H, at: number, short: boolean) =>
  h.time
    .attrs({ datetime: new Date(at).toISOString(), title: fullDate.format(at) })
    .children(
      short && h.span.class("sm:hidden").children(stamp(at, true)),
      h.span.class(short ? "hidden sm:inline" : "").children(stamp(at, false)),
    );

// what a match's summary and its full report both lead with, and the lobby
// only the full report shows
const versusReport = (
  h: H,
  entry: FeedMatch,
  match: VersusMatch,
  game: Game | undefined,
) => {
  const { key, verdict, trackedTeam, teams } = matchVerdict({
    tracked: entry.players,
    match,
    rankUpdates: new Map(),
  });
  const friends = new Map(
    entry.players.map((friend) => [friend.puuid, friend]),
  );
  const mvp = [...match.players].sort((a, b) => b.sortKey - a.sortKey)[0]
    ?.puuid;
  const kda = (player: VersusMatch["players"][number]) =>
    `${player.kills}/${player.deaths}/${player.assists}`;
  return {
    outcome: key,
    label: verdict.label,
    score: trackedTeam?.score,
    details: [
      match.map ? `${match.mode} on ${match.map}` : match.mode,
      formatDuration(match.durationSeconds),
      match.surrendered ? "ended by surrender" : undefined,
    ],
    friends: match.players.flatMap((player) => {
      const friend = friends.get(player.puuid);
      return friend
        ? [
            {
              friend,
              portrait: player.characterIconUrl,
              result: kda(player),
              resultTone: "",
            },
          ]
        : [];
    }),
    lobby: () =>
      h.div.class("grid gap-6 md:grid-cols-2").children(
        teams.map((team, index) => {
          const players = match.players.filter((p) => p.team === team.id);
          const outcome = teamOutcome(team);
          return h.section
            .key(String(team.id))
            .attr("aria-label", teamLabel(index))
            .children(
              h.h3
                .class("mb-1 border-b border-line pb-1 text-xs")
                .children(
                  h.span.class("font-bold").children(teamLabel(index)),
                  " ",
                  h.span.class(tone[outcome]).children(teamWords[outcome]),
                  h.span
                    .class("text-muted")
                    .children(
                      `, ${players.reduce((kills, p) => kills + p.kills, 0)} kills`,
                    ),
                ),
              h.ul.children(
                players.map((player) =>
                  PlayerRow(h, {
                    player,
                    friend: friends.get(player.puuid),
                    portrait: {
                      src: player.characterIconUrl,
                      name: player.character,
                    },
                    mvp: player.puuid === mvp,
                    result: kda(player),
                    resultTone: "",
                    game,
                    ranked: match.players.some((p) => p.rank),
                  }),
                ),
              ),
            );
        }),
      ),
  };
};

const placementReport = (
  h: H,
  entry: FeedMatch,
  match: PlacementMatch,
  game: Game | undefined,
) => {
  const { key, trackedPuuids } = placementVerdict({
    tracked: entry.players,
    match,
    rankUpdates: new Map(),
  });
  const friends = new Map(
    entry.players.map((friend) => [friend.puuid, friend]),
  );
  const byPlacement = [...match.players].sort(
    (a, b) => a.placement - b.placement,
  );
  // every friend's place, best first: "1st", or "1st and 4th"
  const places = byPlacement
    .filter((p) => trackedPuuids.has(p.puuid))
    .map((p) => ordinal(p.placement));
  const placeTone = (won: boolean) => (won ? "text-win" : "text-muted");
  return {
    outcome: key,
    label:
      places.length > 1
        ? `${places.slice(0, -1).join(", ")} and ${places.at(-1)}`
        : `${places[0] ?? "Match"} place`,
    score: undefined,
    details: [match.mode, formatDuration(match.durationSeconds)],
    friends: byPlacement.flatMap((player) => {
      const friend = friends.get(player.puuid);
      return friend
        ? [
            {
              friend,
              portrait: player.characterIconUrl,
              result: ordinal(player.placement),
              resultTone: placeTone(player.won),
            },
          ]
        : [];
    }),
    // the lobby as the card halves it, each team its own block
    lobby: () => {
      const { halves, teams } = placementHalves(match.players);
      return h.div.class("grid gap-6 md:grid-cols-2").children(
        halves.map((half, index) => {
          const title = `${index === 0 ? "Top" : "Bottom"} ${half.places}${teams ? " teams" : ""}`;
          return h.section
            .key(title)
            .attr("aria-label", title)
            .children(
              h.h3
                .class("mb-1 border-b border-line pb-1 text-xs font-bold")
                .children(title),
              [...new Set(half.players.map((p) => p.placement))].map((place) =>
                h.ul
                  .key(String(place))
                  .class(teams ? "mb-2" : "")
                  .children(
                    half.players
                      .filter((player) => player.placement === place)
                      .map((player) =>
                        PlayerRow(h, {
                          player,
                          friend: friends.get(player.puuid),
                          portrait: {
                            src: player.characterIconUrl,
                            name:
                              player.character ??
                              friends.get(player.puuid)?.discordName ??
                              playerName(player),
                          },
                          mvp: false,
                          result: ordinal(player.placement),
                          resultTone: placeTone(player.won),
                          game,
                          ranked: match.players.some((p) => p.rank),
                        }),
                      ),
                  ),
              ),
            );
        }),
      );
    },
  };
};

// a match's line in the feed, opening its full report in a big dialog over
// the feed; escape, the close button or a click outside closes it
export const MatchRow = HtmlComponent.component({
  name: "MatchRow",
  props: Schema.Struct({ entry: FeedMatch, game: Schema.optional(Game) }),
  model: Schema.Struct({ open: Schema.Boolean }),
  message: MatchRowMessage,
  events: MatchRowEvents,
  restore: false,
}).make({
  init: () => ({ open: false }),
  update: {
    RequestedOpenReport: ($) => $.evolve({ open: true }),
    RequestedCloseReport: ($) => $.evolve({ open: false }),
    ClickedFriend: ($, { discordUserId }) =>
      $.emit(MatchRowEvents.PickedPlayer({ discordUserId })),
  },
  view: (h, model) => {
    const { entry, game } = h.props;
    const report =
      entry.match.kind === "versus"
        ? versusReport(h, entry, entry.match, game)
        : placementReport(h, entry, entry.match, game);
    const { outcome, label, score, details, friends } = report;
    const verdict = [
      h.span.class(tone[outcome]).children(label),
      score && h.span.class("tabular-nums").children(`${score[0]}–${score[1]}`),
    ];
    return Dialog(h, {
      props: { open: model.open },
      onEmit: {
        RequestedOpen: () => MatchRowMessage.RequestedOpenReport(),
        RequestedClose: () => MatchRowMessage.RequestedCloseReport(),
        Settled: () => undefined,
      },
      view: (dialog) =>
        // the feed's line: game, verdict and score, where it was played, how
        // the friends did and when. The whole line opens the full report.
        h.article
          .class(
            `relative flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded border-l-4 bg-embed px-3 py-2.5 hover:bg-raised md:flex-nowrap ${bar[outcome]}`,
          )
          .children(
            game &&
              h.img
                .attrs({ src: game.iconUrl, alt: game.name, title: game.name })
                .class("size-7 shrink-0 rounded-full"),
            // the headline keeps its line; a crowded lobby's friends wrap
            h.div
              .class("min-w-0 flex-1 md:min-w-56")
              .children(
                h.h2
                  .class("text-sm font-extrabold")
                  .children(
                    dialog
                      .trigger(h.button)
                      .attr("type", "button")
                      .class(
                        "text-left whitespace-nowrap after:absolute after:inset-0 after:rounded [&>span+span]:ml-2",
                      )
                      .children(verdict),
                  ),
                h.p
                  .class("truncate text-xs text-muted")
                  .children(details.filter(Boolean).join(" · ")),
              ),
            h.div
              .class(
                "flex basis-full items-center justify-between gap-x-4 pl-11 md:basis-auto md:pl-0",
              )
              .children(
                h.ul
                  .class("flex flex-wrap gap-x-4 gap-y-1 md:justify-end")
                  .children(
                    friends.map(({ friend, portrait, result, resultTone }) =>
                      h.li
                        .key(friend.discordUserId)
                        .class("flex items-center gap-1.5 text-xs")
                        .children(
                          portrait &&
                            h.img
                              .attrs({
                                src: portrait,
                                alt: "",
                                loading: "lazy",
                              })
                              .class("size-5 rounded-full bg-raised"),
                          h.span
                            .class("max-w-28 truncate text-accent")
                            .children(friend.discordName),
                          h.span
                            .class(`font-bold tabular-nums ${resultTone}`)
                            .children(result),
                        ),
                    ),
                  ),
                h.span
                  .class(
                    "shrink-0 text-right text-xs whitespace-nowrap text-faint md:w-44",
                  )
                  .children(Time(h, entry.playedAt, true)),
              ),
            // the full report, shaped like the Discord embed it was posted
            // as: the game as author, the verdict as title, the lobby as
            // fields, and when it was played in the footer
            dialog.portal(h.dialog)?.children(
              dialog.backdrop(h.div.class("fixed inset-0 bg-black/75")),
              dialog
                .viewport(
                  h.div.class("fixed inset-0 grid place-items-center p-4"),
                )
                .children(
                  dialog
                    .popup(
                      h.div.class(
                        "relative max-h-[calc(100dvh-2rem)] w-[min(72rem,calc(100vw-2rem))] overflow-y-auto rounded text-ink",
                      ),
                    )
                    .children(
                      dialog
                        .close(h.button)
                        .attrs({
                          type: "button",
                          title: "Close",
                          "aria-label": "Close",
                        })
                        .class(
                          "absolute top-3 right-3 size-8 rounded p-1.5 text-muted hover:bg-raised hover:text-ink",
                        )
                        .children(CloseIcon(h)),
                      h.article
                        .class(
                          `rounded border-l-4 bg-embed px-3 py-3 sm:px-5 sm:py-4 ${bar[outcome]}`,
                        )
                        .children(
                          h.p
                            .class("flex items-center gap-2 text-xs font-bold")
                            .children(
                              game &&
                                h.img
                                  .attrs({ src: game.iconUrl, alt: "" })
                                  .class("size-5 rounded-full"),
                              game?.name,
                            ),
                          dialog
                            .title(h.h2)
                            .class(
                              "mt-2 flex items-baseline gap-3 text-2xl font-extrabold sm:text-3xl",
                            )
                            .children(verdict),
                          h.p
                            .class("mt-1 text-sm text-muted")
                            .children(details.filter(Boolean).join(", ")),
                          h.div.class("mt-4").children(report.lobby()),
                          h.footer
                            .class("mt-3 text-xs text-muted")
                            .children(Time(h, entry.playedAt, false)),
                        ),
                    ),
                ),
            ),
          ),
    });
  },
});
