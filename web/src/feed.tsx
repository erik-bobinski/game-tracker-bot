// The signed-in feed, laid out like the Discord it mirrors: servers in a rail,
// games as channels, tracked players as members, and the matches reported
// there in between, narrowed by the filters in the url.

import { useAtomValue } from "@effect/atom-react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { HttpApiError } from "effect/http-api";
import { AsyncResult } from "effect/reactivity";
import { LayoutGrid, LogOut } from "lucide-react";
import { useState } from "react";
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

const channelLink =
  "flex shrink-0 items-center gap-2 rounded px-2 py-1.5 text-sm whitespace-nowrap text-muted hover:bg-raised hover:text-ink aria-[current=page]:bg-raised aria-[current=page]:text-ink";

// the games, listed where Discord lists a server's channels
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
      {[undefined, ...me.games].map((game) => (
        <Link
          key={game?.game ?? "all"}
          to="/feed"
          search={{ ...search, game: game?.game }}
          activeOptions={{ explicitUndefined: true }}
          className={channelLink}
        >
          <GameMark game={game} size="size-5" />
          {game?.name ?? "All games"}
        </Link>
      ))}
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

// the tracked players, as the member list; picking one narrows the feed to
// them, and picking them again shows everyone
const Members = ({
  players,
  selected,
  onSelect,
}: {
  players: ReadonlyArray<Player>;
  selected: string | undefined;
  onSelect: (discordUserId: string | undefined) => void;
}) => (
  <aside
    aria-label="Tracked players"
    className="hidden w-60 shrink-0 overflow-y-auto bg-sidebar px-2 py-4 xl:block"
  >
    <p className="px-2 pb-2 text-xs font-bold text-muted">
      Tracked, {players.length}
    </p>
    {players.map((player) => {
      const active = selected === player.discordUserId;
      return (
        <button
          key={player.discordUserId}
          type="button"
          aria-pressed={active}
          onClick={() => onSelect(active ? undefined : player.discordUserId)}
          title={
            active
              ? "Show everyone's matches"
              : `Show only ${player.discordName}'s matches`
          }
          className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-left text-sm text-muted hover:bg-raised hover:text-ink aria-pressed:bg-raised aria-pressed:text-accent"
        >
          <Avatar src={player.avatarUrl} />
          <span className="truncate">{player.discordName}</span>
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

// one page of matches; the last page offers the next
const Page = ({
  me,
  search,
  cursor,
  isLast,
  onMore,
  onPlayer,
}: {
  me: Me;
  search: Search;
  cursor: Cursor | undefined;
  isLast: boolean;
  onMore: (cursor: Cursor) => void;
  onPlayer: (discordUserId: string) => void;
}) => {
  const result = useAtomValue(
    Site.query("feed", "feed", { query: { ...search, cursor } }),
  );
  return AsyncResult.match(result, {
    onInitial: () => <p className="py-6 text-sm text-muted">Loading matches</p>,
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
            onClick={() => value.next && onMore(value.next)}
            className="w-full rounded bg-embed py-3 text-sm text-muted hover:bg-accent hover:text-rail"
          >
            Load more matches
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
          onMore={(next) => setCursors([...cursors, next])}
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
  const update = (next: Partial<Search>) =>
    navigate({ to: "/feed", search: (previous) => ({ ...previous, ...next }) });
  const game = me.games.find((g) => g.game === search.game);

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
          <span className="hidden text-muted sm:block">
            <GameMark game={game} size="size-5" />
          </span>
          <h2 className="mr-auto hidden truncate font-bold sm:block">
            {game?.name ?? "All games"}
          </h2>
          <select
            aria-label="Player"
            value={search.player ?? ""}
            onChange={(event) =>
              update({ player: event.target.value || undefined })
            }
            className="mr-auto max-w-36 rounded bg-rail px-2 py-1 text-xs text-ink hover:bg-raised sm:mr-0 xl:hidden"
          >
            <option value="">Everyone</option>
            {players.map((p) => (
              <option key={p.discordUserId} value={p.discordUserId}>
                {p.discordName}
              </option>
            ))}
          </select>
          <Toggle
            value={search.order ?? "newest"}
            options={[
              ["newest", "Newest"],
              ["oldest", "Oldest"],
            ]}
            onChange={(value) =>
              update({ order: value === "oldest" ? "oldest" : undefined })
            }
          />
          <span className="lg:hidden">
            <SignOut label={false} />
          </span>
        </header>
        <div className="mx-auto w-full max-w-4xl px-4 py-4">
          <Matches
            key={JSON.stringify(search)}
            me={me}
            search={search}
            onPlayer={(player) => update({ player })}
          />
        </div>
      </main>
      <Members
        players={players}
        selected={search.player}
        onSelect={(player) => update({ player })}
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
