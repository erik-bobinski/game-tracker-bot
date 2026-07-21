// Raw decode schemas for Henrik(Val) APIs.
import { Effect, Schema, SchemaGetter } from "effect";
import { Puuid } from "../../index.js";

// A field HenrikDev may omit; decodes to `fallback` when the key is absent.
const withDefault = <S extends Schema.Top>(schema: S, fallback: S["Type"]) =>
  Schema.optionalKey(schema).pipe(
    Schema.decodeTo(schema, {
      decode: SchemaGetter.withDefault(Effect.succeed(fallback)),
      encode: SchemaGetter.passthrough(),
    }),
  );

// Every HenrikDev payload is wrapped in { status, data }.
const HenrikResponse = <A extends Schema.Top>(data: A) =>
  Schema.Struct({ status: Schema.Number, data });

// -----------------------------------------------------------------------------
// /valorant/v3/by-puuid/matches/{region}/{puuid}
// -----------------------------------------------------------------------------

export const ValMatchMetadata = Schema.Struct({
  map: Schema.String,
  mode: Schema.String,
  game_length: Schema.Number,
  game_start: withDefault(Schema.Number, 0),
  rounds_played: withDefault(Schema.Number, 0),
  matchid: Schema.String,
});
export interface ValMatchMetadata extends Schema.Schema.Type<
  typeof ValMatchMetadata
> {}

export const ValTeamStats = Schema.Struct({
  rounds_won: Schema.Number,
  rounds_lost: Schema.Number,
  has_won: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
export interface ValTeamStats extends Schema.Schema.Type<typeof ValTeamStats> {}

export const ValMatchTeams = Schema.Struct({
  red: Schema.NullOr(ValTeamStats),
  blue: Schema.NullOr(ValTeamStats),
});
export interface ValMatchTeams extends Schema.Schema.Type<
  typeof ValMatchTeams
> {}

export const ValPlayerStats = Schema.Struct({
  kills: Schema.Number,
  deaths: Schema.Number,
  assists: Schema.Number,
  // total combat score across the match, divide by rounds_played for ACS
  score: Schema.Number,
  headshots: withDefault(Schema.Number, 0),
  bodyshots: withDefault(Schema.Number, 0),
  legshots: withDefault(Schema.Number, 0),
});
export interface ValPlayerStats extends Schema.Schema.Type<
  typeof ValPlayerStats
> {}

// image urls HenrikDev bundles per player, agent portrait makes a good thumbnail
export const ValAgentAssets = Schema.Struct({
  small: withDefault(Schema.String, ""),
});
export const ValPlayerAssets = Schema.Struct({
  agent: withDefault(ValAgentAssets, { small: "" }),
});

export const ValMatchPlayer = Schema.Struct({
  puuid: Puuid,
  name: Schema.String,
  tag: Schema.String,
  team: Schema.Literals(["Red", "Blue"]),
  character: Schema.String,
  assets: withDefault(ValPlayerAssets, { agent: { small: "" } }),
  stats: ValPlayerStats,
});
export interface ValMatchPlayer extends Schema.Schema.Type<
  typeof ValMatchPlayer
> {}

export const ValMatchPlayers = Schema.Struct({
  all_players: Schema.Array(ValMatchPlayer),
});
export interface ValMatchPlayers extends Schema.Schema.Type<
  typeof ValMatchPlayers
> {}

export const ValRawMatch = Schema.Struct({
  is_available: Schema.Boolean,
  metadata: Schema.NullOr(ValMatchMetadata),
  players: Schema.NullOr(ValMatchPlayers),
  teams: Schema.NullOr(ValMatchTeams),
});
export interface ValRawMatch extends Schema.Schema.Type<typeof ValRawMatch> {}

export const ValMatchesResponse = HenrikResponse(Schema.Array(ValRawMatch));

// -----------------------------------------------------------------------------
// /valorant/v1/by-puuid/mmr-history/{region}/{puuid} — RR change per competitive
// match (used for rank-change reporting, joined to a match by match_id)
// -----------------------------------------------------------------------------

export const ValMmrHistoryEntry = Schema.Struct({
  match_id: Schema.String,
  mmr_change_to_last_game: Schema.Number,
  currenttierpatched: Schema.String,
});
export interface ValMmrHistoryEntry extends Schema.Schema.Type<
  typeof ValMmrHistoryEntry
> {}

export const ValMmrHistoryResponse = HenrikResponse(
  Schema.Array(ValMmrHistoryEntry),
);
