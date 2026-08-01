// This file acts as the source of truth for application's supported games and related data
import { Schema } from "effect";

// Source of truth for the games the app supports
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
  readonly flair?: string;
  readonly thumbnailUrl?: string;
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

// A Riot puuid, branded so it can't be mixed up with other id strings
export const Puuid = Schema.String.pipe(Schema.brand("Puuid"));
export type Puuid = typeof Puuid.Type;

export const MatchId = Schema.String.pipe(Schema.brand("MatchId"));
export type MatchId = typeof MatchId.Type;
