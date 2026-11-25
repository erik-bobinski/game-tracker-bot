// The signed-in feed: the servers the viewer is tracked in down the side, and
// the matches reported there, narrowed by the filters in the url.

import { useAtomValue } from "@effect/atom-react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { HttpApiError } from "effect/http-api";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import type { FeedPage, Me } from "../../src/services/web/api.ts";
import { Site } from "./client.ts";
import { MatchEntry } from "./match.tsx";

const route = getRouteApi("/feed");
type Search = ReturnType<typeof route.useSearch>;
type Cursor = NonNullable<FeedPage["next"]>;

const SignOut = ({ className }: { className: string }) => (
  <form method="post" action="/auth/sign-out" className={className}>
    <button type="submit" className="text-sm text-muted hover:text-ink">
      Sign out
    </button>
  </form>
);

const ServerIcon = ({
  name,
  iconUrl,
}: {
  name: string;
  iconUrl: string | null;
}) =>
  iconUrl ? (
    <img src={iconUrl} alt="" className="size-7 rounded-full" />
  ) : (
    <span
      aria-hidden
      className="grid size-7 place-items-center rounded-full bg-raised text-xs font-semibold"
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );

const serverLink =
  "flex shrink-0 items-center gap-3 rounded-md px-3 py-2 text-sm whitespace-nowrap text-muted hover:bg-surface hover:text-ink data-[active=true]:bg-surface data-[active=true]:font-semibold data-[active=true]:text-ink";

const Sidebar = ({ me, search }: { me: Me; search: Search }) => (
  <aside className="flex flex-col border-b border-line lg:sticky lg:top-0 lg:h-dvh lg:border-r lg:border-b-0">
    <div className="flex items-center justify-between px-5 pt-5">
      <p className="font-score text-2xl font-bold">Match feed</p>
      <SignOut className="lg:hidden" />
    </div>
    <nav
      aria-label="Servers"
      className="flex gap-1 overflow-x-auto px-3 py-3 lg:flex-col"
    >
      <Link
        to="/feed"
        search={{ ...search, server: undefined, player: undefined }}
        className={serverLink}
        activeOptions={{ includeSearch: false }}
        aria-current={search.server ? undefined : "page"}
        data-active={!search.server}
      >
        <span
          aria-hidden
          className="grid size-7 place-items-center rounded-full bg-raised text-xs"
        >
          {me.servers.length}
        </span>
        All servers
      </Link>
      {me.servers.map((server) => (
        <Link
          key={server.guildId}
          to="/feed"
          search={{ ...search, server: server.guildId, player: undefined }}
          className={serverLink}
          aria-current={search.server === server.guildId ? "page" : undefined}
          data-active={search.server === server.guildId}
        >
          <ServerIcon name={server.name} iconUrl={server.iconUrl} />
          {server.name}
        </Link>
      ))}
    </nav>
    <div className="mt-auto hidden items-center justify-between border-t border-line px-5 py-4 lg:flex">
      <span className="text-sm">{me.discordName}</span>
      <SignOut className="" />
    </div>
  </aside>
);

const Select = ({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [value: string, label: string]>;
  onChange: (value: string) => void;
}) => (
  <select
    aria-label={label}
    value={value}
    onChange={(event) => onChange(event.target.value)}
    className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:border-faint"
  >
    {options.map(([optionValue, optionLabel]) => (
      <option key={optionValue} value={optionValue}>
        {optionLabel}
      </option>
    ))}
  </select>
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
          <MatchEntry
            key={`${entry.game}:${entry.matchId}`}
            entry={entry}
            game={me.games.find((game) => game.game === entry.game)}
            onPlayer={onPlayer}
          />
        ))}
        {cursor === undefined && value.matches.length === 0 && (
          <div className="rounded-lg border border-dashed border-line px-6 py-10">
            <p className="font-semibold">No matches here yet</p>
            <p className="mt-1 text-sm text-muted">
              {search.game || search.player
                ? "Nothing matches these filters. Clear them to see every report."
                : "Reports show up here once the bot posts them in Discord."}
            </p>
          </div>
        )}
        {isLast && value.next && (
          <button
            type="button"
            onClick={() => value.next && onMore(value.next)}
            className="w-full rounded-lg border border-line py-3 text-sm text-muted hover:border-faint hover:text-ink"
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
    <div className="space-y-4">
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
  ];
  const update = (next: Partial<Search>) =>
    navigate({ to: "/feed", search: (previous) => ({ ...previous, ...next }) });

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <Sidebar me={me} search={search} />
      <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <h1 className="mr-auto text-xl font-semibold">
            {server?.name ?? "All your servers"}
          </h1>
          <Select
            label="Game"
            value={search.game ?? ""}
            options={[
              ["", "All games"],
              ...me.games.map((g) => [g.game, g.name] as const),
            ]}
            onChange={(value) =>
              update({ game: me.games.find((g) => g.game === value)?.game })
            }
          />
          <Select
            label="Player"
            value={search.player ?? ""}
            options={[
              ["", "Everyone"],
              ...players.map((p) => [p.discordUserId, p.discordName] as const),
            ]}
            onChange={(value) => update({ player: value || undefined })}
          />
          <Select
            label="Order"
            value={search.order ?? "newest"}
            options={[
              ["newest", "Newest first"],
              ["oldest", "Oldest first"],
            ]}
            onChange={(value) =>
              update({ order: value === "oldest" ? "oldest" : undefined })
            }
          />
        </div>
        <Matches
          key={JSON.stringify(search)}
          me={me}
          search={search}
          onPlayer={(player) => update({ player })}
        />
      </main>
    </div>
  );
};

const Centered = ({ children }: { children: React.ReactNode }) => (
  <main className="grid min-h-dvh place-items-center px-6">
    <div className="max-w-md">{children}</div>
  </main>
);

export const Feed = () => {
  const me = useAtomValue(Site.query("feed", "me", {}));
  return AsyncResult.matchWithError(me, {
    onInitial: () => <Centered>{null}</Centered>,
    onError: (error) =>
      error instanceof HttpApiError.Unauthorized ? (
        <Centered>
          <h1 className="font-score text-5xl leading-none font-bold">
            Every match your servers report
          </h1>
          <p className="mt-4 text-muted">
            Sign in with the Discord account you signed up with. You'll see the
            reports from each server the bot tracks you in.
          </p>
          <a
            href="/auth/discord"
            className="mt-6 inline-block rounded-md bg-[#5865f2] px-5 py-2.5 font-semibold text-white hover:bg-[#4752c4]"
          >
            Sign in with Discord
          </a>
        </Centered>
      ) : (
        <Centered>
          <p>Couldn't reach the bot. Reload the page to try again.</p>
        </Centered>
      ),
    onDefect: () => (
      <Centered>
        <p>Couldn't reach the bot. Reload the page to try again.</p>
      </Centered>
    ),
    onSuccess: ({ value }) => <SignedIn me={value} />,
  });
};
