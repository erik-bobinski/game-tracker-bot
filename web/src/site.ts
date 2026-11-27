// The bot's api as the site's queries, from the same contract the server
// implements. The session cookie rides along on every same-origin request.

import { Query } from "@effect/ui";
import { Effect, Option } from "effect";
import { HttpApiClient, HttpApiError } from "effect/http-api";
import {
  Cursor,
  FeedFilters,
  FeedPage,
  Me,
  SiteApi,
} from "../../src/services/web/api.ts";

// who's signed in, and what their servers and games are. Signed out is the
// one failure the page answers; anything else can't be helped from here.
export class GetMe extends Query.Service<GetMe>()("site/GetMe", {
  success: Me,
  error: HttpApiError.Unauthorized,
  staleTime: "5 minutes",
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const site = yield* HttpApiClient.make(SiteApi);
      return () =>
        site.feed.me().pipe(
          Effect.catchTags({
            HttpClientError: Effect.die,
            SchemaError: Effect.die,
          }),
        );
    }),
  );
}

// the matches the filters let through, a page at a time
export class ListFeed extends Query.InfiniteService<ListFeed>()(
  "site/ListFeed",
  {
    args: FeedFilters.fields,
    page: FeedPage,
    items: (page) => page.matches,
    key: (match) => `${match.game}:${match.matchId}`,
    cursor: Cursor,
    next: (page) => Option.fromNullishOr(page.next),
    staleTime: "1 minute",
  },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const site = yield* HttpApiClient.make(SiteApi);
      return (filters, cursor) =>
        site.feed
          .feed({
            query: { ...filters, cursor: Option.getOrUndefined(cursor) },
          })
          .pipe(Effect.orDie);
    }),
  );
}
