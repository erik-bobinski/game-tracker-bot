// The website's API: what a signed-in player can read about the servers they're
// tracked in. Only schemas live here, so the site can build its client from it.

import { Context, Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity,
} from "effect/http-api";
import {
  EpochMillis,
  GameId,
  MatchDetails,
  MatchId,
  Puuid,
  RankUpdate,
} from "../game/index.ts";

// the discord user a session cookie belongs to
export class Viewer extends Context.Service<
  Viewer,
  { readonly discordUserId: string }
>()("app/Viewer") {}

export const sessionCookie = HttpApiSecurity.apiKey({
  key: "session",
  in: "cookie",
});

export class SignedIn extends HttpApiMiddleware.Service<
  SignedIn,
  { provides: Viewer }
>()("app/SignedIn", {
  error: HttpApiError.Unauthorized,
  security: { session: sessionCookie },
}) {}

const Player = Schema.Struct({
  discordUserId: Schema.String,
  discordName: Schema.String,
});

// a server the viewer is tracked in, and everyone tracked there
const Server = Schema.Struct({
  guildId: Schema.String,
  name: Schema.String,
  iconUrl: Schema.NullOr(Schema.String),
  players: Schema.Array(Player),
});

// how the site draws a game: its icon, and its rank emblems by
// MatchPlayerIdentity.rankIconKey
const Game = Schema.Struct({
  game: GameId,
  name: Schema.String,
  iconUrl: Schema.String,
  rankIcons: Schema.Array(
    Schema.Struct({ key: Schema.String, url: Schema.String }),
  ),
});

const Me = Schema.Struct({
  ...Player.fields,
  servers: Schema.Array(Server),
  games: Schema.Array(Game),
});
export interface Me extends Schema.Schema.Type<typeof Me> {}

// where the next page starts: the last match of this one
const Cursor = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(
    Schema.fromJsonString(
      Schema.Struct({ playedAt: EpochMillis, game: GameId, matchId: MatchId }),
    ),
  ),
);

// an unset filter may be left out or undefined, so the site can pass its
// url's search params straight through
const FeedQuery = Schema.Struct({
  server: Schema.optional(Schema.String),
  game: Schema.optional(GameId),
  player: Schema.optional(Schema.String),
  order: Schema.optional(Schema.Literals(["newest", "oldest"])),
  cursor: Schema.optional(Cursor),
});

// a match as it was reported, with its tracked players in the viewer's servers
const FeedMatch = Schema.Struct({
  game: GameId,
  matchId: MatchId,
  playedAt: EpochMillis,
  match: MatchDetails,
  guildIds: Schema.Array(Schema.String),
  players: Schema.Array(
    Schema.Struct({
      ...Player.fields,
      puuid: Puuid,
      rankUpdate: Schema.NullOr(RankUpdate),
    }),
  ),
});

export interface FeedMatch extends Schema.Schema.Type<typeof FeedMatch> {}

const FeedPage = Schema.Struct({
  matches: Schema.Array(FeedMatch),
  // null on the last page
  next: Schema.NullOr(Cursor),
});
export interface FeedPage extends Schema.Schema.Type<typeof FeedPage> {}

export const SiteApi = HttpApi.make("site").add(
  HttpApiGroup.make("feed")
    .add(HttpApiEndpoint.get("me", "/api/me", { success: Me }))
    .add(
      HttpApiEndpoint.get("feed", "/api/feed", {
        query: FeedQuery,
        success: FeedPage,
      }),
    )
    .middleware(SignedIn),
);
