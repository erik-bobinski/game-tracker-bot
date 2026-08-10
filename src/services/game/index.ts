import { Schema } from "effect";

export const GameId = Schema.Literals(["lol", "valorant"]);
export type GameId = typeof GameId.Type;

export const EpochMillis = Schema.Number.pipe(Schema.brand("EpochMillis"));
export type EpochMillis = typeof EpochMillis.Type;

export interface MatchPlayer {
  readonly puuid: Puuid;
  readonly team: string;
  readonly riotName: string;
  readonly riotTag: string;
  readonly character: string;
  readonly kills: number;
  readonly deaths: number;
  readonly assists: number;
  readonly stat: string;
  readonly sortKey: number;
  readonly rank?: string;
  readonly rankIconKey?: string;
  readonly rankDivision?: string;
  readonly flair?: string;
}

export interface MatchTeam {
  readonly id: string;
  readonly won?: boolean;
  readonly score?: readonly [number, number];
}

export interface MatchDetails {
  readonly matchId: MatchId;
  readonly game: GameId;
  readonly date: EpochMillis;
  readonly mode: string;
  readonly routingRegion?: string;
  readonly map?: string;
  readonly durationSeconds: number;
  readonly surrendered: boolean;
  readonly players: ReadonlyArray<MatchPlayer>;
  readonly teams: ReadonlyArray<MatchTeam>;
}

// Where an account plays, in whatever form that game's api wants: a riot
// platformId for lol ("na1", "euw1"), a henrik region for val ("na", "eu")
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

export const Puuid = Schema.String.pipe(Schema.brand("Puuid"));
export type Puuid = typeof Puuid.Type;

export const MatchId = Schema.String.pipe(Schema.brand("MatchId"));
export type MatchId = typeof MatchId.Type;
