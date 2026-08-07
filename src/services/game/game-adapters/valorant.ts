import { Effect } from "effect";
import { HenrikApiClient } from "../game-api/val/henrik-api-client.ts";
import { ProviderError, ProviderNotFound } from "../game-api/errors.ts";
import {
  AccountNotFound,
  GameApiError,
  RECENT_MATCH_COUNT,
  type GameAdapter,
} from "./index.ts";
import {
  EpochMillis,
  type MatchDetails,
  type MatchPlayer,
  type MatchTeam,
  type TrackedGameAccount,
} from "../index.ts";
import { valMatchMode } from "../game-api/val/match-schema.ts";

const rankIconKey = (rank: string) => {
  const key = rank.toLowerCase().replaceAll(" ", "_");
  return key && key !== "unrated" ? key : undefined;
};

const valorantTierSet = "03621f52-342b-cf4e-4f86-9350a49c6d04";
export const valorantRankIcons = [
  ["iron", 3],
  ["bronze", 6],
  ["silver", 9],
  ["gold", 12],
  ["platinum", 15],
  ["diamond", 18],
  ["ascendant", 21],
  ["immortal", 24],
]
  .flatMap(([tier, firstLevel]) =>
    [1, 2, 3].map((division, offset) => ({
      key: `${tier}_${division}`,
      url: `https://media.valorant-api.com/competitivetiers/${valorantTierSet}/${Number(firstLevel) + offset}/smallicon.png`,
    })),
  )
  .concat({
    key: "radiant",
    url: `https://media.valorant-api.com/competitivetiers/${valorantTierSet}/27/smallicon.png`,
  });

const apiError = (operation: string) =>
  Effect.mapError((cause: ProviderError | ProviderNotFound | GameApiError) =>
    cause._tag === "GameApiError"
      ? cause
      : new GameApiError({ game: "valorant", operation, cause }),
  );

const splitRoute = (route: string) => {
  const [region, platform] = route.split("/");
  return region && platform ? { region, platform } : undefined;
};

export const makeValorantGameAdapter = Effect.gen(function* () {
  const henrikClient = yield* HenrikApiClient;

  const resolveAccount = Effect.fn("GameAdapter.valorant.resolveAccount")(
    function* (name: string, tag: string) {
      const account = yield* henrikClient.getAccountByRiotId(name, tag).pipe(
        Effect.mapError((error) =>
          error._tag === "ProviderNotFound"
            ? new AccountNotFound({ game: "valorant" })
            : new GameApiError({
                game: "valorant",
                operation: "resolveAccount",
                cause: error,
              }),
        ),
      );
      const normalized = account.platforms.map((platform) =>
        platform.toLowerCase(),
      );
      const platform = normalized.includes("pc")
        ? "pc"
        : normalized.includes("console")
          ? "console"
          : undefined;
      if (!platform) {
        return yield* new GameApiError({
          game: "valorant",
          operation: "resolveAccount",
          cause: new Error(
            "Henrik account response contained no supported platform",
          ),
        });
      }
      return {
        puuid: account.puuid,
        route: `${account.region.toLowerCase()}/${platform}`,
      };
    },
  );

  const getRecentMatches = Effect.fn("GameAdapter.valorant.getRecentMatches")(
    function* (account: TrackedGameAccount) {
      const route = splitRoute(account.route);
      if (!route) {
        return yield* new GameApiError({
          game: "valorant",
          operation: "getRecentMatches",
          cause: new Error(`Invalid Valorant route: ${account.route}`),
        });
      }
      const matches = yield* henrikClient.getRecentMatches(
        account.puuid,
        RECENT_MATCH_COUNT,
        route.region,
        route.platform,
      );
      const candidates: Array<MatchDetails> = [];
      for (const match of matches) {
        if (!match.metadata.is_completed) continue;
        const rounds = Math.max(match.rounds.length, 1);
        const players: Array<MatchPlayer> = match.players.map((player) => {
          const shots =
            player.stats.headshots +
            player.stats.bodyshots +
            player.stats.legshots;
          const acs = Math.floor(player.stats.score / rounds);
          const iconKey = rankIconKey(player.tier.name);
          return {
            puuid: player.puuid,
            team: player.team_id.toLowerCase(),
            riotName: player.name,
            riotTag: player.tag,
            character: player.agent.name,
            kills: player.stats.kills,
            deaths: player.stats.deaths,
            assists: player.stats.assists,
            stat:
              shots > 0
                ? `${acs} ACS · ${Math.floor((player.stats.headshots * 100) / shots)}% HS`
                : `${acs} ACS`,
            sortKey: acs,
            ...(player.tier.name && player.tier.name !== "Unrated"
              ? { rank: player.tier.name }
              : {}),
            ...(iconKey ? { rankIconKey: iconKey } : {}),
            thumbnailUrl: `https://media.valorant-api.com/agents/${encodeURIComponent(player.agent.id)}/displayicon.png`,
          };
        });
        const teams: Array<MatchTeam> = match.teams.map((team) => ({
          id: team.team_id.toLowerCase(),
          won: team.won,
          score: [team.rounds.won, team.rounds.lost],
        }));
        candidates.push({
          matchId: match.metadata.match_id,
          game: "valorant",
          date: EpochMillis.make(Date.parse(match.metadata.started_at)),
          mode: valMatchMode(match.metadata),
          map: match.metadata.map.name,
          durationSeconds: Math.floor(match.metadata.game_length_in_ms / 1_000),
          surrendered: match.rounds.some(
            (round) => round.result.toLowerCase() === "surrendered",
          ),
          players,
          teams,
        });
      }
      return candidates;
    },
    (effect) => effect.pipe(apiError("getRecentMatches")),
  );

  const getRanks = Effect.fn("GameAdapter.valorant.getRanks")(
    function* (account: TrackedGameAccount) {
      const route = splitRoute(account.route);
      if (!route) {
        return yield* new GameApiError({
          game: "valorant",
          operation: "getRanks",
          cause: new Error(`Invalid Valorant route: ${account.route}`),
        });
      }
      const mmr = yield* henrikClient.getMmr(
        account.puuid,
        route.region,
        route.platform,
      );
      if (mmr.tier.toLowerCase() === "unrated") return [];
      const iconKey = rankIconKey(mmr.tier);
      return [
        {
          label: mmr.tier,
          ...(iconKey ? { rankIconKey: iconKey } : {}),
          pointsLabel: `${mmr.rr} RR`,
        },
      ];
    },
    (effect) => effect.pipe(apiError("getRanks")),
  );

  return {
    game: "valorant",
    rankIcons: valorantRankIcons,
    resolveAccount,
    getRecentMatches,
    getRanks,
    enrichMatch: Effect.fn("GameAdapter.valorant.enrichMatch")(
      (match: MatchDetails) => Effect.succeed(match),
    ),
  } satisfies GameAdapter;
});
