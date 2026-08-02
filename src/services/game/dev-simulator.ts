import { Context, Effect, Layer, Ref } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type { LolLeagueEntry, LolMatch } from "./game-api/lol/match-schema.ts";
import type { ValRawMatch } from "./game-api/val/match-schema.ts";
import { EpochMillis, MatchId, Puuid, type GameId } from "./index.ts";
import { lolRegionalRoute } from "./game-adapters/lol.ts";
import { RECENT_MATCH_COUNT } from "./game-adapters/index.ts";

export interface MockAccount {
  readonly riotName: string;
  readonly riotTag: string;
  readonly lol?: { readonly puuid: string; readonly route: string };
  readonly valorant?: { readonly puuid: string; readonly route: string };
}

export const MOCK_ACCOUNTS: ReadonlyArray<MockAccount> = [
  {
    riotName: "MockAlpha",
    riotTag: "NA1",
    lol: { puuid: "mock-na-alpha-lol", route: "na1" },
    valorant: { puuid: "mock-na-alpha-val", route: "na/pc" },
  },
  {
    riotName: "MockBravo",
    riotTag: "NA1",
    lol: { puuid: "mock-na-bravo-lol", route: "na1" },
    valorant: { puuid: "mock-na-bravo-val", route: "na/pc" },
  },
  {
    riotName: "MockEuropa",
    riotTag: "EUW",
    lol: { puuid: "mock-eu-lol", route: "euw1" },
    valorant: { puuid: "mock-eu-val", route: "eu/pc" },
  },
];

export interface StagedPlayer {
  readonly riotName: string;
  readonly riotTag: string;
  readonly puuid: string;
  readonly route: string;
}

export interface StageMatchInput {
  readonly game: GameId;
  readonly result: "victory" | "defeat";
  readonly mode: "ranked" | "unranked";
  readonly surrendered: boolean;
  readonly duplicate: boolean;
  readonly players: ReadonlyArray<StagedPlayer>;
}

interface SimulatorState {
  readonly lolHistories: ReadonlyMap<string, ReadonlyArray<LolMatch>>;
  readonly valHistories: ReadonlyMap<string, ReadonlyArray<ValRawMatch>>;
  readonly lastMatchIds: ReadonlyMap<GameId, string>;
  readonly requests: ReadonlyArray<string>;
  readonly sequence: number;
  readonly lastTimestamp: number;
}

export class DevSimulator extends Context.Service<
  DevSimulator,
  {
    readonly listAccounts: () => Effect.Effect<ReadonlyArray<MockAccount>>;
    readonly stageMatch: (input: StageMatchInput) => Effect.Effect<string>;
    readonly requestedUrls: () => Effect.Effect<ReadonlyArray<string>>;
    readonly httpClient: HttpClient.HttpClient;
  }
>()("app/DevSimulator") {}

const initialState: SimulatorState = {
  lolHistories: new Map(),
  valHistories: new Map(),
  lastMatchIds: new Map(),
  requests: [],
  sequence: 0,
  lastTimestamp: 0,
};

const bounded = <A>(items: ReadonlyArray<A>): ReadonlyArray<A> =>
  items.slice(0, RECENT_MATCH_COUNT);

