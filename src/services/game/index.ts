import { Schema } from "effect";

export const gameIds = ["lol", "valorant", "tft"] as const;
export const GameId = Schema.Literals(gameIds);
export type GameId = typeof GameId.Type;

export const games = {
  lol: { displayName: "League of Legends", choiceName: "lol" },
  valorant: { displayName: "Valorant", choiceName: "val" },
  tft: { displayName: "Teamfight Tactics", choiceName: "tft" },
} as const satisfies Record<
  GameId,
  { readonly displayName: string; readonly choiceName: string }
>;

export const gameNames = {
  lol: games.lol.displayName,
  valorant: games.valorant.displayName,
  tft: games.tft.displayName,
} as const satisfies Record<GameId, string>;

export const discordGameChoices = gameIds.map((id) => ({
  name: games[id].choiceName,
  value: id,
}));

export const EpochMillis = Schema.Number.pipe(Schema.brand("EpochMillis"));
export type EpochMillis = typeof EpochMillis.Type;

export interface MatchPlayerIdentity {
  readonly puuid: Puuid;
  readonly riotName: string;
  readonly riotTag: string;
  readonly stat: string;
  readonly rank?: string;
  readonly rankIconKey?: string;
  readonly rankDivision?: string;
  readonly flair?: string;
}

export interface VersusPlayer extends MatchPlayerIdentity {
  readonly team: string;
  readonly character: string;
  readonly kills: number;
  readonly deaths: number;
  readonly assists: number;
  readonly sortKey: number;
}

export interface PlacementPlayer extends MatchPlayerIdentity {
  readonly placement: number;
}

export interface MatchTeam {
  readonly id: string;
  readonly won?: boolean;
  readonly score?: readonly [number, number];
}

interface MatchBase {
  readonly matchId: MatchId;
  readonly game: GameId;
  readonly date: EpochMillis;
  readonly mode: string;
  readonly routingRegion?: string;
  readonly map?: string;
  readonly durationSeconds: number;
}

export interface VersusMatch extends MatchBase {
  readonly kind: "versus";
  readonly surrendered: boolean;
  readonly players: ReadonlyArray<VersusPlayer>;
  readonly teams: ReadonlyArray<MatchTeam>;
}

export interface PlacementMatch extends MatchBase {
  readonly kind: "placement";
  readonly players: ReadonlyArray<PlacementPlayer>;
}

export type MatchDetails = VersusMatch | PlacementMatch;

// Where an account plays, in whatever form that game's api wants: a riot
// platformId for lol and tft ("na1", "euw1"), a henrik region for val ("na")
export type Region = string;

export interface ResolvedAccount {
  readonly puuid: Puuid;
  readonly region: Region | undefined;
}

export interface RankInfo {
  readonly tier: string;
  readonly detail?: string;
  // matches a GameAdapter.rankIcons key, so it renders with the same emojis
  readonly iconKey?: string;
}

export interface RankUpdate {
  readonly delta?: number;
  readonly current?: string;
  readonly unit: string;
}

// the last standing an adapter persisted, keyed by whatever queue identifier
// that game ranks separately, so the next report can diff against it
export const RankSnapshots = Schema.Record(
  Schema.String,
  Schema.Struct({ standing: Schema.String, points: Schema.Number }),
);
export type RankSnapshots = typeof RankSnapshots.Type;

export const Puuid = Schema.String.pipe(Schema.brand("Puuid"));
export type Puuid = typeof Puuid.Type;

export const MatchId = Schema.String.pipe(Schema.brand("MatchId"));
export type MatchId = typeof MatchId.Type;
