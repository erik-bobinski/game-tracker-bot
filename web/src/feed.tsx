// The signed-in feed, laid out like the Discord it mirrors: servers in a rail,
// games as channels, tracked players as members, and the matches reported
// there in between, narrowed by the filters in the url.

import { useAtomSuspense, useAtomValue } from "@effect/atom-react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { HttpApiError } from "effect/http-api";
import { AsyncResult } from "effect/reactivity";
import { Check, LayoutGrid, LogOut, X } from "lucide-react";
import { Suspense, useDeferredValue, useState, useTransition } from "react";
import type { FeedPage, Me } from "../../src/services/web/api.ts";
import { Site } from "./client.ts";
import { MatchRow } from "./match.tsx";

const route = getRouteApi("/feed");
type Search = ReturnType<typeof route.useSearch>;
type Cursor = NonNullable<FeedPage["next"]>;
type Player = Me["servers"][number]["players"][number];

// "Friday Night Ranked" -> "FNR", as Discord labels a server with no icon
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((word) => word.charAt(0))
    .join("")
    .slice(0, 3)
    .toUpperCase();

type Game = Me["games"][number];

// a filter with this value added, or taken out if it's already there; an
// empty filter is no filter
const toggle = <A,>(list: ReadonlyArray<A> | undefined, value: A) => {
  const next = list?.includes(value)
    ? list.filter((item) => item !== value)
    : [...(list ?? []), value];
  return next.length > 0 ? next : undefined;
};

// a game's logo, or the grid that stands for all of them
const GameMark = ({ game, size }: { game: Game | undefined; size: string }) =>
  game ? (
    <img
      src={game.iconUrl}
      alt=""
      className={`${size} shrink-0 rounded-full`}
    />
  ) : (
    <LayoutGrid aria-hidden className={`${size} shrink-0`} />
  );

const Avatar = ({ src }: { src: string }) => (
  <img src={src} alt="" className="size-8 shrink-0 rounded-full bg-raised" />
);

const SignOut = ({ label }: { label: boolean }) => (
  <form method="post" action="/auth/sign-out">
    <button
      type="submit"
      title="Sign out"
      className="flex items-center gap-2 rounded p-1.5 text-muted hover:bg-raised hover:text-ink"
    >
      <LogOut aria-hidden className="size-4" />
      {label ? <span className="text-xs">Sign out</span> : null}
    </button>
  </form>
);

// a rail button: round until hovered or chosen, with Discord's white pill
// marking the chosen one
const RailItem = ({
  label,
  active,
  search,
  children,
}: {
  label: string;
  active: boolean;
  search: Search;
  children: React.ReactNode;
}) => (
  <Link
    to="/feed"
    search={search}
    aria-label={label}
    title={label}
    activeOptions={{ explicitUndefined: true }}
    className="group relative flex shrink-0 justify-center lg:w-full"
  >
    <span
      aria-hidden
      className={`absolute -bottom-2 h-1 rounded-t bg-ink transition-all lg:top-1/2 lg:bottom-auto lg:left-0 lg:h-auto lg:w-1 lg:-translate-y-1/2 lg:rounded-t-none lg:rounded-r ${active ? "w-8 lg:h-10" : "w-0 group-hover:w-4 lg:h-0 lg:group-hover:h-5"}`}
    />
    <span
      className={`grid size-12 place-items-center overflow-hidden text-sm font-bold transition-all ${active ? "rounded-2xl bg-accent text-rail" : "rounded-full bg-raised text-ink group-hover:rounded-2xl group-hover:bg-accent group-hover:text-rail"}`}
    >
      {children}
    </span>
  </Link>
);

