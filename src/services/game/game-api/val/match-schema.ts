// Raw decode schemas for Henrik(Val) APIs.
import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";
import { MatchId, Puuid } from "../../index.ts";

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

// A rejected match repeats every poll until it leaves the history window, so the
// payload is capped rather than logged whole — enough to see the offending shape
// without flooding the log drain.
const MAX_LOGGED_PAYLOAD_CHARS = 2_000;

const rejectedPayload = (issue: SchemaIssue.Issue): string => {
  if (!("actual" in issue)) return "<unavailable>";
  const actual = Option.isOption(issue.actual)
    ? Option.getOrUndefined(issue.actual)
    : issue.actual;
  const encoded = JSON.stringify(actual) ?? String(actual);
  return encoded.length > MAX_LOGGED_PAYLOAD_CHARS
    ? `${encoded.slice(0, MAX_LOGGED_PAYLOAD_CHARS)}…[${encoded.length} chars total]`
    : encoded;
};

const LenientValRawMatch = Schema.UndefinedOr(ValRawMatch).pipe(
  Schema.catchDecoding((issue) =>
    Effect.logWarning(`skipping undecodable valorant match: ${issue}`).pipe(
      Effect.annotateLogs({ payload: rejectedPayload(issue) }),
      Effect.as(Option.some(undefined)),
    ),
  ),
);

export const ValMatchesResponse = HenrikResponse(
  Schema.Array(LenientValRawMatch),
);

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
