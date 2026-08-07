import { Context, Effect, Layer, Ref } from "effect";
import {
  AccountNotFound,
  GameAdapters,
  RECENT_MATCH_COUNT,
  type GameAdapter,
  type RankIcon,
} from "./game-adapters/index.ts";
import { lolRankIcons } from "./game-adapters/lol.ts";
import { valorantRankIcons } from "./game-adapters/valorant.ts";
import {
  EpochMillis,
  MatchId,
  Puuid,
  type GameId,
  type MatchDetails,
  type MatchPlayer,
  type RankSummary,
} from "./index.ts";

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
  readonly matches: ReadonlyArray<MatchDetails>;
  readonly lastMatchIds: ReadonlyMap<GameId, string>;
  readonly sequence: number;
  readonly lastTimestamp: number;
}

export class DevSimulator extends Context.Service<
  DevSimulator,
  {
    readonly stageMatch: (input: StageMatchInput) => Effect.Effect<string>;
    readonly adapters: ReadonlyArray<GameAdapter>;
  }
>()("app/DevSimulator") {}

const initialState: SimulatorState = {
  matches: [],
  lastMatchIds: new Map(),
  sequence: 0,
  lastTimestamp: 0,
};

const lolChampion = (index: number) => (index === 0 ? "Ahri" : "Lux");

const makeLolMatch = (
  input: StageMatchInput,
  matchId: string,
  timestamp: number,
): MatchDetails => {
  const won = input.result === "victory";
  const tracked = input.players.map((player, index): MatchPlayer => ({
    puuid: Puuid.make(player.puuid),
    team: "100",
    riotName: player.riotName,
    riotTag: player.riotTag,
    character: lolChampion(index),
    kills: won ? 12 - index : 3 + index,
    deaths: won ? 3 + index : 10 - index,
    assists: 8 + index,
    stat: `${180 - index * 20} CS · ${24 - index * 2}.0k dmg`,
    sortKey: 10 - index,
    ...(input.mode === "ranked"
      ? { rank: "Diamond II", rankIconKey: "diamond" }
      : {}),
    ...(index === 0 && won ? { flair: "Penta Kill" } : {}),
    thumbnailUrl: `https://cdn.communitydragon.org/latest/champion/${lolChampion(index)}/square`,
  }));
  const opponent: MatchPlayer = {
    puuid: Puuid.make(`mock-opponent-${matchId}`),
    team: "200",
    riotName: "MockOpponent",
    riotTag: "BOT",
    character: "Garen",
    kills: won ? 2 : 14,
    deaths: won ? 12 : 2,
    assists: 4,
    stat: "190 CS · 18.0k dmg",
    sortKey: 3,
    ...(input.mode === "ranked"
      ? { rank: "Diamond III", rankIconKey: "diamond" }
      : {}),
    thumbnailUrl:
      "https://cdn.communitydragon.org/latest/champion/Garen/square",
  };
  return {
    matchId: MatchId.make(matchId),
    game: "lol",
    date: EpochMillis.make(timestamp),
    mode: input.mode === "ranked" ? "Ranked Solo/Duo" : "Normal Draft",
    durationSeconds: 1_857,
    surrendered: input.surrendered,
    players: [...tracked, opponent],
    teams: [
      { id: "100", won },
      { id: "200", won: !won },
    ],
  };
};

const valAgents = [
  { name: "Jett", id: "add6443a-41bd-e414-f6ad-e58d267f4e95" },
  { name: "Reyna", id: "a3bfb853-43b2-7238-a4f1-ad90e9e46bcc" },
] as const;
const valOpponentAgent = {
  name: "Raze",
  id: "f94c3b30-42be-e959-889c-5aa313dba261",
} as const;