const ServerRail = ({ me, search }: { me: Me; search: Search }) => (
  <nav
    aria-label="Servers"
    className="flex shrink-0 items-center gap-3 overflow-x-auto bg-rail px-3 py-3 lg:w-[72px] lg:flex-col lg:overflow-y-auto lg:px-0"
  >
    <RailItem
      label="All servers"
      active={!search.server}
      search={{ ...search, server: undefined, player: undefined }}
    >
      <LayoutGrid aria-hidden className="size-5" />
    </RailItem>
    <span
      aria-hidden
      className="h-8 w-0.5 shrink-0 rounded bg-raised lg:h-0.5 lg:w-8"
    />
    {me.servers.map((server) => (
      <RailItem
        key={server.guildId}
        label={server.name}
        active={search.server === server.guildId}
        search={{ ...search, server: server.guildId, player: undefined }}
      >
        {server.iconUrl ? (
          <img src={server.iconUrl} alt="" className="size-full object-cover" />
        ) : (
          initials(server.name)
        )}
      </RailItem>
    ))}
  </nav>
);

// the games, listed where Discord lists a server's channels. Each one toggles
// in and out of the filter, so several can be shown at once.
const Channels = ({
  me,
  search,
  serverName,
}: {
  me: Me;
  search: Search;
  serverName: string;
}) => (
  <aside className="flex shrink-0 flex-col bg-sidebar lg:w-60">
    <h1 className="hidden h-12 items-center border-b border-rail px-4 text-sm font-bold lg:flex">
      {serverName}
    </h1>
    <nav
      aria-label="Games"
      className="flex gap-1 overflow-x-auto px-2 py-2 lg:flex-col lg:py-3"
    >
      <p className="hidden px-2 pb-1 text-xs font-bold text-muted lg:block">
        Games
      </p>
      {[undefined, ...me.games].map((game) => {
        const selected = game
          ? (search.game?.includes(game.game) ?? false)
          : !search.game;
        return (
          <Link
            key={game?.game ?? "all"}
            to="/feed"
            // worked out on click from the url as it is then, as a click
            // before the last one's matches have loaded still adds to it
            search={(previous) => ({
              ...previous,
              game: game && toggle(previous.game, game.game),
            })}
            className={`flex shrink-0 items-center gap-2 rounded px-2 py-1.5 text-sm whitespace-nowrap hover:bg-raised hover:text-ink ${selected ? "bg-raised text-ink" : "text-muted"}`}
          >
            <GameMark game={game} size="size-5" />
            {game?.name ?? "All games"}
            {game && selected && (
              <Check
                aria-label="shown"
                className="ml-auto size-4 text-accent"
              />
            )}
          </Link>
        );
      })}
    </nav>
    <div className="mt-auto hidden items-center justify-between bg-rail/60 px-3 py-2 lg:flex">
      <span className="flex min-w-0 items-center gap-2">
        <Avatar src={me.avatarUrl} />
        <span className="truncate text-sm font-bold">{me.discordName}</span>
      </span>
      <SignOut label={false} />
    </div>
  </aside>
);

// the tracked players, as the member list beside the feed on wide screens and
// a row above it otherwise. Each one toggles in and out of the filter.
const Members = ({
  players,
  selected,
  onSelect,
  className,
}: {
  players: ReadonlyArray<Player>;
  selected: ReadonlyArray<string> | undefined;
  // a player to add or take out, or undefined to show everyone
  onSelect: (discordUserId: string | undefined) => void;
  className: string;
}) => (
  <aside aria-label="Tracked players" className={className}>
    <p
      className={`${selected ? "flex" : "hidden xl:flex"} h-7 shrink-0 items-center justify-between px-2 text-xs font-bold text-muted xl:mb-2`}
    >
      <span className="hidden xl:inline">Tracked: {players.length}</span>
      {selected && (
        <button
          type="button"
          onClick={() => onSelect(undefined)}
          className="flex items-center gap-1 rounded border border-accent/60 px-1.5 py-0.5 text-accent hover:bg-accent hover:text-rail"
        >
          <X aria-hidden className="size-3" />
          Show everyone
        </button>
      )}
    </p>
    {players.map((player) => {
      const active = selected?.includes(player.discordUserId) ?? false;
      return (
        <button
          key={player.discordUserId}
          type="button"
          aria-pressed={active}
          onClick={() => onSelect(player.discordUserId)}
          title={
            active
              ? `Hide ${player.discordName}'s matches`
              : `Show ${player.discordName}'s matches`
          }
          className="flex shrink-0 items-center gap-3 rounded px-2 py-1.5 text-left text-sm whitespace-nowrap text-muted hover:bg-raised hover:text-ink aria-pressed:bg-raised aria-pressed:text-ink xl:w-full"
        >
          <Avatar src={player.avatarUrl} />
          <span className="truncate">{player.discordName}</span>
          {active && (
            <Check
              aria-hidden
              className="ml-auto size-4 shrink-0 text-accent"
            />
          )}
        </button>
      );
    })}
  </aside>
);

