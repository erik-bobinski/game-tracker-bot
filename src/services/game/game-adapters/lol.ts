import { Effect } from "effect";
import { RiotApiClient } from "../game-api/lol/riot-api-client.ts";
import { ProviderError, ProviderNotFound } from "../game-api/errors.ts";
import {
  AccountNotFound,
  GameApiError,
  RECENT_MATCH_COUNT,
  type GameAdapter,
} from "./index.ts";
import type {
  MatchDetails,
  MatchPlayer,
  MatchTeam,
  Puuid,
  TrackedGameAccount,
} from "../index.ts";
import type { LolLeagueEntry } from "../game-api/lol/match-schema.ts";

export const LOL_REGIONAL_ROUTES = [
  "americas",
  "europe",
  "asia",
  "sea",
] as const;

export const LOL_PLATFORM_ROUTES = [
  "na1",
  "br1",
  "la1",
  "la2",
  "oc1",
  "euw1",
  "eun1",
  "tr1",
  "ru",
  "kr",
  "jp1",
  "ph2",
  "sg2",
  "th2",
  "tw2",
  "vn2",
] as const;

export const lolRegionalRoute = (platform: string): string => {
  if (["na1", "br1", "la1", "la2", "oc1"].includes(platform)) {
    return "americas";
  }
  if (["euw1", "eun1", "tr1", "ru"].includes(platform)) return "europe";
  if (["kr", "jp1"].includes(platform)) return "asia";
  return "sea";
};

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

const compact = (value: number) =>
  value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);

export const lolRankIcons = [
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
  url:
    key === "emerald"
      ? `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/ranked-emblem/emblem-${key}.png`
      : `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/ranked-mini-crests/${key}.png`,
}));

const apiError = (operation: string) =>
  Effect.mapError(
    (cause: ProviderError | ProviderNotFound) =>
      new GameApiError({ game: "lol", operation, cause }),
  );

export const makeLolGameAdapter = Effect.gen(function* () {
  const riotClient = yield* RiotApiClient;

  const resolveAccount = Effect.fn("GameAdapter.lol.resolveAccount")(function* (
    name: string,
    tag: string,
  ) {
    const puuids = yield* Effect.forEach(
      LOL_REGIONAL_ROUTES,
      (regionalRoute) =>
        riotClient.getAccountByRiotId(name, tag, regionalRoute).pipe(
          Effect.map((puuid) => ({ regionalRoute, puuid })),
          Effect.catchTag("ProviderNotFound", () => Effect.succeed(undefined)),
        ),
      { concurrency: 4 },
    ).pipe(apiError("discoverAccountRoute"));
    const account = puuids.find((candidate) => candidate !== undefined);
    if (!account) return yield* new AccountNotFound({ game: "lol" });

    const platforms = yield* Effect.forEach(
      LOL_PLATFORM_ROUTES,
      (platform) =>
        riotClient.getSummonerByPuuid(account.puuid, platform).pipe(
          Effect.as(platform),
          Effect.catchTag("ProviderNotFound", () => Effect.succeed(undefined)),
        ),
      { concurrency: 4 },
    ).pipe(apiError("discoverPlatform"));
    const matches = platforms.filter(
      (platform): platform is (typeof LOL_PLATFORM_ROUTES)[number] =>
        platform !== undefined,
    );
    if (matches.length === 0) {
      return yield* new AccountNotFound({ game: "lol" });
    }
    if (matches.length > 1) {
      return yield* new GameApiError({
        game: "lol",
        operation: "discoverPlatform",
        cause: new Error(
          `PUUID matched multiple platforms: ${matches.join(", ")}`,
        ),
      });
    }
    const route = matches[0];
    if (!route) return yield* new AccountNotFound({ game: "lol" });
    return { puuid: account.puuid, route };
  });

  const getRecentMatches = Effect.fn("GameAdapter.lol.getRecentMatches")(
    function* (account: TrackedGameAccount) {
      const matches = yield* riotClient.getRecentMatches(
        account.puuid,
        RECENT_MATCH_COUNT,
        lolRegionalRoute(account.route),
      );
      return matches.map((match): MatchDetails => {
        const players: Array<MatchPlayer> = match.info.participants.map(
          (participant) => {
            const multiKill =
              participant.largestMultiKill >= 5
                ? "Penta Kill"
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
      });
    },
    (effect) => effect.pipe(apiError("getRecentMatches")),
  );

  const getRanks = Effect.fn("GameAdapter.lol.getRanks")(
    function* (account: TrackedGameAccount) {
      const entries = yield* riotClient.getLeagueEntries(
        account.puuid,
        account.route,
      );
      return entries
        .filter((entry) =>
          ["RANKED_SOLO_5x5", "RANKED_FLEX_SR"].includes(entry.queueType),
        )
        .map((entry) => ({
          label: `${titleCase(entry.tier)} ${entry.rank}`,
          queueLabel:
            entry.queueType === "RANKED_SOLO_5x5"
              ? "Ranked Solo/Duo"
              : "Ranked Flex",
          rankIconKey: entry.tier.toLowerCase(),
          pointsLabel: `${entry.leaguePoints} LP`,
        }));
    },
    (effect) => effect.pipe(apiError("getRanks")),
  );

  const enrichMatch = Effect.fn("GameAdapter.lol.enrichMatch")(
    function* (match: MatchDetails) {
      const queueType =
        match.mode === "Ranked Solo/Duo"
          ? "RANKED_SOLO_5x5"
          : match.mode === "Ranked Flex"
            ? "RANKED_FLEX_SR"
            : undefined;
      const platform = match.routingRegion;
      if (!queueType || !platform) return match;
      const ranks = new Map<Puuid, LolLeagueEntry>();
      yield* Effect.forEach(
        match.players,
        (player) =>
          riotClient.getLeagueEntries(player.puuid, platform).pipe(
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
          const rank = ranks.get(player.puuid);
          return rank
            ? {
                ...player,
                rank: `${titleCase(rank.tier)} ${rank.rank}`,
                rankIconKey: rank.tier.toLowerCase(),
              }
            : player;
        }),
      };
    },
    (effect) => effect.pipe(apiError("enrichMatch")),
  );

  return {
    game: "lol",
    rankIcons: lolRankIcons,
    resolveAccount,
    getRecentMatches,
    getRanks,
    enrichMatch,
  } satisfies GameAdapter;
});
