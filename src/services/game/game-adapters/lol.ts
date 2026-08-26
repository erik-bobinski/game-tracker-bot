import { Effect } from "effect";
import { RiotApiClient } from "../game-api/lol/riot-api-client.ts";
import { riotRankDisplay, riotRankIcons } from "../game-api/riot/ranks.ts";
import {
  GameApiError,
  RECENT_MATCH_COUNT,
  emptyEnrichment,
  logApiWarning,
  type GameAdapter,
} from "./index.ts";
import type {
  Puuid,
  RankInfo,
  RankSnapshots,
  RankUpdate,
  Region,
  VersusMatch,
  VersusPlayer,
} from "../index.ts";
import type { LolLeagueEntry, LolMatch } from "../game-api/lol/match-schema.ts";

const queue = (queueId: number, gameMode: string) =>
  new Map<number, string>([
    [400, "Normal Draft"],
    [420, "Ranked Solo/Duo"],
    [430, "Normal Blind"],
    [440, "Ranked Flex"],
    [450, "ARAM"],
    [480, "Swiftplay"],
    [490, "Quickplay"],
    [700, "Clash"],
    [900, "URF"],
    [1020, "One for All"],
    [1300, "Nexus Blitz"],
    [1700, "Arena"],
    [1710, "Arena"],
    [1900, "URF"],
  ]).get(queueId) ?? gameMode;

const lolStanding = (entry: LolLeagueEntry) => `${entry.tier} ${entry.rank}`;

const compact = (value: number) =>
  value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);

export const lolMatchToDetails = (match: LolMatch): VersusMatch => {
  const players: Array<VersusPlayer> = match.info.participants.map(
    (participant) => {
      const multiKill =
        participant.largestMultiKill >= 5
          ? "🔥 Penta Kill"
          : participant.largestMultiKill === 4
            ? "Quadra Kill"
            : undefined;
      return {
        puuid: participant.puuid,
        team: String(participant.teamId),
        riotName: participant.riotIdGameName,
        riotTag: participant.riotIdTagline,
        character: participant.championName,
        kills: participant.kills,
        deaths: participant.deaths,
        assists: participant.assists,
        stat: `${participant.totalMinionsKilled + participant.neutralMinionsKilled} CS · ${compact(participant.totalDamageDealtToChampions)} dmg`,
        sortKey:
          (participant.kills + participant.assists) /
          Math.max(participant.deaths, 1),
        ...(multiKill ? { flair: multiKill } : {}),
      };
    },
  );

  const teams = [100, 200].map((teamId) => ({
    id: String(teamId),
    won:
      match.info.participants.find(
        (participant) => participant.teamId === teamId,
      )?.win ?? false,
  }));

  return {
    kind: "versus",
    matchId: match.metadata.matchId,
    game: "lol",
    date: match.info.gameStartTimestamp,
    mode: queue(match.info.queueId, match.info.gameMode),
    routingRegion: match.info.platformId.toLowerCase(),
    durationSeconds: match.info.gameDuration,
    surrendered: match.info.participants.some(
      (participant) => participant.gameEndedInSurrender,
    ),
    players,
    teams,
  };
};

export const makeLolGameAdapter = Effect.gen(function* () {
  const riotClient = yield* RiotApiClient;

  const adapter: GameAdapter = {
    game: "lol",
    requiresMatchHistory: false,
    rankIcons: riotRankIcons,
    resolveAccount: Effect.fn("GameAdapter.lol.resolveAccount")(function* (
      name: string,
      tag: string,
    ) {
      const puuid = yield* riotClient.getAccountByRiotId(name, tag);
      // the account resolves fine without a shard; only rank lookups need it
      const region = yield* riotClient
        .getPlatformId("lol", puuid)
        .pipe(
          Effect.catch((error) =>
            logApiWarning("lol platformId lookup failed", error).pipe(
              Effect.as(undefined),
            ),
          ),
        );
      return { puuid, region };
    }),
    getRecentMatches: Effect.fn("GameAdapter.lol.getRecentMatches")(
      function* (puuid: Puuid, region: Region | undefined) {
        const matches = yield* riotClient.getLolRecentMatches(
          puuid,
          region,
          RECENT_MATCH_COUNT,
        );
        return matches.map(lolMatchToDetails);
      },
      Effect.mapError(
        (cause) =>
          new GameApiError({
            game: "lol",
            operation: "getRecentMatches",
            cause,
          }),
      ),
    ),
    enrichMatch: Effect.fn("GameAdapter.lol.enrichMatch")(function* ({
      match,
      trackedPlayers,
    }) {
      if (match.kind !== "versus") return emptyEnrichment(match);
      const queueType =
        match.mode === "Ranked Solo/Duo"
          ? "RANKED_SOLO_5x5"
          : match.mode === "Ranked Flex"
            ? "RANKED_FLEX_SR"
            : undefined;
      const platformId = match.routingRegion;
      if (!queueType || !platformId) return emptyEnrichment(match);

      const ranks = new Map<Puuid, LolLeagueEntry>();
      yield* Effect.forEach(
        match.players,
        (player) =>
          riotClient.getLolLeagueEntries(player.puuid, platformId).pipe(
            Effect.map((entries) => {
              const entry = entries.find(
                (candidate) => candidate.queueType === queueType,
              );
              if (entry) ranks.set(player.puuid, entry);
            }),
            Effect.catch((error) =>
              logApiWarning("rank unavailable for lol player", error).pipe(
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
        const standing = lolStanding(entry);
        const { label } = riotRankDisplay(entry);
        // a delta only means anything within the same tier and division
        const previous = tracked.previousRankSnapshots[queueType];
        const comparable = previous?.standing === standing;
        rankUpdates.set(tracked.puuid, {
          ...(comparable
            ? { delta: entry.leaguePoints - previous.points }
            : {}),
          // "·" already separates the report's fields, so keep LP parenthesised
          current: comparable ? label : `${label} (${entry.leaguePoints} LP)`,
          unit: "LP",
        });
        updatedRankSnapshots.set(tracked.puuid, {
          ...tracked.previousRankSnapshots,
          [queueType]: { standing, points: entry.leaguePoints },
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
    getRank: Effect.fn("GameAdapter.lol.getRank")(
      function* (puuid: Puuid, region: Region | undefined) {
        // league-v4 is shard-routed, so an unknown shard means no rank
        if (!region) {
          yield* Effect.logWarning("no stored platformId for lol rank lookup");
          return undefined;
        }

        const entries = yield* riotClient.getLolLeagueEntries(puuid, region);
        const entry =
          entries.find((e) => e.queueType === "RANKED_SOLO_5x5") ??
          entries.find((e) => e.queueType === "RANKED_FLEX_SR");
        if (!entry) return undefined;

        const queue =
          entry.queueType === "RANKED_SOLO_5x5" ? "Solo/Duo" : "Flex";
        const { iconKey, label } = riotRankDisplay(entry);
        return {
          tier: label,
          detail: `${entry.leaguePoints} LP · ${entry.wins}W ${entry.losses}L (${queue})`,
          iconKey,
        } satisfies RankInfo;
      },
      Effect.mapError(
        (cause) =>
          new GameApiError({ game: "lol", operation: "getRank", cause }),
      ),
    ),
  };

  return adapter;
});