const makeValMatch = (
  input: StageMatchInput,
  matchId: string,
  timestamp: number,
): MatchDetails => {
  const won = input.result === "victory";
  const tracked = input.players.map((player, index): MatchPlayer => {
    const agent = valAgents[index % valAgents.length]!;
    return {
      puuid: Puuid.make(player.puuid),
      team: "red",
      riotName: player.riotName,
      riotTag: player.riotTag,
      character: agent.name,
      kills: won ? 24 - index : 11 + index,
      deaths: won ? 12 + index : 20 - index,
      assists: 7 + index,
      stat: `${280 - index * 15} ACS · 29% HS`,
      sortKey: 280 - index * 15,
      ...(input.mode === "ranked"
        ? { rank: "Diamond 1", rankIconKey: "diamond_1" }
        : {}),
      thumbnailUrl: `https://media.valorant-api.com/agents/${agent.id}/displayicon.png`,
    };
  });
  const opponent: MatchPlayer = {
    puuid: Puuid.make(`mock-val-opponent-${matchId}`),
    team: "blue",
    riotName: "MockOpponent",
    riotTag: "BOT",
    character: valOpponentAgent.name,
    kills: won ? 10 : 25,
    deaths: won ? 22 : 10,
    assists: 4,
    stat: "247 ACS · 25% HS",
    sortKey: 247,
    ...(input.mode === "ranked"
      ? { rank: "Platinum 1", rankIconKey: "platinum_1" }
      : {}),
    thumbnailUrl: `https://media.valorant-api.com/agents/${valOpponentAgent.id}/displayicon.png`,
  };
  return {
    matchId: MatchId.make(matchId),
    game: "valorant",
    date: EpochMillis.make(timestamp),
    mode: input.mode === "ranked" ? "Competitive" : "Unrated",
    map: "Ascent",
    durationSeconds: 2_145,
    surrendered: input.surrendered,
    players: [...tracked, opponent],
    teams: [
      { id: "red", won, score: won ? [13, 8] : [8, 13] },
      { id: "blue", won: !won, score: won ? [8, 13] : [13, 8] },
    ],
  };
};

const lolRanks = (puuid: string): ReadonlyArray<RankSummary> =>
  puuid.includes("bravo")
    ? []
    : [
        {
          label: `${puuid.includes("eu") ? "Emerald" : "Diamond"} II`,
          queueLabel: "Ranked Solo/Duo",
          rankIconKey: puuid.includes("eu") ? "emerald" : "diamond",
          pointsLabel: "64 LP",
        },
        {
          label: "Platinum I",
          queueLabel: "Ranked Flex",
          rankIconKey: "platinum",
          pointsLabel: "21 LP",
        },
      ];

const valRanks = (puuid: string): ReadonlyArray<RankSummary> =>
  puuid.includes("bravo")
    ? []
    : [
        {
          label: "Diamond 1",
          rankIconKey: "diamond_1",
          pointsLabel: `${puuid.includes("eu") ? 72 : 38} RR`,
        },
      ];

const accountByRiotId = (name: string, tag: string) =>
  MOCK_ACCOUNTS.find(
    (account) =>
      account.riotName.toLowerCase() === name.toLowerCase() &&
      account.riotTag.toLowerCase() === tag.toLowerCase(),
  );

const devAdapter = (
  game: GameId,
  rankIcons: ReadonlyArray<RankIcon>,
  ranks: (puuid: string) => ReadonlyArray<RankSummary>,
  state: Ref.Ref<SimulatorState>,
): GameAdapter => ({
  game,
  rankIcons,
  resolveAccount: Effect.fn(`DevSimulator.${game}.resolveAccount`)(function* (
    name: string,
    tag: string,
  ) {
    const mock = accountByRiotId(name, tag)?.[game];
    if (!mock) return yield* new AccountNotFound({ game });
    return { puuid: Puuid.make(mock.puuid), route: mock.route };
  }),
  getRecentMatches: (account) =>
    Ref.get(state).pipe(
      Effect.map((current) =>
        current.matches
          .filter(
            (match) =>
              match.game === game &&
              match.players.some((player) => player.puuid === account.puuid),
          )
          .slice(0, RECENT_MATCH_COUNT),
      ),
    ),
  getRanks: (account) => Effect.succeed(ranks(account.puuid)),
  enrichMatch: Effect.succeed,
});

export const DevSimulatorLive = Layer.effect(
  DevSimulator,
  Effect.gen(function* () {
    const state = yield* Ref.make(initialState);

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
          const match =
            input.game === "lol"
              ? makeLolMatch(input, matchId, timestamp)
              : makeValMatch(input, matchId, timestamp);
          const lastMatchIds = new Map(current.lastMatchIds);
          lastMatchIds.set(input.game, matchId);
          return [
            matchId,
            {
              matches: [
                match,
                ...current.matches.filter(
                  (existing) => existing.matchId !== matchId,
                ),
              ],
              lastMatchIds,
              sequence,
              lastTimestamp: timestamp,
            },
          ];
        }),
    );

    return DevSimulator.of({
      stageMatch,
      adapters: [
        devAdapter("lol", lolRankIcons, lolRanks, state),
        devAdapter("valorant", valorantRankIcons, valRanks, state),
      ],
    });
  }),
);

export const DevGameAdaptersLive = Layer.effect(
  GameAdapters,
  DevSimulator.pipe(
    Effect.map(({ adapters }) => GameAdapters.of({ all: adapters })),
  ),
);
