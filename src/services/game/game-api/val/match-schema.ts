// Raw decode schemas for Henrik(Val) APIs.
import { Option, Schema, SchemaGetter } from "effect";
import { MatchId, Puuid } from "../../index.ts";

// A field HenrikDev may omit *or* send as an explicit null; decodes to `fallback`
// in both cases. The null half matters: for rotating modes HenrikDev keeps the key
// and nulls the value (Skirmish 2v2 sends `"mode": null` as of release-13.01), and
// `optionalKey` alone only covers an absent key — so a null used to fail the decode
// of the whole match list and silently stop reporting for that account.
const withDefault = <S extends Schema.Top>(schema: S, fallback: S["Type"]) =>
  Schema.optionalKey(Schema.NullOr(schema)).pipe(
    Schema.decodeTo(schema, {
      decode: SchemaGetter.transformOptional(
        (encoded: Option.Option<S["Type"] | null>) =>
          Option.some(
            Option.isSome(encoded) && encoded.value !== null
              ? encoded.value
              : fallback,
          ),
      ),
      encode: SchemaGetter.transform((value: S["Type"]) => value),
    }),
  );

// Every HenrikDev payload is wrapped in { status, data }.
const HenrikResponse = <A extends Schema.Top>(data: A) =>
  Schema.Struct({ status: Schema.Number, data });

// -----------------------------------------------------------------------------
// /valorant/v3/by-puuid/matches/{region}/{puuid}
// -----------------------------------------------------------------------------

export const ValMatchMetadata = Schema.Struct({
  map: withDefault(Schema.String, ""),
  // null for rotating modes; `queue` still names them, so read via valMatchMode
  mode: withDefault(Schema.String, ""),
  queue: withDefault(Schema.String, ""),
  game_length: withDefault(Schema.Number, 0),
  game_start: withDefault(Schema.Number, 0),
  rounds_played: withDefault(Schema.Number, 0),
  matchid: MatchId,
});
export interface ValMatchMetadata extends Schema.Schema.Type<
  typeof ValMatchMetadata
> {}

// Display label for the game mode, falling back to the queue name when HenrikDev
// omits the mode entirely.
export const valMatchMode = (metadata: ValMatchMetadata): string =>
  metadata.mode || metadata.queue || "Unknown";

export const ValTeamStats = Schema.Struct({
  rounds_won: withDefault(Schema.Number, 0),
  rounds_lost: withDefault(Schema.Number, 0),
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
  kills: withDefault(Schema.Number, 0),
  deaths: withDefault(Schema.Number, 0),
  assists: withDefault(Schema.Number, 0),
  // total combat score across the match, divide by rounds_played for ACS
  score: withDefault(Schema.Number, 0),
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
  // free-for-all modes (deathmatch) don't split players into Red/Blue, so this is
  // not a closed set — a literal union here would fail the whole match list
  team: withDefault(Schema.String, ""),
  character: withDefault(Schema.String, ""),
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

// The envelope is decoded separately from its elements so that one malformed match
// is skipped rather than failing the whole list — see HenrikApiClient.getRecentMatches.
export const ValMatchesEnvelope = HenrikResponse(Schema.Array(Schema.Unknown));

// -----------------------------------------------------------------------------
// /valorant/v1/by-puuid/mmr-history/{region}/{puuid} — RR change per competitive
// match (used for rank-change reporting, joined to a match by match_id)
// -----------------------------------------------------------------------------

export const ValMmrHistoryEntry = Schema.Struct({
  match_id: MatchId,
  mmr_change_to_last_game: Schema.Number,
  currenttierpatched: Schema.String,
});
export interface ValMmrHistoryEntry extends Schema.Schema.Type<
  typeof ValMmrHistoryEntry
> {}

export const ValMmrHistoryResponse = HenrikResponse(
  Schema.Array(ValMmrHistoryEntry),
);
