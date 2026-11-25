// One reported match, drawn from its data rather than the Discord card's
// image, so every name and number is text: selectable, searchable, linkable.
// The feed lists each as a one-line summary; opening it shows the whole
// lobby, with the tracked friends marked. Verdicts and wording come from the
// same helpers the Discord report uses.

import { Match } from "effect";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  formatDuration,
  matchVerdict,
  ordinal,
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
import type { FeedMatch, Me } from "../../src/services/web/api.ts";

type Game = Me["games"][number];
type Friend = FeedMatch["players"][number];
type Outcome = "win" | "loss" | "draw" | "unknown";

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

const Portrait = ({ src, name }: { src: string | undefined; name: string }) =>
  src ? (
    <img
      src={src}
      alt=""
      loading="lazy"
      className="size-8 rounded-full bg-raised"
    />
  ) : (
    <span
      aria-hidden
      className="grid size-8 place-items-center rounded-full bg-raised text-xs font-bold text-muted"
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );

const Rank = ({
  player,
  update,
  game,
}: {
  player: MatchPlayerIdentity;
  update: RankUpdate | null;
  game: Game | undefined;
}) => {
  const change = update?.tierChange;
  const iconFor = (key: string | undefined) =>
    game?.rankIcons.find((rank) => rank.key === key)?.url;
  const icon = iconFor(change?.to.iconKey ?? player.rankIconKey);
  const label = change ? change.to.tier : player.rank;
  const delta = update?.delta;
  if (!label && delta === undefined) return <span>Unranked</span>;
  const changeTone = change?.promoted ? "text-win" : "text-loss";
  const previousIcon = iconFor(change?.from.iconKey);
  return (
    <span className="flex items-center gap-1.5">
      {/* a new tier reads as the card draws it: old emblem › new one */}
      {change && (
        <span className="flex items-center gap-1">
          {previousIcon ? (
            <img
              src={previousIcon}
              alt={change.from.tier}
              title={change.from.tier}
              className="size-4"
              loading="lazy"
            />
          ) : (
            <span>{change.from.tier}</span>
          )}
          <span aria-hidden className={`font-bold ${changeTone}`}>
            ›
          </span>
        </span>
      )}
      {icon && <img src={icon} alt="" className="size-4" loading="lazy" />}
      {label && (
        <span className={change ? `font-bold ${changeTone}` : "text-ink"}>
          {label}
        </span>
      )}
      {delta !== undefined && update && (
        <span
          className={
            delta > 0 ? "text-win" : delta < 0 ? "text-loss" : "text-muted"
          }
        >
          {delta > 0 ? "+" : delta < 0 ? "−" : "±"}
          {Math.abs(delta)} {update.unit}
        </span>
      )}
    </span>
  );
};

// the badges beside a name, in the card's order: a new tier, flairs, MVP
const Flairs = ({
  flairs,
  mvp,
  promoted,
}: {
  flairs: ReadonlyArray<string>;
  mvp: boolean;
  // set when the match moved them into another tier
  promoted: boolean | undefined;
}) => (
  <>
    {promoted !== undefined && (
      <span
        className={`shrink-0 rounded-sm px-1 text-[11px] font-bold text-rail ${promoted ? "bg-win" : "bg-loss"}`}
      >
        {promoted ? "RANK UP" : "DERANK"}
      </span>
    )}
    {mvp && (
      <span className="shrink-0 rounded-sm bg-accent px-1 text-[11px] font-bold text-rail">
        MVP
      </span>
    )}
    {flairs.map((flair) => (
      <span
        key={flair}
        className="shrink-0 rounded-sm bg-raised px-1 text-[11px] font-bold"
      >
        {flair}
      </span>
    ))}
  </>
);

// one player's line in the scoreboard; a tracked friend is marked in orange
// and their discord name filters the feed to them
const PlayerRow = ({
  player,
  friend,
  portrait,
  mvp,
  result,
  resultTone,
  game,
  onPlayer,
}: {
  player: MatchPlayerIdentity;
  friend: Friend | undefined;
  portrait: { readonly src: string | undefined; readonly name: string };
  mvp: boolean;
  result: string;
  resultTone: string;
  game: Game | undefined;
  onPlayer: (discordUserId: string) => void;
}) => (
  <li
    className={`grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-2 border-l-2 sm:gap-x-3 py-1.5 pr-2 pl-2 ${friend ? "border-accent bg-accent/10" : "border-transparent"}`}
  >
    <Portrait src={portrait.src} name={portrait.name} />
    <div className="min-w-0">
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span
          className={`truncate text-sm font-bold ${friend ? "text-accent" : ""}`}
        >
          {playerName(player)}
        </span>
        <Flairs
          flairs={player.flairs ?? []}
          mvp={mvp}
          promoted={friend?.rankUpdate?.tierChange?.promoted}
        />
      </p>
      <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted">
        {friend && (
          <button
            type="button"
            onClick={() => onPlayer(friend.discordUserId)}
            title={`Show only ${friend.discordName}'s matches`}
            className="rounded-sm px-0.5 text-accent hover:bg-accent hover:text-rail"
          >
            @{friend.discordName}
          </button>
        )}
        <Rank player={player} update={friend?.rankUpdate ?? null} game={game} />
      </div>
    </div>
    <div className="text-right">
      <p className={`text-sm font-bold tabular-nums ${resultTone}`}>{result}</p>
      {player.stat && (
        <p className="hidden text-[11px] whitespace-nowrap text-muted sm:block">
          {player.stat}
        </p>
      )}
    </div>
  </li>
);

