import { Effect } from "effect";
import { RiotApiClient } from "../game-api/lol/riot-api-client.ts";
import { riotRankDisplay, riotRankIcons } from "../game-api/riot/ranks.ts";
import type {
  TftLeagueEntry,
  TftMatch,
  TftParticipant,
} from "../game-api/tft/match-schema.ts";
import type {
  PlacementMatch,
  PlacementPlayer,
  Puuid,
  RankInfo,
  RankSnapshots,
  RankUpdate,
  Region,
} from "../index.ts";
import {
  GameApiError,
  RECENT_MATCH_COUNT,
  emptyEnrichment,
  logApiWarning,
  type GameAdapter,
} from "./index.ts";

const RANKED_TFT = "RANKED_TFT";

const tftQueue = (
  queueId: number | undefined,
  gameType: string | undefined,
) => {
  const named = new Map<number, string>([
    [1090, "Normal TFT"],
    [1100, "Ranked TFT"],
    [1130, "Hyper Roll"],
    [1160, "Double Up"],
  ]);
  if (queueId !== undefined) {
    const known = named.get(queueId);
    if (known) return known;
  }
  const trimmed = gameType?.trim();
  if (trimmed)
    return trimmed
      .replaceAll("_", " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  return "TFT";
};

const shardFromMatchId = (matchId: string) => {
  const separator = matchId.indexOf("_");
  if (separator <= 0) return undefined;
  return matchId.slice(0, separator).toLowerCase();
};

const tftStat = (participant: TftParticipant) => {
  const parts: Array<string> = [];
  if (typeof participant.level === "number") {
    parts.push(`Level ${participant.level}`);
  }
  if (typeof participant.total_damage_to_players === "number") {
    parts.push(`${participant.total_damage_to_players} player dmg`);
  }
  return parts.join(" · ");
};

const rankedTftEntry = (entries: ReadonlyArray<TftLeagueEntry>) => {
  const entry = entries.find((candidate) => candidate.queueType === RANKED_TFT);
  if (
    entry === undefined ||
    entry.tier == null ||
    entry.rank == null ||
    entry.leaguePoints == null
  ) {
    return undefined;
  }
  return {
    tier: entry.tier,
    rank: entry.rank,
    leaguePoints: entry.leaguePoints,
    wins: entry.wins,
    losses: entry.losses,
  };
};

type RankedTft = NonNullable<ReturnType<typeof rankedTftEntry>>;

const tftStanding = (entry: { tier: string; rank: string }) =>
  `${entry.tier} ${entry.rank}`;

export const tftMatchToDetails = (match: TftMatch): PlacementMatch => {
  const rawQueueId = match.info.queueId ?? match.info.queue_id;
  const queueId = rawQueueId == null ? undefined : rawQueueId;
  const gameType = match.info.tft_game_type ?? undefined;
  const routingRegion = shardFromMatchId(match.metadata.match_id);
  const players: Array<PlacementPlayer> = match.info.participants.map(
    (participant) => ({
      puuid: participant.puuid,
      riotName: participant.riotIdGameName,
      riotTag: participant.riotIdTagline,
      placement: participant.placement,
      stat: tftStat(participant),
    }),
  );

  return {
    kind: "placement",
    matchId: match.metadata.match_id,
    game: "tft",
    date: match.info.game_datetime,
    mode: tftQueue(queueId, gameType ?? undefined),
    ...(routingRegion ? { routingRegion } : {}),
    durationSeconds: Math.floor(match.info.game_length),
    players,
  };
};

export const makeTftGameAdapter = Effect.gen(function* () {
  const riotClient = yield* RiotApiClient;

  const adapter: GameAdapter = {
    game: "tft",
    requiresMatchHistory: true,
    rankIcons: riotRankIcons,
    resolveAccount: Effect.fn("GameAdapter.tft.resolveAccount")(function* (
      name: string,
      tag: string,
    ) {
      const puuid = yield* riotClient.getAccountByRiotId(name, tag);
      const region = yield* riotClient.getPlatformId("tft", puuid);
      return { puuid, region };
    }),
    getRecentMatches: Effect.fn("GameAdapter.tft.getRecentMatches")(
      function* (puuid: Puuid, region: Region | undefined) {
        const matches = yield* riotClient.getTftRecentMatches(
          puuid,
          region,
          RECENT_MATCH_COUNT,
        );
        return matches.map(tftMatchToDetails);
      },
      Effect.mapError(
        (cause) =>
          new GameApiError({
            game: "tft",
            operation: "getRecentMatches",
            cause,
          }),
      ),
    ),
    enrichMatch: Effect.fn("GameAdapter.tft.enrichMatch")(function* ({
      match,
      trackedPlayers,
    }) {
      if (match.kind !== "placement") return emptyEnrichment(match);
      if (match.mode !== "Ranked TFT") return emptyEnrichment(match);
      const platformId = match.routingRegion;
      if (!platformId) return emptyEnrichment(match);

      const ranks = new Map<Puuid, RankedTft>();
      yield* Effect.forEach(
        match.players,
        (player) =>
          riotClient.getTftLeagueEntries(player.puuid, platformId).pipe(
            Effect.map((entries) => {
              const entry = rankedTftEntry(entries);
              if (entry) ranks.set(player.puuid, entry);
            }),
            Effect.catch((error) =>
              logApiWarning("rank unavailable for tft player", error).pipe(
                Effect.annotateLogs({ puuid: player.puuid }),
              ),
            ),
          ),
        { concurrency: 3 },
      );

      const rankUpdates = new Map<Puuid, RankUpdate>();
      const updatedRankSnapshots = new Map<Puuid, RankSnapshots>();
      for (const tracked of trackedPlayers) {
        const entry = ranks.get(tracked.puuid);
        if (!entry) continue;
        const standing = tftStanding(entry);
        const { label } = riotRankDisplay(entry);
        const previous = tracked.previousRankSnapshots[RANKED_TFT];
        const comparable = previous?.standing === standing;
        rankUpdates.set(tracked.puuid, {
          ...(comparable
            ? { delta: entry.leaguePoints - previous.points }
            : {}),
          current: comparable ? label : `${label} (${entry.leaguePoints} LP)`,
          unit: "LP",
        });
        updatedRankSnapshots.set(tracked.puuid, {
          ...tracked.previousRankSnapshots,
          [RANKED_TFT]: { standing, points: entry.leaguePoints },
        });
      }

      return {
        match: {
          ...match,
          players: match.players.map((player) => {
            const entry = ranks.get(player.puuid);
            if (!entry) return player;
            const { iconKey, division, label } = riotRankDisplay(entry);
            return {
              ...player,
              rank: label,
              rankIconKey: iconKey,
              ...(division ? { rankDivision: division } : {}),
            };
          }),
        },
        rankUpdates,
        updatedRankSnapshots,
      };
    }),
    getRank: Effect.fn("GameAdapter.tft.getRank")(
      function* (puuid: Puuid, region: Region | undefined) {
        if (!region) {
          yield* Effect.logWarning("no stored platformId for tft rank lookup");
          return undefined;
        }

        const entry = rankedTftEntry(
          yield* riotClient.getTftLeagueEntries(puuid, region),
        );
        if (!entry) return undefined;

        const { iconKey, label } = riotRankDisplay(entry);
        return {
          tier: label,
          detail: `${entry.leaguePoints} LP · ${entry.wins}W ${entry.losses}L`,
          iconKey,
        } satisfies RankInfo;
      },
      Effect.mapError(
        (cause) =>
          new GameApiError({ game: "tft", operation: "getRank", cause }),
      ),
    ),
  };

  return adapter;
});
