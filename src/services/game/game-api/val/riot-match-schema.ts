import { Schema } from "effect";
import { EpochMillis, MatchId, Puuid } from "../../index.ts";

// Riot's own VALORANT api (VAL-MATCH-V1 and VAL-CONTENT-V1), decoding only
// what the report uses.

// /riot/account/v1/active-shards/by-game/val/by-puuid/{puuid}
export const ValActiveShard = Schema.Struct({ activeShard: Schema.String });

// /val/match/v1/matchlists/by-puuid/{puuid}, newest first
export const ValMatchlist = Schema.Struct({
  history: Schema.Array(
    Schema.Struct({
      matchId: MatchId,
      gameStartTimeMillis: Schema.Number,
      queueId: Schema.String,
    }),
  ),
});

const ValPlayer = Schema.Struct({
  puuid: Puuid,
  gameName: Schema.String,
  tagLine: Schema.String,
  // a player's puuid in free-for-all modes, where each plays for themselves
  teamId: Schema.String,
  // absent for observers and coaches
  characterId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  stats: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        score: Schema.Number,
        roundsPlayed: Schema.Number,
        kills: Schema.Number,
        deaths: Schema.Number,
        assists: Schema.Number,
      }),
    ),
  ),
  // 0 is unranked, 3 is iron 1, up to 27 for radiant
  competitiveTier: Schema.Number,
  isObserver: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});

const ValTeam = Schema.Struct({
  teamId: Schema.String,
  won: Schema.Boolean,
  roundsPlayed: Schema.Number,
  roundsWon: Schema.Number,
});

const ValRound = Schema.Struct({
  roundResult: Schema.String,
  roundResultCode: Schema.optionalKey(Schema.NullOr(Schema.String)),
  playerStats: Schema.Array(
    Schema.Struct({
      puuid: Puuid,
      damage: Schema.Array(
        Schema.Struct({
          headshots: Schema.Number,
          bodyshots: Schema.Number,
          legshots: Schema.Number,
        }),
      ),
    }),
  ),
});

// /val/match/v1/matches/{matchId}
export const ValMatch = Schema.Struct({
  matchInfo: Schema.Struct({
    matchId: MatchId,
    // an asset path ("/Game/Maps/Ascent/Ascent"), named by the content api
    mapId: Schema.String,
    gameLengthMillis: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    gameStartMillis: EpochMillis,
    isCompleted: Schema.Boolean,
    // "competitive", "unrated", "swiftplay", ... and "" for custom games
    queueId: Schema.String,
  }),
  players: Schema.Array(ValPlayer),
  teams: Schema.optionalKey(Schema.NullOr(Schema.Array(ValTeam))),
  roundResults: Schema.optionalKey(Schema.NullOr(Schema.Array(ValRound))),
});
export interface ValMatch extends Schema.Schema.Type<typeof ValMatch> {}

// /val/content/v1/contents?locale=en-US
export const ValContent = Schema.Struct({
  characters: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String }),
  ),
  maps: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      assetPath: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});
export interface ValContent extends Schema.Schema.Type<typeof ValContent> {}
