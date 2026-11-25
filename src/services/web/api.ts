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

const Me = Schema.Struct({
  ...Player.fields,
  servers: Schema.Array(Server),
});

// where the next page starts: the last match of this one
const Cursor = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(
    Schema.fromJsonString(
      Schema.Struct({ playedAt: EpochMillis, game: GameId, matchId: MatchId }),
    ),
  ),
);

const FeedQuery = Schema.Struct({
  server: Schema.optionalKey(Schema.String),
  game: Schema.optionalKey(GameId),
  player: Schema.optionalKey(Schema.String),
  order: Schema.optionalKey(Schema.Literals(["newest", "oldest"])),
  cursor: Schema.optionalKey(Cursor),
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

const FeedPage = Schema.Struct({
  matches: Schema.Array(FeedMatch),
  // null on the last page
  next: Schema.NullOr(Cursor),
});

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
