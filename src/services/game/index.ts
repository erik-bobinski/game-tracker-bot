import { Schema } from "effect";

export const gameIds = ["lol", "valorant", "tft"] as const;
export const GameId = Schema.Literals(gameIds);
export type GameId = typeof GameId.Type;

const games = {
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

export const Puuid = Schema.String.pipe(Schema.brand("Puuid"));
export type Puuid = typeof Puuid.Type;

export const MatchId = Schema.String.pipe(Schema.brand("MatchId"));
export type MatchId = typeof MatchId.Type;

export const EpochMillis = Schema.Number.pipe(Schema.brand("EpochMillis"));
export type EpochMillis = typeof EpochMillis.Type;

// Matches are saved for the website exactly as they were reported, so they're
// schemas: what's saved is decoded with the same shapes the adapters build.
// Optional fields stay `| undefined` because adapters set them explicitly.
const MatchPlayerIdentity = Schema.Struct({
  puuid: Puuid,
  riotName: Schema.String,
  riotTag: Schema.String,
  stat: Schema.String,
  rank: Schema.optional(Schema.String),
  rankIconKey: Schema.optional(Schema.String),
  rankDivision: Schema.optional(Schema.String),
  flairs: Schema.optional(Schema.Array(Schema.String)),
});
export interface MatchPlayerIdentity extends Schema.Schema.Type<
  typeof MatchPlayerIdentity
> {}

const VersusPlayer = Schema.Struct({
  ...MatchPlayerIdentity.fields,
  team: Schema.String,
  character: Schema.String,
  characterIconUrl: Schema.optional(Schema.String),
  kills: Schema.Number,
  deaths: Schema.Number,
  assists: Schema.Number,
  sortKey: Schema.Number,
});
export interface VersusPlayer extends Schema.Schema.Type<typeof VersusPlayer> {}

const PlacementPlayer = Schema.Struct({
  ...MatchPlayerIdentity.fields,
  placement: Schema.Number,
  won: Schema.Boolean,
});
export interface PlacementPlayer extends Schema.Schema.Type<
  typeof PlacementPlayer
> {}

const MatchTeam = Schema.Struct({
  id: Schema.String,
  // omitted when the match ended in a draw
  won: Schema.optional(Schema.Boolean),
  score: Schema.optional(Schema.Tuple([Schema.Number, Schema.Number])),
});
export interface MatchTeam extends Schema.Schema.Type<typeof MatchTeam> {}

const MatchBase = Schema.Struct({
  matchId: MatchId,
  game: GameId,
  date: EpochMillis,
  mode: Schema.String,
  routingRegion: Schema.optional(Schema.String),
  map: Schema.optional(Schema.String),
  durationSeconds: Schema.Number,
});

const VersusMatch = Schema.Struct({
  ...MatchBase.fields,
  kind: Schema.Literal("versus"),
  surrendered: Schema.Boolean,
  players: Schema.Array(VersusPlayer),
  teams: Schema.Array(MatchTeam),
});
export interface VersusMatch extends Schema.Schema.Type<typeof VersusMatch> {}

const PlacementMatch = Schema.Struct({
  ...MatchBase.fields,
  kind: Schema.Literal("placement"),
  players: Schema.Array(PlacementPlayer),
});
export interface PlacementMatch extends Schema.Schema.Type<
  typeof PlacementMatch
> {}

export const MatchDetails = Schema.Union([VersusMatch, PlacementMatch]);
export type MatchDetails = VersusMatch | PlacementMatch;

// Where an account plays, in whatever form that game's api wants: a riot
// platformId for lol and tft ("na1", "euw1"), a henrik region for val ("na")
export type Region = string;

export interface ResolvedAccount {
  readonly puuid: Puuid;
  readonly region: Region | undefined;
}

const RankInfo = Schema.Struct({
  tier: Schema.String,
  detail: Schema.optional(Schema.String),
  // matches a GameAdapter.rankIcons key, so it renders with the same emojis
  iconKey: Schema.optional(Schema.String),
});
export interface RankInfo extends Schema.Schema.Type<typeof RankInfo> {}

export const RankUpdate = Schema.Struct({
  delta: Schema.optional(Schema.Number),
  current: Schema.optional(Schema.String),
  unit: Schema.String,
  // set when the match moved them into another tier
  tierChange: Schema.optional(
    Schema.Struct({ from: RankInfo, to: RankInfo, promoted: Schema.Boolean }),
  ),
});
export interface RankUpdate extends Schema.Schema.Type<typeof RankUpdate> {}

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
