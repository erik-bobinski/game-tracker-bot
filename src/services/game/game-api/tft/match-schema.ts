import { Option, Schema, SchemaGetter } from "effect";
import { EpochMillis, MatchId, Puuid } from "../../index.ts";

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

export const TftParticipant = Schema.Struct({
  puuid: Puuid,
  riotIdGameName: withDefault(Schema.String, "Unknown"),
  riotIdTagline: withDefault(Schema.String, "????"),
  placement: Schema.Number,
  level: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  total_damage_to_players: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
export interface TftParticipant extends Schema.Schema.Type<
  typeof TftParticipant
> {}

export const TftMatchInfo = Schema.Struct({
  game_datetime: EpochMillis,
  // seconds, sometimes fractional
  game_length: Schema.Number,
  queue_id: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  queueId: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  tft_game_type: Schema.optionalKey(Schema.NullOr(Schema.String)),
  participants: Schema.Array(TftParticipant),
});
export interface TftMatchInfo extends Schema.Schema.Type<typeof TftMatchInfo> {}

export const TftMatchMetadata = Schema.Struct({
  match_id: MatchId,
});
export interface TftMatchMetadata extends Schema.Schema.Type<
  typeof TftMatchMetadata
> {}

export const TftMatch = Schema.Struct({
  metadata: TftMatchMetadata,
  info: TftMatchInfo,
});
export interface TftMatch extends Schema.Schema.Type<typeof TftMatch> {}

export const TftMatchIds = Schema.Array(MatchId);

export const TftLeagueEntry = Schema.Struct({
  queueType: Schema.String,
  tier: Schema.optionalKey(Schema.NullOr(Schema.String)),
  rank: Schema.optionalKey(Schema.NullOr(Schema.String)),
  leaguePoints: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  wins: withDefault(Schema.Number, 0),
  losses: withDefault(Schema.Number, 0),
});
export interface TftLeagueEntry extends Schema.Schema.Type<
  typeof TftLeagueEntry
> {}

export const TftLeagueEntries = Schema.Array(TftLeagueEntry);