// what a match's summary and its full report both lead with
interface Headline {
  readonly outcome: Outcome;
  readonly label: string;
  readonly score: readonly [number, number] | undefined;
  readonly entry: FeedMatch;
  readonly game: Game | undefined;
  readonly details: ReadonlyArray<string | undefined>;
  // each tracked friend's own line: their kda or placement
  readonly friends: ReadonlyArray<{
    readonly friend: Friend;
    readonly portrait: string | undefined;
    readonly result: string;
    readonly resultTone: string;
  }>;
}

const Time = ({ at, short }: { at: number; short: boolean }) => (
  <time dateTime={new Date(at).toISOString()} title={fullDate.format(at)}>
    {short && <span className="sm:hidden">{stamp(at, true)}</span>}
    <span className={short ? "hidden sm:inline" : ""}>{stamp(at, false)}</span>
  </time>
);

// the feed's line for a match: game, verdict and score, where it was played,
// how the friends did and when. The whole line opens the full report.
const Summary = ({
  outcome,
  label,
  score,
  entry,
  game,
  details,
  friends,
  onOpen,
}: Headline & { onOpen: () => void }) => (
  <article
    className={`relative flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded border-l-4 bg-embed px-3 py-2.5 hover:bg-raised md:flex-nowrap ${bar[outcome]}`}
  >
    {game && (
      <img
        src={game.iconUrl}
        alt={game.name}
        title={game.name}
        className="size-7 shrink-0 rounded-full"
      />
    )}
    {/* the headline keeps its line; a crowded lobby's friends wrap instead */}
    <div className="min-w-0 flex-1 md:min-w-56">
      <h2 className="text-sm font-extrabold">
        <button
          type="button"
          onClick={onOpen}
          aria-haspopup="dialog"
          className="text-left whitespace-nowrap after:absolute after:inset-0 after:rounded"
        >
          <span className={tone[outcome]}>{label}</span>
          {score && (
            <span className="ml-2 tabular-nums">
              {score[0]}–{score[1]}
            </span>
          )}
        </button>
      </h2>
      <p className="truncate text-xs text-muted">
        {details.filter(Boolean).join(" · ")}
      </p>
    </div>
    <div className="flex basis-full items-center justify-between gap-x-4 pl-11 md:basis-auto md:pl-0">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 md:justify-end">
        {friends.map(({ friend, portrait, result, resultTone }) => (
          <li
            key={friend.discordUserId}
            className="flex items-center gap-1.5 text-xs"
          >
            {portrait && (
              <img
                src={portrait}
                alt=""
                loading="lazy"
                className="size-5 rounded-full bg-raised"
              />
            )}
            <span className="max-w-28 truncate text-accent">
              {friend.discordName}
            </span>
            <span className={`font-bold tabular-nums ${resultTone}`}>
              {result}
            </span>
          </li>
        ))}
      </ul>
      <span className="shrink-0 text-right text-xs whitespace-nowrap text-faint md:w-44">
        <Time at={entry.playedAt} short />
      </span>
    </div>
  </article>
);

// the full report, shaped like the Discord embed it was posted as: the game
// as author, the verdict as title, the lobby as fields, and when it was
// played in the footer
const Entry = ({
  outcome,
  label,
  score,
  entry,
  game,
  details,
  children,
}: Headline & { children: React.ReactNode }) => (
  <article
    className={`rounded border-l-4 bg-embed px-3 py-3 sm:px-5 sm:py-4 ${bar[outcome]}`}
  >
    <p className="flex items-center gap-2 text-xs font-bold">
      {game && (
        <img src={game.iconUrl} alt="" className="size-5 rounded-full" />
      )}
      {game?.name}
    </p>
    <h2 className="mt-2 flex items-baseline gap-3 text-2xl font-extrabold sm:text-3xl">
      <span className={tone[outcome]}>{label}</span>
      {score && (
        <span className="tabular-nums">
          {score[0]}–{score[1]}
        </span>
      )}
    </h2>
    <p className="mt-1 text-sm text-muted">
      {details.filter(Boolean).join(", ")}
    </p>
    <div className="mt-4">{children}</div>
    <footer className="mt-3 text-xs text-muted">
      <Time at={entry.playedAt} short={false} />
    </footer>
  </article>
);

