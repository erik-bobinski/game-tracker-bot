import { BunHttpServer } from "@effect/platform-bun";
import { Array as Arr, Config, Effect, Layer, Option, Schema } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Database } from "../database/index.ts";
import { linkAccount } from "../account/index.ts";
import { buildMockMatchReport } from "../discord/dev-commands.ts";
import { matchSummary } from "../discord/embed.ts";
import { Discord } from "../discord/index.ts";
import { MatchCard } from "../discord/match-card.tsx";
import { GameAdapters } from "../game/game-adapters/index.ts";
import { onlyOptedInNamed } from "../game/game-adapters/valorant.ts";
import { gameIds, gameNames } from "../game/index.ts";
import { Rso } from "../rso/index.ts";
import { SiteApi } from "./api.ts";
import { FeedLive } from "./feed.ts";
import { addSignInRoutes, SignedInLive } from "./sign-in.ts";
import {
  escapeHtml,
  landingPage,
  privacyPage,
  resultPage,
  termsPage,
} from "./pages.ts";

const Callback = Schema.Struct({
  code: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
});

const Routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const discord = yield* Discord;
    const card = yield* MatchCard;
    const rso = yield* Rso;
    const database = yield* Database;
    const gameAdapters = yield* GameAdapters;
    const linkGames = Option.isSome(rso)
      ? gameAdapters.all
          .filter((adapter) => adapter.requiresOptIn)
          .map((adapter) => gameNames[adapter.game])
      : [];
    const site = { ...discord.application, linkGames };

    // example reports for the landing page's walkthrough, from the same mock
    // matches as /dev_report. VALORANT names only the players who opted in, as
    // real reports do. A mock that won't build is left out, not fatal.
    const demos = Arr.getSomes(
      yield* Effect.forEach(gameIds, (game) =>
        buildMockMatchReport(game).pipe(
          Effect.map((report) =>
            game === "valorant"
              ? {
                  ...report,
                  match: onlyOptedInNamed(report.match, report.tracked),
                }
              : report,
          ),
          Effect.tapError((error) =>
            Effect.logWarning("demo report failed", error),
          ),
          Effect.option,
        ),
      ),
    );

    yield* router.add(
      "GET",
      "/",
      HttpServerResponse.html(
        landingPage(
          site,
          demos.map((report) => ({
            game: report.match.game,
            summary: matchSummary(report),
          })),
        ),
      ),
    );
    yield* router.add(
      "GET",
      "/terms",
      HttpServerResponse.html(termsPage(site)),
    );
    yield* router.add(
      "GET",
      "/privacy",
      HttpServerResponse.html(privacyPage(site)),
    );
    // re-rendered daily so an icon that failed to load comes back
    for (const report of demos) {
      const png = yield* Effect.cachedWithTTL(card.render(report), "1 day");
      yield* router.add(
        "GET",
        `/demo/${report.match.game}.png`,
        png.pipe(
          Effect.map((bytes) =>
            HttpServerResponse.uint8Array(bytes, { contentType: "image/png" }),
          ),
          Effect.catch((error) =>
            Effect.logWarning("demo card failed", error).pipe(
              Effect.as(HttpServerResponse.empty({ status: 503 })),
            ),
          ),
        ),
      );
    }
    // the string riot hands a production applicant to prove they own the site
    const riotVerification = yield* Config.String("RIOT_VERIFICATION").pipe(
      Config.withDefault(""),
    );
    if (riotVerification) {
      yield* router.add(
        "GET",
        "/riot.txt",
        HttpServerResponse.text(riotVerification),
      );
    }
    yield* addSignInRoutes(router, site);
    if (Option.isNone(rso)) return;

    // where riot sends someone back to after they sign in through /link
    const linkFailedPage = (reason: string) =>
      HttpServerResponse.html(
        resultPage(
          site,
          "Couldn't link your account",
          `${reason}. Run <code>/link</code> in Discord to try again.`,
        ),
      );

    yield* router.add(
      "GET",
      "/rso/callback",
      Effect.gen(function* () {
        const { code, state } =
          yield* HttpServerRequest.schemaSearchParams(Callback);
        if (!code || !state) {
          return HttpServerResponse.html(
            resultPage(
              site,
              "Sign-in cancelled",
              "Nothing was linked. Run <code>/link</code> in Discord to try again.",
            ),
          );
        }

        const signedIn = yield* rso.value.complete({ code, state });
        const riotId = `${signedIn.riotName}#${signedIn.riotTag}`;
        const result = yield* linkAccount(
          { database, gameAdapters },
          signedIn.link,
          signedIn,
        );
        yield* Effect.logInfo("riot account linked").pipe(
          Effect.annotateLogs({
            discordUserId: signedIn.link.discordUserId,
            guildId: signedIn.link.guildId,
            riotId,
            result,
          }),
        );
        const games = escapeHtml(linkGames.join(", "));
        return HttpServerResponse.html(
          result === "ok"
            ? resultPage(
                site,
                "Linked",
                `${escapeHtml(riotId)} is linked. Its ${games} matches will be reported in your server. You can close this tab.`,
              )
            : resultPage(
                site,
                "Nothing to link yet",
                `${escapeHtml(riotId)} has no ${games} matches yet. Play one, then run <code>/link</code> again.`,
              ),
        );
      }).pipe(
        Effect.catchTag("RsoError", (error) =>
          Effect.logWarning("riot sign-in callback failed", error).pipe(
            Effect.as(linkFailedPage(escapeHtml(error.reason))),
          ),
        ),
        Effect.catch((error) =>
          Effect.logWarning("riot sign-in callback failed", error).pipe(
            Effect.as(linkFailedPage("Something went wrong")),
          ),
        ),
      ),
    );
  }),
);

// the handlers need the session middleware as much as the api does
const ApiLive = HttpApiBuilder.layer(SiteApi).pipe(
  Layer.provide(FeedLive),
  Layer.provide(SignedInLive),
);

// The site, built into web/dist by `bun run build:web`: one page for /feed
// and its fingerprinted assets, which never change under the same name. The
// page itself is checked on every visit, so a deploy reaches browsers at once
// rather than whenever their cached copy goes stale. The game icons kept in
// the repo are served alongside.
const site = new URL("../../../web/dist/", import.meta.url).pathname;
const SiteLive = Layer.mergeAll(
  HttpStaticServer.layer({
    root: new URL("../../../assets/", import.meta.url).pathname,
    prefix: "/game-assets",
    cacheControl: "public, max-age=86400",
  }),
  HttpRouter.add(
    "GET",
    "/feed",
    HttpServerResponse.file(`${site}index.html`, {
      headers: { "cache-control": "no-cache" },
    }),
  ),
  HttpStaticServer.layer({
    root: `${site}assets`,
    prefix: "/assets",
    cacheControl: "public, max-age=31536000, immutable",
  }),
);

// Railway routes its public domain to PORT
export const WebLive = HttpRouter.serve(
  Layer.mergeAll(Routes, ApiLive, SiteLive),
  {
    disableLogger: true,
  },
).pipe(
  Layer.provide(
    BunHttpServer.layerConfig({
      port: Config.Port("PORT").pipe(Config.withDefault(3000)),
    }),
  ),
);
