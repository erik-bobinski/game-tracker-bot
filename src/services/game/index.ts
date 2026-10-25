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
  readonly rank?: string | undefined;
  readonly rankIconKey?: string | undefined;
  readonly rankDivision?: string | undefined;
  readonly flair?: string | undefined;
}

export interface VersusPlayer extends MatchPlayerIdentity {
  readonly team: string;
  readonly character: string;
  readonly characterIconUrl?: string | undefined;
  readonly kills: number;
  readonly deaths: number;
  readonly assists: number;
  readonly sortKey: number;
}

export interface PlacementPlayer extends MatchPlayerIdentity {
  readonly placement: number;
  readonly won: boolean;
}

export interface MatchTeam {
  readonly id: string;
  /** Omitted when the match ended in a draw */
  readonly won?: boolean | undefined;
  readonly score?: readonly [number, number] | undefined;
}

interface MatchBase {
  readonly matchId: MatchId;
  readonly game: GameId;
  readonly date: EpochMillis;
  readonly mode: string;
  readonly routingRegion?: string | undefined;
  readonly map?: string | undefined;
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
  readonly detail?: string | undefined;
  // matches a GameAdapter.rankIcons key, so it renders with the same emojis
  readonly iconKey?: string | undefined;
}

export interface RankUpdate {
  readonly delta?: number | undefined;
  readonly current?: string | undefined;
  readonly unit: string;
  // set when the match moved them into another tier
  readonly tierChange?:
    | {
        readonly from: RankInfo;
        readonly to: RankInfo;
        readonly promoted: boolean;
      }
    | undefined;
}

// the last standing an adapter persisted, keyed by whatever queue identifier
// that game ranks separately, so the next report can diff against it
export const RankSnapshots = Schema.Record(
  Schema.String,
  Schema.Struct({
    standing: Schema.String,
    points: Schema.Number,
    // ranked games played so far, where the game reports it
    games: Schema.optionalKey(Schema.Number),
  }),
);
export type RankSnapshots = typeof RankSnapshots.Type;

export const Puuid = Schema.String.pipe(Schema.brand("Puuid"));
export type Puuid = typeof Puuid.Type;

export const MatchId = Schema.String.pipe(Schema.brand("MatchId"));
export type MatchId = typeof MatchId.Type;
