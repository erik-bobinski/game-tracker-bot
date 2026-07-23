// Raw decode schemas for LoL APIs
import { Effect, Schema, SchemaGetter } from "effect";
import { MatchId, Puuid } from "../../index.ts";

// A field that Riot may omit; decodes to `fallback` when the key is absent.
const withDefault = <S extends Schema.Top>(schema: S, fallback: S["Type"]) =>
  Schema.optionalKey(schema).pipe(
    Schema.decodeTo(schema, {
      decode: SchemaGetter.withDefault(Effect.succeed(fallback)),
      encode: SchemaGetter.passthrough(),
    }),
  );

// -----------------------------------------------------------------------------
// /lol/match/v5/matches/{matchId}
// -----------------------------------------------------------------------------

export const LolParticipant = Schema.Struct({
  puuid: Puuid,
  riotIdGameName: Schema.String,
  riotIdTagline: Schema.String,
  teamId: Schema.Literals([100, 200]),
  championName: Schema.String,
  kills: Schema.Number,
  deaths: Schema.Number,
  assists: Schema.Number,
  win: Schema.Boolean,
  totalMinionsKilled: Schema.Number,
  neutralMinionsKilled: Schema.Number,
  totalDamageDealtToChampions: Schema.Number,
  // 5 = penta, 4 = quadra, ... used for the "flair" callout
  largestMultiKill: Schema.Number,
  gameEndedInSurrender: withDefault(Schema.Boolean, false),
});
export interface LolParticipant extends Schema.Schema.Type<
  typeof LolParticipant
> {}

export const LolMatchInfo = Schema.Struct({
  gameMode: Schema.String,
  // seconds
  gameDuration: Schema.Number,
  // epoch millis
  gameStartTimestamp: Schema.Number,
  // distinguishes ranked solo (420) vs flex (440) vs normals, which gameMode can't
  queueId: Schema.Number,
  // platform host the match ran on (na1, euw1, ...); league-v4 is routed by this
  platformId: Schema.String,
  participants: Schema.Array(LolParticipant),
});
export interface LolMatchInfo extends Schema.Schema.Type<typeof LolMatchInfo> {}

export const LolMatchMetadata = Schema.Struct({
  matchId: MatchId,
  // puuids of every participant, in team order
  participants: Schema.Array(Puuid),
});
export interface LolMatchMetadata extends Schema.Schema.Type<
  typeof LolMatchMetadata
> {}

export const LolMatch = Schema.Struct({
  metadata: LolMatchMetadata,
  info: LolMatchInfo,
});
export interface LolMatch extends Schema.Schema.Type<typeof LolMatch> {}

// The by-puuid ids endpoint returns a bare JSON array of match ids.
export const LolMatchIds = Schema.Array(MatchId);

// -----------------------------------------------------------------------------
// /lol/league/v4/entries/by-puuid/{puuid} — one entry per ranked queue placed in
// (used for LP-change reporting, fetched separately from the match itself)
// -----------------------------------------------------------------------------

export const LolLeagueEntry = Schema.Struct({
  // "RANKED_SOLO_5x5" or "RANKED_FLEX_SR"
  queueType: Schema.String,
  tier: Schema.String,
  // division within the tier: "I".."IV"
  rank: Schema.String,
  leaguePoints: Schema.Number,
});
export interface LolLeagueEntry extends Schema.Schema.Type<
  typeof LolLeagueEntry
> {}

export const LolLeagueEntries = Schema.Array(LolLeagueEntry);