const makeLolMatch = (
  input: StageMatchInput,
  matchId: string,
  timestamp: number,
): LolMatch => {
  const tracked = input.players.map((player, index) => ({
    puuid: Puuid.make(player.puuid),
    riotIdGameName: player.riotName,
    riotIdTagline: player.riotTag,
    teamId: 100 as const,
    championName: index === 0 ? "Ahri" : "Lux",
    kills: input.result === "victory" ? 12 - index : 3 + index,
    deaths: input.result === "victory" ? 3 + index : 10 - index,
    assists: 8 + index,
    win: input.result === "victory",
    totalMinionsKilled: 180 - index * 20,
    neutralMinionsKilled: index * 4,
    totalDamageDealtToChampions: 24_000 - index * 2_000,
    largestMultiKill: index === 0 ? 5 : 2,
    gameEndedInSurrender: input.surrendered,
  }));
  const opponent = {
    puuid: Puuid.make(`mock-opponent-${matchId}`),
    riotIdGameName: "MockOpponent",
    riotIdTagline: "BOT",
    teamId: 200 as const,
    championName: "Garen",
    kills: input.result === "victory" ? 2 : 14,
    deaths: input.result === "victory" ? 12 : 2,
    assists: 4,
    win: input.result !== "victory",
    totalMinionsKilled: 190,
    neutralMinionsKilled: 0,
    totalDamageDealtToChampions: 18_000,
    largestMultiKill: 2,
    gameEndedInSurrender: input.surrendered,
  };
  const participants = [...tracked, opponent];
  return {
    metadata: {
      matchId: MatchId.make(matchId),
      participants: participants.map((player) => player.puuid),
    },
    info: {
      gameMode: input.mode === "ranked" ? "CLASSIC" : "CLASSIC",
      gameDuration: 1_857,
      gameStartTimestamp: EpochMillis.make(timestamp),
      queueId: input.mode === "ranked" ? 420 : 400,
      platformId: input.players[0]?.route.toUpperCase() ?? "NA1",
      participants,
    },
  };
};

const makeValMatch = (
  input: StageMatchInput,
  matchId: string,
  timestamp: number,
): ValRawMatch => {
  const tracked = input.players.map((player, index) => ({
    puuid: Puuid.make(player.puuid),
    name: player.riotName,
    tag: player.riotTag,
    team_id: "Red",
    agent: {
      id:
        index === 0
          ? "add6443a-41bd-e414-f6ad-e58d267f4e95"
          : "a3bfb853-43b2-7238-a4f1-ad90e9e46bcc",
      name: index === 0 ? "Jett" : "Reyna",
    },
    tier: {
      id: input.mode === "ranked" ? 18 : 0,
      name: input.mode === "ranked" ? "Diamond 1" : "Unrated",
    },
    stats: {
      kills: input.result === "victory" ? 24 - index : 11 + index,
      deaths: input.result === "victory" ? 12 + index : 20 - index,
      assists: 7 + index,
      score: 6_000 - index * 300,
      headshots: 20,
      bodyshots: 45,
      legshots: 3,
    },
  }));
  const opponent = {
    puuid: Puuid.make(`mock-val-opponent-${matchId}`),
    name: "MockOpponent",
    tag: "BOT",
    team_id: "Blue",
    agent: {
      id: "f94c3b30-42be-e959-889c-5aa313dba261",
      name: "Raze",
    },
    tier: { id: 15, name: "Platinum 1" },
    stats: {
      kills: input.result === "victory" ? 10 : 25,
      deaths: input.result === "victory" ? 22 : 10,
      assists: 4,
      score: 5_200,
      headshots: 18,
      bodyshots: 50,
      legshots: 2,
    },
  };
  const won = input.result === "victory";
  return {
    metadata: {
      match_id: MatchId.make(matchId),
      map: { id: "ascent", name: "Ascent" },
      game_length_in_ms: 2_145_000,
      started_at: new Date(timestamp).toISOString(),
      is_completed: true,
      queue: {
        id: input.mode === "ranked" ? "competitive" : "unrated",
        name: input.mode === "ranked" ? "Competitive" : "Unrated",
        mode_type: "Standard",
      },
    },
    players: [...tracked, opponent],
    teams: [
      {
        team_id: "Red",
        won,
        rounds: { won: won ? 13 : 8, lost: won ? 8 : 13 },
      },
      {
        team_id: "Blue",
        won: !won,
        rounds: { won: won ? 8 : 13, lost: won ? 13 : 8 },
      },
    ],
    rounds: input.surrendered
      ? [{ result: "Surrendered" }]
      : Array.from({ length: 21 }, () => ({ result: "Eliminated" })),
  };
};

