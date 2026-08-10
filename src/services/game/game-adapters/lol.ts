import { Effect } from "effect";
import { RiotApiClient } from "../game-api/lol/riot-api-client.ts";
import { GameApiError, RECENT_MATCH_COUNT, type GameAdapter } from "./index.ts";
import type {
  MatchDetails,
  MatchPlayer,
  MatchTeam,
  Puuid,
  RankInfo,
  Region,
} from "../index.ts";
import type {
  LolLeagueEntry,
  LolMatch,
} from "../game-api/lol/match-schema.ts";

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

const titleCase = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();

// the apex tiers only ever sit in division I, which riot's own client omits
const APEX_TIERS = new Set(["master", "grandmaster", "challenger"]);

const lolRank = (entry: LolLeagueEntry) => {
  const iconKey = entry.tier.toLowerCase();
  const division = APEX_TIERS.has(iconKey) ? undefined : entry.rank;
  return {
    iconKey,
    division,
    label: division ? `${titleCase(entry.tier)} ${division}` : titleCase(entry.tier),
  };
};

const compact = (value: number) =>
  value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);

const STATIC_ASSETS =
  "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default";

const rankIcons = [
  "iron",
  "bronze",
  "silver",
  "gold",
  "platinum",
  "emerald",
  "diamond",
  "master",
  "grandmaster",
  "challenger",
].map((key) => ({
  key,
  // the winged emblems shrink to an unreadable smudge at emoji size, so use
  // the mini crests; riot ships emerald's as svg only, so it is rasterized
  url:
    key === "emerald"
      ? new URL("../../../../assets/rank-lol-emerald.png", import.meta.url).href
      : `${STATIC_ASSETS}/images/ranked-mini-crests/${key}.png`,
  largeUrl: `${STATIC_ASSETS}/ranked-emblem/emblem-${key}.png`,
}));

export const lolMatchToDetails = (match: LolMatch): MatchDetails => {
  const players: Array<MatchPlayer> = match.info.participants.map(
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
        thumbnailUrl: `https://cdn.communitydragon.org/latest/champion/${encodeURIComponent(participant.championName)}/square`,
      };
    },
  );

  const teams: Array<MatchTeam> = [100, 200].map((teamId) => ({
    id: String(teamId),
    won:
      match.info.participants.find(
        (participant) => participant.teamId === teamId,
      )?.win ?? false,
  }));

  return {
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
    rankIcons,
    resolveAccount: Effect.fn("GameAdapter.lol.resolveAccount")(function* (
      name: string,
      tag: string,
    ) {
      const puuid = yield* riotClient.getAccountByRiotId(name, tag);
      // the account resolves fine without a shard; only rank lookups need it
      const region = yield* riotClient
        .getPlatformId(puuid)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("lol platformId lookup failed", error).pipe(
              Effect.as(undefined),
            ),
          ),
        );
      return { puuid, region };
    }),
    getRecentMatches: Effect.fn("GameAdapter.lol.getRecentMatches")(
      function* (puuid: Puuid, region: Region | undefined) {
        const matches = yield* riotClient.getRecentMatches(
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
    enrichMatch: Effect.fn("GameAdapter.lol.enrichMatch")(
      function* (match: MatchDetails) {
        const queueType =
          match.mode === "Ranked Solo/Duo"
            ? "RANKED_SOLO_5x5"
            : match.mode === "Ranked Flex"
              ? "RANKED_FLEX_SR"
              : undefined;
        if (!queueType) return match;

        const platformId = match.routingRegion;
        if (!platformId) return match;

        const ranks = new Map<Puuid, LolLeagueEntry>();
        yield* Effect.forEach(
          match.players,
          (player) =>
            riotClient.getLeagueEntries(player.puuid, platformId).pipe(
              Effect.map((entries) => {
                const entry = entries.find(
                  (candidate) => candidate.queueType === queueType,
                );
                if (entry) ranks.set(player.puuid, entry);
              }),
              Effect.catch((error) =>
                Effect.logWarning("rank unavailable for lol player").pipe(
                  Effect.annotateLogs({ puuid: player.puuid, error }),
                ),
              ),
            ),
          { concurrency: 3 },
        );

        return {
          ...match,
          players: match.players.map((player) => {
            const entry = ranks.get(player.puuid);
            if (!entry) return player;
            const { iconKey, division, label } = lolRank(entry);
            return {
              ...player,
              rank: label,
              rankIconKey: iconKey,
              ...(division ? { rankDivision: division } : {}),
            };
          }),
        };
      },
      Effect.mapError(
        (cause) =>
          new GameApiError({
            game: "lol",
            operation: "enrichMatch",
            cause,
          }),
      ),
    ),
    getRank: Effect.fn("GameAdapter.lol.getRank")(
      function* (puuid: Puuid, region: Region | undefined) {
        // league-v4 is shard-routed, so an unknown shard means no rank
        if (!region) {
          yield* Effect.logWarning("no stored platformId for lol rank lookup");
          return undefined;
        }

        const entries = yield* riotClient.getLeagueEntries(puuid, region);
        const entry =
          entries.find((e) => e.queueType === "RANKED_SOLO_5x5") ??
          entries.find((e) => e.queueType === "RANKED_FLEX_SR");
        if (!entry) return undefined;

        const queue =
          entry.queueType === "RANKED_SOLO_5x5" ? "Solo/Duo" : "Flex";
        const { iconKey, label } = lolRank(entry);
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