const Toggle = ({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<readonly [value: string, label: string]>;
  value: string;
  onChange: (value: string) => void;
}) => (
  <span className="flex rounded bg-rail p-0.5">
    {options.map(([optionValue, label]) => (
      <button
        key={optionValue}
        type="button"
        aria-pressed={value === optionValue}
        onClick={() => onChange(optionValue)}
        className="rounded px-2 py-1 text-xs text-muted hover:text-ink aria-pressed:bg-raised aria-pressed:text-ink"
      >
        {label}
      </button>
    ))}
  </span>
);

const loading = <p className="py-6 text-sm text-muted">Loading matches</p>;

// one page of matches; the last page offers the next. It suspends while
// loading, so the matches already on screen stay until these replace them.
const Page = ({
  me,
  search,
  cursor,
  isLast,
  loadingMore,
  onMore,
  onPlayer,
}: {
  me: Me;
  search: Search;
  cursor: Cursor | undefined;
  isLast: boolean;
  loadingMore: boolean;
  onMore: (cursor: Cursor) => void;
  onPlayer: (discordUserId: string) => void;
}) => {
  const result = useAtomSuspense(
    Site.query("feed", "feed", { query: { ...search, cursor } }),
    { includeFailure: true },
  );
  return AsyncResult.match(result, {
    onInitial: () => loading,
    onFailure: () => (
      <p className="py-6 text-sm text-loss">
        Couldn't load matches. Reload the page to try again.
      </p>
    ),
    onSuccess: ({ value }) => (
      <>
        {value.matches.map((entry) => (
          <MatchRow
            key={`${entry.game}:${entry.matchId}`}
            entry={entry}
            game={me.games.find((game) => game.game === entry.game)}
            onPlayer={onPlayer}
          />
        ))}
        {cursor === undefined && value.matches.length === 0 && (
          <div className="py-16 text-center">
            <p className="font-bold">No matches here yet</p>
            <p className="mt-1 text-sm text-muted">
              {search.game || search.player
                ? "Nothing matches these filters. Pick all-games or another player."
                : "Reports show up here once the bot posts them in Discord."}
            </p>
          </div>
        )}
        {isLast && value.next && (
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => value.next && onMore(value.next)}
            className="w-full rounded bg-embed py-3 text-sm text-muted hover:bg-accent hover:text-rail disabled:bg-embed disabled:text-muted"
          >
            {loadingMore ? "Loading matches" : "Load more matches"}
          </button>
        )}
      </>
    ),
  });
};

const Matches = ({
  me,
  search,
  onPlayer,
}: {
  me: Me;
  search: Search;
  onPlayer: (discordUserId: string) => void;
}) => {
  const [cursors, setCursors] = useState<ReadonlyArray<Cursor>>([]);
  // the next page loads behind the button rather than blanking the feed
  const [loadingMore, startTransition] = useTransition();
  const pages = [undefined, ...cursors];
  return (
    <div className="space-y-1.5">
      {pages.map((cursor, index) => (
        <Page
          key={cursor ? `${cursor.game}:${cursor.matchId}` : "first"}
          me={me}
          search={search}
          cursor={cursor}
          isLast={index === pages.length - 1}
          loadingMore={loadingMore}
          onMore={(next) =>
            startTransition(() => setCursors([...cursors, next]))
          }
          onPlayer={onPlayer}
        />
      ))}
    </div>
  );
};

