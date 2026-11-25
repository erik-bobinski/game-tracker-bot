// One reported match, drawn from its data rather than the Discord card's
// image, so every name and number is text: selectable, searchable, linkable.
// Verdicts and wording come from the same helpers the Discord report uses.

import { ChevronDown } from "lucide-react";
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

const spine = {
  win: "bg-win",
  loss: "bg-loss",
  draw: "bg-draw",
  unknown: "bg-faint",
} as const satisfies Record<Outcome, string>;

const teamOutcome = (team: MatchTeam): Outcome =>
  team.won === undefined ? "draw" : team.won ? "win" : "loss";

const teamWords = { win: "won", loss: "lost", draw: "drew", unknown: "" };

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const fullDate = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

const ago = (date: number) => {
  const minutes = Math.round((date - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, "hour");
  return relative.format(Math.round(hours / 24), "day");
};

const deltaText = (update: RankUpdate | null) =>
  update?.delta === undefined
    ? undefined
    : `${update.delta > 0 ? "+" : update.delta < 0 ? "−" : "±"}${Math.abs(update.delta)} ${update.unit}`;

const Portrait = ({
  src,
  name,
  size,
}: {
  src: string | undefined;
  name: string;
  size: "large" | "small";
}) => {
  const box = size === "large" ? "size-10 rounded-md" : "size-6 rounded";
  return src ? (
    <img src={src} alt="" loading="lazy" className={`${box} bg-raised`} />
  ) : (
    <span
      aria-hidden
      className={`${box} grid place-items-center bg-raised text-xs font-semibold text-muted`}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
};

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
  const key = change?.to.iconKey ?? player.rankIconKey;
  const icon = game?.rankIcons.find((rank) => rank.key === key)?.url;
  const label = change ? change.to.tier : player.rank;
  const delta = deltaText(update);
  if (!label && !delta)
    return <span className="text-sm text-faint">Unranked</span>;
  return (
    <span className="flex items-center gap-1.5 text-sm">
      {icon && <img src={icon} alt="" className="size-5" loading="lazy" />}
      {label && <span>{label}</span>}
      {delta && (
        <span
          className={
            (update?.delta ?? 0) > 0
              ? "text-win"
              : (update?.delta ?? 0) < 0
                ? "text-loss"
                : "text-muted"
          }
        >
          {delta}
        </span>
      )}
      {change && (
        <span className={change.promoted ? "text-win" : "text-loss"}>
          {change.promoted ? "promoted" : "demoted"}
        </span>
      )}
    </span>
  );
};

const Flairs = ({
  flairs,
  mvp,
}: {
  flairs: ReadonlyArray<string>;
  mvp: boolean;
}) =>
  mvp || flairs.length > 0 ? (
    <span className="flex gap-1">
      {mvp && (
        <span className="rounded bg-friend/15 px-1.5 text-xs font-semibold text-friend">
          MVP
        </span>
      )}
      {flairs.map((flair) => (
        <span
          key={flair}
          className="rounded bg-raised px-1.5 text-xs font-semibold text-ink"
        >
          {flair}
        </span>
      ))}
    </span>
  ) : null;

// a tracked player's line: who they are, how they did, where their rank went
const FriendRow = ({
  friend,
  player,
  game,
  result,
  portrait,
  character,
  mvp,
  onPlayer,
}: {
  friend: Friend;
  player: MatchPlayerIdentity;
  game: Game | undefined;
  result: React.ReactNode;
  portrait: string | undefined;
  character: string | undefined;
  mvp: boolean;
  onPlayer: (discordUserId: string) => void;
}) => (
  <li className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[2.5rem_minmax(0,1fr)_9rem_minmax(10rem,auto)]">
    <Portrait
      src={portrait}
      name={character ?? friend.discordName}
      size="large"
    />
    <div className="min-w-0">
      <p className="flex flex-wrap items-center gap-x-2">
        <button
          type="button"
          onClick={() => onPlayer(friend.discordUserId)}
          title={`Show only ${friend.discordName}'s matches`}
          className="font-semibold text-friend decoration-2 underline-offset-4 hover:underline"
        >
          {friend.discordName}
        </button>
        <Flairs flairs={player.flairs ?? []} mvp={mvp} />
      </p>
      <p className="truncate text-sm text-muted">
        {player.riotName}#{player.riotTag}
        {character ? `, ${character}` : ""}
      </p>
    </div>
    <div className="text-right">{result}</div>
    <div className="col-span-full pl-[3.25rem] sm:col-span-1 sm:pl-0">
      <Rank player={player} update={friend.rankUpdate} game={game} />
    </div>
  </li>
);

const Stat = ({ value, detail }: { value: string; detail: string }) => (
  <>
    <p className="font-score text-2xl leading-none font-semibold tabular-nums">
      {value}
    </p>
    {detail && <p className="mt-1 text-xs text-muted">{detail}</p>}
  </>
);

const Lobby = ({
  count,
  children,
}: {
  count: number;
  children: React.ReactNode;
}) => (
  <details className="group mt-4 border-t border-line pt-3">
    <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
      <ChevronDown
        aria-hidden
        className="size-4 transition-transform group-open:rotate-180"
      />
      Full lobby, {count} players
    </summary>
    <div className="mt-3">{children}</div>
  </details>
);

const VersusMatchEntry = ({
  entry,
  match,
  game,
  onPlayer,
}: {
  entry: FeedMatch;
  match: VersusMatch;
  game: Game | undefined;
  onPlayer: (discordUserId: string) => void;
}) => {
  const rankUpdates = new Map(
    entry.players.flatMap((friend) =>
      friend.rankUpdate ? [[friend.puuid, friend.rankUpdate] as const] : [],
    ),
  );
  const { key, verdict, trackedTeam, teams } = matchVerdict({
    tracked: entry.players,
    match,
    rankUpdates,
  });
  const friends = new Map(
    entry.players.map((friend) => [friend.puuid, friend]),
  );
  const mvp = [...match.players].sort((a, b) => b.sortKey - a.sortKey)[0]
    ?.puuid;

  return (
    <Entry
      outcome={key}
      label={verdict.label}
      score={trackedTeam?.score}
      entry={entry}
      game={game}
      details={[
        match.map ? `${match.mode} on ${match.map}` : match.mode,
        formatDuration(match.durationSeconds),
        match.surrendered ? "ended by surrender" : undefined,
      ]}
    >
      <ul className="mt-4 space-y-3">
        {entry.players.flatMap((friend) => {
          const player = match.players.find((p) => p.puuid === friend.puuid);
          return player
            ? [
                <FriendRow
                  key={friend.discordUserId}
                  friend={friend}
                  player={player}
                  game={game}
                  portrait={player.characterIconUrl}
                  character={player.character}
                  mvp={player.puuid === mvp}
                  onPlayer={onPlayer}
                  result={
                    <Stat
                      value={`${player.kills} / ${player.deaths} / ${player.assists}`}
                      detail={player.stat}
                    />
                  }
                />,
              ]
            : [];
        })}
      </ul>
      <Lobby count={match.players.length}>
        <div className="grid gap-5 md:grid-cols-2">
          {teams.map((team, index) => {
            const players = match.players.filter((p) => p.team === team.id);
            const outcome = teamOutcome(team);
            return (
              <table key={team.id} className="w-full text-sm">
                <caption className="mb-2 text-left">
                  <span className="font-semibold">{teamLabel(index)}</span>{" "}
                  <span className={tone[outcome]}>{teamWords[outcome]}</span>
                  <span className="text-muted">
                    , {players.reduce((kills, p) => kills + p.kills, 0)} kills
                  </span>
                </caption>
                <thead className="sr-only">
                  <tr>
                    <th>Player</th>
                    <th>Kills, deaths and assists</th>
                    <th>Rank</th>
                  </tr>
                </thead>
                <tbody>
                  {players.map((player) => {
                    const friend = friends.get(player.puuid);
                    return (
                      <tr
                        key={player.puuid}
                        className={friend ? "bg-friend/8" : undefined}
                      >
                        <td className="py-1 pr-2">
                          <span className="flex min-w-0 items-center gap-2">
                            <Portrait
                              src={player.characterIconUrl}
                              name={player.character}
                              size="small"
                            />
                            <span
                              className={`truncate ${friend ? "font-semibold text-friend" : ""}`}
                            >
                              {playerName(player)}
                            </span>
                          </span>
                        </td>
                        <td className="py-1 pr-2 text-right tabular-nums whitespace-nowrap">
                          {player.kills} / {player.deaths} / {player.assists}
                        </td>
                        <td className="py-1">
                          <Rank
                            player={player}
                            update={friend?.rankUpdate ?? null}
                            game={game}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            );
          })}
        </div>
      </Lobby>
    </Entry>
  );
};

const PlacementMatchEntry = ({
  entry,
  match,
  game,
  onPlayer,
}: {
  entry: FeedMatch;
  match: PlacementMatch;
  game: Game | undefined;
  onPlayer: (discordUserId: string) => void;
}) => {
  const { key, trackedPuuids } = placementVerdict({
    tracked: entry.players,
    match,
    rankUpdates: new Map(),
  });
  const tracked = match.players.filter((p) => trackedPuuids.has(p.puuid));
  const primary = tracked.length === 1 ? tracked[0] : undefined;
  const friends = new Map(
    entry.players.map((friend) => [friend.puuid, friend]),
  );
  const byPlacement = [...match.players].sort(
    (a, b) => a.placement - b.placement,
  );

  return (
    <Entry
      outcome={key}
      label={
        primary
          ? `${ordinal(primary.placement)} place`
          : // every friend's place, best first: "1st and 4th"
            tracked
              .map((p) => p.placement)
              .sort((a, b) => a - b)
              .map(ordinal)
              .join(", ")
              .replace(/, ([^,]*)$/, " and $1")
      }
      score={undefined}
      entry={entry}
      game={game}
      details={[match.mode, formatDuration(match.durationSeconds)]}
    >
      <ul className="mt-4 space-y-3">
        {entry.players.flatMap((friend) => {
          const player = match.players.find((p) => p.puuid === friend.puuid);
          return player
            ? [
                <FriendRow
                  key={friend.discordUserId}
                  friend={friend}
                  player={player}
                  game={game}
                  portrait={undefined}
                  character={undefined}
                  mvp={false}
                  onPlayer={onPlayer}
                  result={
                    <Stat
                      value={ordinal(player.placement)}
                      detail={player.stat}
                    />
                  }
                />,
              ]
            : [];
        })}
      </ul>
      <Lobby count={match.players.length}>
        <table className="w-full text-sm">
          <thead className="sr-only">
            <tr>
              <th>Place</th>
              <th>Player</th>
              <th>Result</th>
              <th>Rank</th>
            </tr>
          </thead>
          <tbody>
            {byPlacement.map((player) => {
              const friend = friends.get(player.puuid);
              return (
                <tr
                  key={player.puuid}
                  className={friend ? "bg-friend/8" : undefined}
                >
                  <td
                    className={`w-10 py-1 font-score text-lg font-semibold tabular-nums ${player.won ? "text-win" : "text-muted"}`}
                  >
                    {ordinal(player.placement)}
                  </td>
                  <td
                    className={`py-1 pr-2 ${friend ? "font-semibold text-friend" : ""}`}
                  >
                    {playerName(player)}
                  </td>
                  <td className="py-1 pr-2 text-muted">{player.stat}</td>
                  <td className="py-1">
                    <Rank
                      player={player}
                      update={friend?.rankUpdate ?? null}
                      game={game}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Lobby>
    </Entry>
  );
};

// the frame every match shares: the verdict spine, headline and when
const Entry = ({
  outcome,
  label,
  score,
  entry,
  game,
  details,
  children,
}: {
  outcome: Outcome;
  label: string;
  score: readonly [number, number] | undefined;
  entry: FeedMatch;
  game: Game | undefined;
  details: ReadonlyArray<string | undefined>;
  children: React.ReactNode;
}) => (
  <article className="relative overflow-hidden rounded-lg bg-surface py-4 pr-4 pl-6 sm:pr-6 sm:pl-8">
    <span
      aria-hidden
      className={`absolute inset-y-0 left-0 w-1.5 ${spine[outcome]}`}
    />
    <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
      <h2 className="flex items-baseline gap-3 font-score leading-none font-bold">
        <span className={`text-4xl ${tone[outcome]}`}>{label}</span>
        {score && (
          <span className="text-4xl font-semibold tabular-nums">
            {score[0]}–{score[1]}
          </span>
        )}
      </h2>
      <time
        dateTime={new Date(entry.playedAt).toISOString()}
        title={fullDate.format(entry.playedAt)}
        className="text-sm text-muted"
      >
        {ago(entry.playedAt)}
      </time>
    </header>
    <p className="mt-2 flex items-center gap-2 text-sm text-muted">
      {game && <img src={game.iconUrl} alt="" className="size-4 rounded-sm" />}
      <span>{[game?.name, ...details].filter(Boolean).join(", ")}</span>
    </p>
    {children}
  </article>
);

export const MatchEntry = ({
  entry,
  game,
  onPlayer,
}: {
  entry: FeedMatch;
  game: Game | undefined;
  onPlayer: (discordUserId: string) => void;
}) =>
  entry.match.kind === "versus" ? (
    <VersusMatchEntry
      entry={entry}
      match={entry.match}
      game={game}
      onPlayer={onPlayer}
    />
  ) : (
    <PlacementMatchEntry
      entry={entry}
      match={entry.match}
      game={game}
      onPlayer={onPlayer}
    />
  );