interface View {
  readonly entry: FeedMatch;
  readonly game: Game | undefined;
  readonly onPlayer: (discordUserId: string) => void;
  // undefined shows the full report
  readonly onOpen: (() => void) | undefined;
}

const VersusMatchEntry = ({
  entry,
  match,
  game,
  onPlayer,
  onOpen,
}: View & { match: VersusMatch }) => {
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
  const headline: Headline = {
    outcome: key,
    label: verdict.label,
    score: trackedTeam?.score,
    entry,
    game,
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
              result: `${player.kills}/${player.deaths}/${player.assists}`,
              resultTone: "",
            },
          ]
        : [];
    }),
  };
  if (onOpen) return <Summary {...headline} onOpen={onOpen} />;

  return (
    <Entry {...headline}>
      <div className="grid gap-6 md:grid-cols-2">
        {teams.map((team, index) => {
          const players = match.players.filter((p) => p.team === team.id);
          const outcome = teamOutcome(team);
          return (
            <section key={team.id} aria-label={teamLabel(index)}>
              <h3 className="mb-1 border-b border-line pb-1 text-xs">
                <span className="font-bold">{teamLabel(index)}</span>{" "}
                <span className={tone[outcome]}>{teamWords[outcome]}</span>
                <span className="text-muted">
                  , {players.reduce((kills, p) => kills + p.kills, 0)} kills
                </span>
              </h3>
              <ul>
                {players.map((player) => (
                  <PlayerRow
                    key={player.puuid}
                    player={player}
                    friend={friends.get(player.puuid)}
                    portrait={{
                      src: player.characterIconUrl,
                      name: player.character,
                    }}
                    mvp={player.puuid === mvp}
                    result={`${player.kills}/${player.deaths}/${player.assists}`}
                    resultTone=""
                    game={game}
                    onPlayer={onPlayer}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </Entry>
  );
};

const PlacementMatchEntry = ({
  entry,
  match,
  game,
  onPlayer,
  onOpen,
}: View & { match: PlacementMatch }) => {
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
  const label =
    places.length > 1
      ? `${places.slice(0, -1).join(", ")} and ${places.at(-1)}`
      : `${places[0] ?? "Match"} place`;

  const headline: Headline = {
    outcome: key,
    label,
    score: undefined,
    entry,
    game,
    details: [match.mode, formatDuration(match.durationSeconds)],
    friends: byPlacement.flatMap((player) => {
      const friend = friends.get(player.puuid);
      return friend
        ? [
            {
              friend,
              portrait: undefined,
              result: ordinal(player.placement),
              resultTone: player.won ? "text-win" : "text-muted",
            },
          ]
        : [];
    }),
  };
  if (onOpen) return <Summary {...headline} onOpen={onOpen} />;

  return (
    <Entry {...headline}>
      <ul className="grid gap-x-6 md:grid-flow-col md:grid-cols-2 md:grid-rows-4">
        {byPlacement.map((player) => (
          <PlayerRow
            key={player.puuid}
            player={player}
            friend={friends.get(player.puuid)}
            portrait={{
              src: undefined,
              name:
                friends.get(player.puuid)?.discordName ?? playerName(player),
            }}
            mvp={false}
            result={ordinal(player.placement)}
            resultTone={player.won ? "text-win" : "text-muted"}
            game={game}
            onPlayer={onPlayer}
          />
        ))}
      </ul>
    </Entry>
  );
};

const MatchView = (view: View) =>
  view.entry.match.kind === "versus" ? (
    <VersusMatchEntry {...view} match={view.entry.match} />
  ) : (
    <PlacementMatchEntry {...view} match={view.entry.match} />
  );

// a big dialog over the feed; escape, the close button or a click outside
// closes it
const Modal = ({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={label}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(72rem,calc(100vw-2rem))] overflow-y-auto rounded bg-transparent p-0 text-ink backdrop:bg-black/75"
    >
      <div className="relative">
        <button
          type="button"
          onClick={() => dialog.current?.close()}
          title="Close"
          aria-label="Close"
          className="absolute top-3 right-3 rounded p-1.5 text-muted hover:bg-raised hover:text-ink"
        >
          <X aria-hidden className="size-5" />
        </button>
        {children}
      </div>
    </dialog>
  );
};

// a match's line in the feed, opening its full report
export const MatchRow = ({
  entry,
  game,
  onPlayer,
}: {
  entry: FeedMatch;
  game: Game | undefined;
  onPlayer: (discordUserId: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MatchView
        entry={entry}
        game={game}
        onPlayer={onPlayer}
        onOpen={() => setOpen(true)}
      />
      {open && (
        <Modal
          label={`${game?.name ?? "Match"} report`}
          onClose={() => setOpen(false)}
        >
          <MatchView
            entry={entry}
            game={game}
            onPlayer={onPlayer}
            onOpen={undefined}
          />
        </Modal>
      )}
    </>
  );
};