const SignedIn = ({ me }: { me: Me }) => {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const server = me.servers.find((s) => s.guildId === search.server);
  const players = [
    ...new Map(
      (server ? [server] : me.servers)
        .flatMap((s) => s.players)
        .map((player) => [player.discordUserId, player]),
    ).values(),
  ].sort((a, b) => a.discordName.localeCompare(b.discordName));
  // from the url as it is when it runs, not as this render saw it: the
  // router only commits a navigation once its matches have loaded
  const update = (next: (previous: Search) => Partial<Search>) =>
    navigate({
      to: "/feed",
      search: (previous) => ({ ...previous, ...next(previous) }),
    });
  const games = me.games.filter((g) => search.game?.includes(g.game));
  const togglePlayer = (player: string | undefined) =>
    update((previous) => ({
      player:
        player === undefined ? undefined : toggle(previous.player, player),
    }));
  // the filters respond at once; the matches follow when they've loaded, and
  // only dim if that takes a moment
  const shown = useDeferredValue(search);
  const stale = JSON.stringify(shown) !== JSON.stringify(search);

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh lg:flex-row">
      <ServerRail me={me} search={search} />
      <Channels
        me={me}
        search={search}
        serverName={server?.name ?? "All your servers"}
      />
      <main className="flex min-w-0 flex-1 flex-col lg:overflow-y-auto">
        <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-3 border-b border-rail bg-page px-4">
          <span className="text-muted">
            <GameMark
              game={games.length === 1 ? games[0] : undefined}
              size="size-5"
            />
          </span>
          <h2 className="mr-auto truncate font-bold">
            {games.length > 0
              ? games.map((g) => g.name).join(", ")
              : "All games"}
          </h2>
          <Toggle
            value={search.order ?? "newest"}
            options={[
              ["newest", "Newest"],
              ["oldest", "Oldest"],
            ]}
            onChange={(value) =>
              update(() => ({
                order: value === "oldest" ? "oldest" : undefined,
              }))
            }
          />
          <span className="lg:hidden">
            <SignOut label={false} />
          </span>
        </header>
        <Members
          players={players}
          selected={search.player}
          onSelect={togglePlayer}
          className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-rail px-2 py-2 xl:hidden"
        />
        <div
          className={`mx-auto w-full max-w-6xl px-4 py-4 transition-opacity ${stale ? "opacity-60 delay-200" : ""}`}
        >
          <Suspense fallback={loading}>
            <Matches
              key={JSON.stringify(shown)}
              me={me}
              search={shown}
              onPlayer={(player) => update(() => ({ player: [player] }))}
            />
          </Suspense>
        </div>
      </main>
      <Members
        players={players}
        selected={search.player}
        onSelect={togglePlayer}
        className="hidden w-60 shrink-0 overflow-y-auto bg-sidebar px-2 py-4 xl:block"
      />
    </div>
  );
};

const Centered = ({ children }: { children: React.ReactNode }) => (
  <main className="grid min-h-dvh place-items-center bg-rail px-6">
    <div className="w-full max-w-md rounded-md bg-page p-8">{children}</div>
  </main>
);

const unreachable = (
  <Centered>
    <p>Couldn't reach the bot. Reload the page to try again.</p>
  </Centered>
);

export const Feed = () => {
  const me = useAtomValue(Site.query("feed", "me", {}));
  return AsyncResult.matchWithError(me, {
    onInitial: () => <main className="min-h-dvh bg-rail" />,
    onError: (error) =>
      error instanceof HttpApiError.Unauthorized ? (
        <Centered>
          <h1 className="text-2xl font-extrabold">Match feed</h1>
          <p className="mt-3 text-sm text-muted">
            Every match the bot reports in your servers, in one place. Sign in
            with the Discord account you signed up with.
          </p>
          <a
            href="/auth/discord"
            className="mt-6 block rounded bg-[#5865f2] px-4 py-2.5 text-center text-sm font-bold text-white hover:bg-[#4752c4]"
          >
            Sign in with Discord
          </a>
        </Centered>
      ) : (
        unreachable
      ),
    onDefect: () => unreachable,
    onSuccess: ({ value }) => <SignedIn me={value} />,
  });
};
