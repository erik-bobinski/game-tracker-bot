// The signed-in feed, laid out like the Discord it mirrors: servers in a rail,
// games as channels, tracked players as members, and the matches reported
// there in between, narrowed by the filters in the url.

import {
  Command,
  Component,
  type Query,
  Route,
  Router,
  UiSchema,
} from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Toggle, ToggleGroup } from "@effect/ui-kit";
import { Array as Arr, Layer, Match, Option, Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import { FeedFilters, type Me } from "../../src/services/web/api.ts";
import { CheckIcon, CloseIcon, GridIcon, SignOutIcon } from "./icons.ts";
import { MatchRow } from "./match.ts";
import { GetMe, ListFeed } from "./site.ts";

// the feed's filters live in the url, so a filtered view can be shared. The
// url carries them as params (?game=lol%2Ctft); a filter that doesn't
// decode is dropped from it.
export const AppRoute = Route.union({
  Feed: Route.make("/feed", { search: FeedFilters.fields }),
});
type Search = (typeof AppRoute.Type)["search"];
type Game = Me["games"][number];
type Player = Me["servers"][number]["players"][number];

const FeedMessage = UiSchema.TaggedEnum({
  ChangedRoute: { route: AppRoute },
  ToggledMember: { discordUserId: Schema.String },
  ClickedShowEveryone: {},
  ToggledOrder: { value: Schema.Array(Schema.String) },
  ClickedLoadMore: {},
  PickedMatchPlayer: { discordUserId: Schema.String },
});
type FeedMessage = typeof FeedMessage.Type;
type H = Html.H<FeedMessage>;

const feedUrl = (search: Search) => AppRoute.print(AppRoute.Feed({ search }));

// "Friday Night Ranked" -> "FNR", as Discord labels a server with no icon
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((word) => word.charAt(0))
    .join("")
    .slice(0, 3)
    .toUpperCase();

// a filter with this value added, or taken out if it's already there; an
// empty filter is no filter
const toggle = <A>(list: ReadonlyArray<A> | undefined, value: A) => {
  const next = list?.includes(value)
    ? list.filter((item) => item !== value)
    : [...(list ?? []), value];
  return next.length > 0 ? next : undefined;
};

// a game's logo, or the grid that stands for all of them
const GameMark = (h: H, game: Game | undefined, size: string) =>
  game
    ? h.img
        .attrs({ src: game.iconUrl, alt: "" })
        .class(`${size} shrink-0 rounded-full`)
    : GridIcon(h).class(`${size} shrink-0`);

const Avatar = (h: H, src: string) =>
  h.img.attrs({ src, alt: "" }).class("size-8 shrink-0 rounded-full bg-raised");

const SignOut = (h: H) =>
  h.form
    .attrs({ method: "post", action: "/auth/sign-out" })
    .children(
      h.button
        .attrs({ type: "submit", title: "Sign out", "aria-label": "Sign out" })
        .class(
          "flex items-center gap-2 rounded p-1.5 text-muted hover:bg-raised hover:text-ink",
        )
        .children(SignOutIcon(h).class("size-4")),
    );

// the servers, each a rail button: round until hovered or chosen, with
// Discord's white pill marking the chosen one
const ServerRail = (h: H, me: Me, search: Search) =>
  h.nav
    .attr("aria-label", "Servers")
    .class(
      "flex shrink-0 items-center gap-3 overflow-x-auto bg-rail px-3 py-3 lg:w-[72px] lg:flex-col lg:overflow-y-auto lg:px-0",
    )
    .children(
      [
        {
          key: "all",
          label: "All servers",
          guildId: undefined,
          mark: GridIcon(h).class("size-5"),
        },
        ...me.servers.map((server) => ({
          key: server.guildId,
          label: server.name,
          guildId: server.guildId,
          mark: server.iconUrl
            ? h.img
                .attrs({ src: server.iconUrl, alt: "" })
                .class("size-full object-cover")
            : initials(server.name),
        })),
      ].flatMap(({ key, label, guildId, mark }) => {
        const active = search.server === guildId;
        const item = h.a
          .key(key)
          .attrs({
            href: feedUrl({ ...search, server: guildId, player: undefined }),
            "aria-label": label,
            title: label,
            "aria-current": active ? "page" : undefined,
          })
          .class("group relative flex shrink-0 justify-center lg:w-full")
          .children(
            h.span
              .attr("aria-hidden", "true")
              .class(
                `absolute -bottom-2 h-1 rounded-t bg-ink transition-all lg:top-1/2 lg:bottom-auto lg:left-0 lg:h-auto lg:w-1 lg:-translate-y-1/2 lg:rounded-t-none lg:rounded-r ${active ? "w-8 lg:h-10" : "w-0 group-hover:w-4 lg:h-0 lg:group-hover:h-5"}`,
              ),
            h.span
              .class(
                `grid size-12 place-items-center overflow-hidden text-sm font-bold transition-all ${active ? "rounded-2xl bg-accent text-rail" : "rounded-full bg-raised text-ink group-hover:rounded-2xl group-hover:bg-accent group-hover:text-rail"}`,
              )
              .children(mark),
          );
        // a line between every server and each one
        return guildId === undefined
          ? [
              item,
              h.span
                .key("divider")
                .attr("aria-hidden", "true")
                .class("h-8 w-0.5 shrink-0 rounded bg-raised lg:h-0.5 lg:w-8"),
            ]
          : [item];
      }),
    );

// the games, listed where Discord lists a server's channels. Each one toggles
// in and out of the filter, so several can be shown at once.
const Channels = (h: H, me: Me, search: Search, serverName: string) =>
  h.aside.class("flex shrink-0 flex-col bg-sidebar lg:w-60").children(
    h.h1
      .class(
        "hidden h-12 items-center border-b border-rail px-4 text-sm font-bold lg:flex",
      )
      .children(serverName),
    h.nav
      .attr("aria-label", "Games")
      .class("flex gap-1 overflow-x-auto px-2 py-2 lg:flex-col lg:py-3")
      .children(
        h.p
          .class("hidden px-2 pb-1 text-xs font-bold text-muted lg:block")
          .children("Games"),
        [undefined, ...me.games].map((game) => {
          const selected = game
            ? (search.game?.includes(game.game) ?? false)
            : !search.game;
          return h.a
            .key(game?.game ?? "all")
            .attr(
              "href",
              feedUrl({
                ...search,
                game: game && toggle(search.game, game.game),
              }),
            )
            .class(
              `flex shrink-0 items-center gap-2 rounded px-2 py-1.5 text-sm whitespace-nowrap hover:bg-raised hover:text-ink ${selected ? "bg-raised text-ink" : "text-muted"}`,
            )
            .children(
              GameMark(h, game, "size-5"),
              game?.name ?? "All games",
              game &&
                selected &&
                h.span
                  .attrs({ role: "img", "aria-label": "shown" })
                  .class("ml-auto size-4 text-accent")
                  .children(CheckIcon(h)),
            );
        }),
      ),
    h.div
      .class(
        "mt-auto hidden items-center justify-between bg-rail/60 px-3 py-2 lg:flex",
      )
      .children(
        h.span
          .class("flex min-w-0 items-center gap-2")
          .children(
            Avatar(h, me.avatarUrl),
            h.span.class("truncate text-sm font-bold").children(me.discordName),
          ),
        SignOut(h),
      ),
  );

// the tracked players, as the member list beside the feed on wide screens and
// a row above it otherwise. Each one toggles in and out of the filter.
const Members = (
  h: H,
  players: ReadonlyArray<Player>,
  selected: ReadonlyArray<string> | undefined,
) =>
  h.aside.attr("aria-label", "Tracked players").children(
    h.p
      .class(
        `${selected ? "flex" : "hidden xl:flex"} h-7 shrink-0 items-center justify-between px-2 text-xs font-bold text-muted xl:mb-2`,
      )
      .children(
        h.span.class("hidden xl:inline").children(`Tracked: ${players.length}`),
        selected &&
          h.button
            .attr("type", "button")
            .class(
              "flex items-center gap-1 rounded border border-accent/60 px-1.5 py-0.5 text-accent hover:bg-accent hover:text-rail",
            )
            .on("click", FeedMessage.ClickedShowEveryone())
            .children(CloseIcon(h).class("size-3"), "Show everyone"),
      ),
    players.map((player) => {
      const active = selected?.includes(player.discordUserId) ?? false;
      return Toggle(h, {
        props: { pressed: active },
        onToggle: () =>
          FeedMessage.ToggledMember({ discordUserId: player.discordUserId }),
      })
        .key(player.discordUserId)
        .attr(
          "title",
          `${active ? "Hide" : "Show"} ${player.discordName}'s matches`,
        )
        .class(
          "flex shrink-0 items-center gap-3 rounded px-2 py-1.5 text-left text-sm whitespace-nowrap text-muted hover:bg-raised hover:text-ink aria-pressed:bg-raised aria-pressed:text-ink xl:w-full",
        )
        .children(
          Avatar(h, player.avatarUrl),
          h.span.class("truncate").children(player.discordName),
          active && CheckIcon(h).class("ml-auto size-4 shrink-0 text-accent"),
        );
    }),
  );

const orders = [
  ["newest", "Newest"],
  ["oldest", "Oldest"],
] as const;

// the button under the last page, while there's another to load
const LoadMore = (h: H, more: Query.More<never>) => {
  const button = (label: string, loading: boolean) =>
    h.button
      .attr("type", "button")
      .disabled(loading)
      .class(
        "w-full rounded bg-embed py-3 text-sm text-muted hover:bg-accent hover:text-rail disabled:bg-embed disabled:text-muted",
      )
      .on("click", FeedMessage.ClickedLoadMore())
      .children(label);
  return Match.valueTags(more, {
    End: () => null,
    Available: () => button("Load more matches", false),
    Loading: () => button("Loading matches", true),
    Failed: () => button("Couldn't load more. Try again", false),
  });
};

const Loading = (h: H) =>
  h.p.class("py-6 text-sm text-muted").children("Loading matches");

// a card alone on the page, for signing in or saying what went wrong
const Centered = (h: H) =>
  h.div
    .class("w-full max-w-md rounded-md bg-page p-8")
    .forward((card) =>
      h.main
        .class("grid min-h-dvh place-items-center bg-rail px-6")
        .children(card),
    );

const FeedNoDeps = Html.component({
  name: "Feed",
  // the root holds the route: the first arrives as props, every later one
  // through the Router's subscription
  props: Schema.Struct({ route: AppRoute }),
  model: Schema.Struct({ route: AppRoute }),
  message: FeedMessage,
  queries: {
    me: { query: GetMe, args: () => ({}) },
    // only once signed in. While new filters load, the last matches stay
    feed: {
      query: ListFeed,
      args: ({ model, queries }) =>
        AsyncResult.isSuccess(queries.me) ? model.route.search : undefined,
    },
  },
}).make({
  init: ($) => ({ route: $.props.route }),
  update: ($, message) => {
    // a filter changes the url and the route comes back through the
    // subscription. Each is its own history entry, as a link would be.
    const filter = (search: Partial<Search>) =>
      $.run(
        Router.patchSearch(AppRoute, $.model.route, search, {
          history: "push",
        }).pipe(Command.asNoop),
      );
    return FeedMessage.match(message, {
      ChangedRoute: ({ route }) => $.evolve({ route }),
      ToggledMember: ({ discordUserId }) =>
        filter({
          player: toggle($.model.route.search.player, discordUserId),
        }),
      ClickedShowEveryone: () => filter({ player: undefined }),
      PickedMatchPlayer: ({ discordUserId }) =>
        filter({ player: [discordUserId] }),
      // pressing the order already chosen leaves it chosen
      ToggledOrder: ({ value }) =>
        Option.match(Arr.head(value), {
          onNone: () => $.model,
          onSome: (order) =>
            filter({ order: order === "oldest" ? "oldest" : undefined }),
        }),
      ClickedLoadMore: () => $.loadMore("feed"),
    });
  },
  subscriptions: ({ model }) => [
    Router.subscription(AppRoute, model.route, (route) =>
      FeedMessage.ChangedRoute({ route }),
    ),
  ],
  view: (h, model) =>
    AsyncResult.matchWithError(h.queries.me, {
      onInitial: () => h.main.class("min-h-dvh bg-rail"),
      onError: () =>
        Centered(h).children(
          h.h1.class("text-2xl font-extrabold").children("Match feed"),
          h.p
            .class("mt-3 text-sm text-muted")
            .children(
              "Every match the bot reports in your servers, in one place. Sign in with the Discord account you signed up with.",
            ),
          h.a
            .attr("href", "/auth/discord")
            .class(
              "mt-6 block rounded bg-[#5865f2] px-4 py-2.5 text-center text-sm font-bold text-white hover:bg-[#4752c4]",
            )
            .children("Sign in with Discord"),
        ),
      onDefect: () =>
        Centered(h).children(
          h.p("Couldn't reach the bot. Reload the page to try again."),
        ),
      onSuccess: ({ value: me }) => {
        const { search } = model.route;
        const server = me.servers.find((s) => s.guildId === search.server);
        const players = [
          ...new Map(
            (server ? [server] : me.servers)
              .flatMap((s) => s.players)
              .map((player) => [player.discordUserId, player]),
          ).values(),
        ].sort((a, b) => a.discordName.localeCompare(b.discordName));
        const games = me.games.filter((g) => search.game?.includes(g.game));
        const order = search.order ?? "newest";

        return h.div
          .class("flex min-h-dvh flex-col lg:h-dvh lg:flex-row")
          .children(
            ServerRail(h, me, search),
            Channels(h, me, search, server?.name ?? "All your servers"),
            h.main
              .class("flex min-w-0 flex-1 flex-col lg:overflow-y-auto")
              .children(
                h.header
                  .class(
                    "sticky top-0 z-10 flex h-12 shrink-0 items-center gap-3 border-b border-rail bg-page px-4",
                  )
                  .children(
                    h.span
                      .class("text-muted")
                      .children(
                        GameMark(
                          h,
                          games.length === 1 ? games[0] : undefined,
                          "size-5",
                        ),
                      ),
                    h.h2
                      .class("mr-auto truncate font-bold")
                      .children(
                        games.length > 0
                          ? games.map((g) => g.name).join(", ")
                          : "All games",
                      ),
                    ToggleGroup(h, {
                      props: {
                        value: [order],
                        items: orders.map(([value]) => ({ value })),
                      },
                      onEmit: ({ value }) =>
                        FeedMessage.ToggledOrder({ value }),
                      view: (toggleGroup) =>
                        toggleGroup
                          .root(
                            h.div
                              .attr("aria-label", "Order")
                              .class("flex rounded bg-rail p-0.5"),
                          )
                          .children(
                            orders.map(([value, label]) =>
                              toggleGroup
                                .item({
                                  element: h.button
                                    .key(value)
                                    .attr("type", "button")
                                    .class(
                                      "rounded px-2 py-1 text-xs text-muted hover:text-ink aria-pressed:bg-raised aria-pressed:text-ink",
                                    ),
                                  value,
                                })
                                .children(label),
                            ),
                          ),
                    }),
                    h.span.class("lg:hidden").children(SignOut(h)),
                  ),
                Members(h, players, search.player).class(
                  "flex shrink-0 items-center gap-1 overflow-x-auto border-b border-rail px-2 py-2 xl:hidden",
                ),
                h.div.class("mx-auto w-full max-w-6xl px-4 py-4").children(
                  AsyncResult.match(h.queries.feed, {
                    onInitial: () => Loading(h),
                    onFailure: () =>
                      h.p
                        .class("py-6 text-sm text-loss")
                        .children(
                          "Couldn't load matches. Reload the page to try again.",
                        ),
                    // the filters respond at once; the matches follow when
                    // they've loaded, and only dim if that takes a moment
                    onSuccess: ({ value: feed, waiting }) =>
                      h.div
                        .class(
                          "space-y-1.5 transition-opacity",
                          waiting && "opacity-60 delay-200",
                        )
                        .children(
                          feed.items.map((entry) =>
                            MatchRow(h, {
                              key: `${entry.game}:${entry.matchId}`,
                              props: {
                                entry,
                                game: me.games.find(
                                  (game) => game.game === entry.game,
                                ),
                              },
                              onEmit: {
                                PickedPlayer: ({ discordUserId }) =>
                                  FeedMessage.PickedMatchPlayer({
                                    discordUserId,
                                  }),
                              },
                            }),
                          ),
                          feed.items.length === 0 &&
                            h.div
                              .class("py-16 text-center")
                              .children(
                                h.p
                                  .class("font-bold")
                                  .children("No matches here yet"),
                                h.p
                                  .class("mt-1 text-sm text-muted")
                                  .children(
                                    search.game || search.player
                                      ? "Nothing matches these filters. Pick all-games or another player."
                                      : "Reports show up here once the bot posts them in Discord.",
                                  ),
                              ),
                          LoadMore(h, feed.more),
                        ),
                  }),
                ),
              ),
            Members(h, players, search.player).class(
              "hidden w-60 shrink-0 overflow-y-auto bg-sidebar px-2 py-4 xl:block",
            ),
          );
      },
    }),
});

export const Feed = FeedNoDeps.pipe(
  Component.provide(Layer.mergeAll(GetMe.layer, ListFeed.layer)),
);