const accountByRiotId = (name: string, tag: string) =>
  MOCK_ACCOUNTS.find(
    (account) =>
      account.riotName.toLowerCase() === name.toLowerCase() &&
      account.riotTag.toLowerCase() === tag.toLowerCase(),
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const lolRanks = (puuid: string): ReadonlyArray<LolLeagueEntry> =>
  puuid.includes("bravo")
    ? []
    : [
        {
          queueType: "RANKED_SOLO_5x5",
          tier: puuid.includes("eu") ? "EMERALD" : "DIAMOND",
          rank: "II",
          leaguePoints: 64,
        },
        {
          queueType: "RANKED_FLEX_SR",
          tier: "PLATINUM",
          rank: "I",
          leaguePoints: 21,
        },
      ];

const responseFor = (url: URL, state: SimulatorState): Response => {
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const hostRoute = url.hostname.split(".")[0] ?? "";

  if (url.hostname.endsWith("api.riotgames.com")) {
    if (parts.slice(0, 5).join("/") === "riot/account/v1/accounts/by-riot-id") {
      const name = parts[5] ?? "";
      const tag = parts[6] ?? "";
      const account = accountByRiotId(name, tag);
      const game = account?.lol;
      return game && lolRegionalRoute(game.route) === hostRoute
        ? json({ puuid: game.puuid, gameName: name, tagLine: tag })
        : json({ status: { message: "Data not found" } }, 404);
    }
    if (parts.slice(0, 5).join("/") === "lol/summoner/v4/summoners/by-puuid") {
      const puuid = parts[5] ?? "";
      const account = MOCK_ACCOUNTS.find(
        (candidate) =>
          candidate.lol?.puuid === puuid && candidate.lol.route === hostRoute,
      );
      return account
        ? json({ puuid, id: `summoner-${puuid}` })
        : json({ status: { message: "Data not found" } }, 404);
    }
    if (parts.slice(0, 5).join("/") === "lol/match/v5/matches/by-puuid") {
      const puuid = parts[5] ?? "";
      const account = MOCK_ACCOUNTS.find(
        (candidate) => candidate.lol?.puuid === puuid,
      );
      const game = account?.lol;
      if (!game || lolRegionalRoute(game.route) !== hostRoute) {
        return json({ status: { message: "Data not found" } }, 404);
      }
      const count = Number(url.searchParams.get("count") ?? RECENT_MATCH_COUNT);
      return json(
        (state.lolHistories.get(puuid) ?? [])
          .slice(0, count)
          .map((match) => match.metadata.matchId),
      );
    }
    if (parts.slice(0, 4).join("/") === "lol/match/v5/matches") {
      const matchId = parts[4] ?? "";
      for (const matches of state.lolHistories.values()) {
        const match = matches.find(
          (candidate) => candidate.metadata.matchId === matchId,
        );
        if (match) return json(match);
      }
      return json({ status: { message: "Data not found" } }, 404);
    }
    if (parts.slice(0, 5).join("/") === "lol/league/v4/entries/by-puuid") {
      const puuid = parts[5] ?? "";
      const account = MOCK_ACCOUNTS.find(
        (candidate) =>
          candidate.lol?.puuid === puuid && candidate.lol.route === hostRoute,
      );
      return account
        ? json(lolRanks(puuid))
        : json({ status: { message: "Data not found" } }, 404);
    }
  }

  if (url.hostname === "api.henrikdev.xyz") {
    if (parts.slice(0, 3).join("/") === "valorant/v2/account") {
      const account = accountByRiotId(parts[3] ?? "", parts[4] ?? "");
      const game = account?.valorant;
      if (!account || !game) return json({ status: 404, errors: [] }, 404);
      const [region, platform] = game.route.split("/");
      return json({
        status: 200,
        data: {
          puuid: game.puuid,
          region,
          platforms: [platform?.toUpperCase() ?? "PC"],
        },
      });
    }
    if (parts.slice(0, 4).join("/") === "valorant/v4/by-puuid/matches") {
      const region = parts[4] ?? "";
      const platform = parts[5] ?? "";
      const puuid = parts[6] ?? "";
      const account = MOCK_ACCOUNTS.find(
        (candidate) => candidate.valorant?.puuid === puuid,
      );
      const game = account?.valorant;
      if (!game || game.route !== `${region}/${platform}`) {
        return json({ status: 404, errors: [] }, 404);
      }
      const count = Number(url.searchParams.get("size") ?? RECENT_MATCH_COUNT);
      return json({
        status: 200,
        data: (state.valHistories.get(puuid) ?? []).slice(0, count),
      });
    }
    if (parts.slice(0, 4).join("/") === "valorant/v3/by-puuid/mmr") {
      const region = parts[4] ?? "";
      const platform = parts[5] ?? "";
      const puuid = parts[6] ?? "";
      const account = MOCK_ACCOUNTS.find(
        (candidate) => candidate.valorant?.puuid === puuid,
      );
      const game = account?.valorant;
      if (!game || game.route !== `${region}/${platform}`) {
        return json({ status: 404, errors: [] }, 404);
      }
      return json({
        status: 200,
        data: {
          current: {
            tier: {
              id: puuid.includes("bravo") ? 0 : 18,
              name: puuid.includes("bravo") ? "Unrated" : "Diamond 1",
            },
            rr: puuid.includes("eu") ? 72 : 38,
          },
        },
      });
    }
  }

  return json(
    { error: `Development simulator route is not implemented: ${url}` },
    501,
  );
};

export const DevSimulatorLive = Layer.effect(
  DevSimulator,
  Effect.gen(function* () {
    const state = yield* Ref.make(initialState);

    const listAccounts = Effect.fn("DevSimulator.listAccounts")(() =>
      Effect.succeed(MOCK_ACCOUNTS),
    );

    const requestedUrls = Effect.fn("DevSimulator.requestedUrls")(() =>
      Ref.get(state).pipe(Effect.map((value) => value.requests)),
    );

    const stageMatch = Effect.fn("DevSimulator.stageMatch")(
      (input: StageMatchInput) =>
        Ref.modify(state, (current) => {
          const sequence = current.sequence + 1;
          const timestamp = Math.max(Date.now() + 1, current.lastTimestamp + 1);
          const previousId = current.lastMatchIds.get(input.game);
          const matchId =
            input.duplicate && previousId
              ? previousId
              : `mock-${input.game}-${timestamp}-${sequence}`;
          const lastMatchIds = new Map(current.lastMatchIds);
          lastMatchIds.set(input.game, matchId);

          if (input.game === "lol") {
            const match = makeLolMatch(input, matchId, timestamp);
            const histories = new Map(current.lolHistories);
            for (const player of input.players) {
              histories.set(
                player.puuid,
                bounded([
                  match,
                  ...(histories.get(player.puuid) ?? []).filter(
                    (candidate) => candidate.metadata.matchId !== matchId,
                  ),
                ]),
              );
            }
            return [
              matchId,
              {
                ...current,
                lolHistories: histories,
                lastMatchIds,
                sequence,
                lastTimestamp: timestamp,
              },
            ];
          }

          const match = makeValMatch(input, matchId, timestamp);
          const histories = new Map(current.valHistories);
          for (const player of input.players) {
            histories.set(
              player.puuid,
              bounded([
                match,
                ...(histories.get(player.puuid) ?? []).filter(
                  (candidate) => candidate.metadata.match_id !== matchId,
                ),
              ]),
            );
          }
          return [
            matchId,
            {
              ...current,
              valHistories: histories,
              lastMatchIds,
              sequence,
              lastTimestamp: timestamp,
            },
          ];
        }),
    );

    const client = HttpClient.make((request, url) =>
      Ref.update(state, (current) => ({
        ...current,
        requests: [...current.requests, url.toString()],
      })).pipe(
        Effect.andThen(Ref.get(state)),
        Effect.map((current) =>
          HttpClientResponse.fromWeb(request, responseFor(url, current)),
        ),
      ),
    );

    return DevSimulator.of({
      listAccounts,
      stageMatch,
      requestedUrls,
      httpClient: client,
    });
  }),
);

export const DevHttpClientLive = Layer.effect(
  HttpClient.HttpClient,
  DevSimulator.pipe(Effect.map((simulator) => simulator.httpClient)),
);
