import { Effect, Option, Schema, SchemaIssue } from "effect";
import { MatchId, Puuid } from "../../index.ts";

const HenrikResponse = <A extends Schema.Top>(data: A) =>
  Schema.Struct({ status: Schema.Number, data });

const IdName = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const ValMatchMetadata = Schema.Struct({
  match_id: MatchId,
  map: IdName,
  game_length_in_ms: Schema.Number,
  started_at: Schema.String,
  is_completed: Schema.Boolean,
  queue: Schema.Struct({
    id: Schema.String,
    name: Schema.NullOr(Schema.String),
    mode_type: Schema.NullOr(Schema.String),
  }),
});

export const valMatchMode = (metadata: typeof ValMatchMetadata.Type): string =>
  metadata.queue.name ?? metadata.queue.mode_type ?? metadata.queue.id;

const ValPlayerStats = Schema.Struct({
  kills: Schema.Number,
  deaths: Schema.Number,
  assists: Schema.Number,
  score: Schema.Number,
  headshots: Schema.Number,
  bodyshots: Schema.Number,
  legshots: Schema.Number,
});

const ValMatchPlayer = Schema.Struct({
  puuid: Puuid,
  name: Schema.String,
  tag: Schema.String,
  team_id: Schema.String,
  agent: IdName,
  tier: Schema.Struct({ id: Schema.Number, name: Schema.String }),
  stats: ValPlayerStats,
});

const ValMatchTeam = Schema.Struct({
  team_id: Schema.String,
  won: Schema.Boolean,
  rounds: Schema.Struct({ won: Schema.Number, lost: Schema.Number }),
});

export const ValRawMatch = Schema.Struct({
  metadata: ValMatchMetadata,
  players: Schema.Array(ValMatchPlayer),
  teams: Schema.Array(ValMatchTeam),
  rounds: Schema.Array(Schema.Struct({ result: Schema.String })),
});
export interface ValRawMatch extends Schema.Schema.Type<typeof ValRawMatch> {}

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

// /valorant/v3/by-puuid/mmr/{region}/{platform}/{puuid} — only the current
// standing is decoded; an unrated account sends nulls rather than omitting them
export const ValMmrResponse = HenrikResponse(
  Schema.Struct({
    current: Schema.NullOr(
      Schema.Struct({
        tier: Schema.NullOr(
          Schema.Struct({
            id: Schema.Number,
            name: Schema.NullOr(Schema.String),
          }),
        ),
        rr: Schema.Number,
      }),
    ),
    // oldest act first, so the last entry is the one in progress
    seasonal: Schema.optionalKey(
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({ wins: Schema.Number, games: Schema.Number }),
        ),
      ),
    ),
  }),
);

export const ValAccountResponse = HenrikResponse(
  Schema.Struct({ puuid: Puuid, region: Schema.String }),
);
