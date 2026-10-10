import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Config, Effect, Layer, Option, Schema } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { Database } from "../database/index.ts";
import { linkAccount } from "../discord/commands.ts";
import { Discord } from "../discord/index.ts";
import { GameAdapters } from "../game/game-adapters/index.ts";
import { gameNames } from "../game/index.ts";
import { Rso } from "../rso/index.ts";
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
    const rso = yield* Rso;
    const database = yield* Database;
    const gameAdapters = yield* GameAdapters;
    const linkGames = Option.isSome(rso)
      ? gameAdapters.all
          .filter((adapter) => adapter.requiresOptIn)
          .map((adapter) => gameNames[adapter.game])
      : [];
    const site = { ...discord.application, linkGames };

    yield* router.add("GET", "/", HttpServerResponse.html(landingPage(site)));
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
    // the string riot hands a production applicant to prove they own the site
    const riotVerification = yield* Config.string("RIOT_VERIFICATION").pipe(
      Config.withDefault(""),
    );
    if (riotVerification) {
      yield* router.add(
        "GET",
        "/riot.txt",
        HttpServerResponse.text(riotVerification),
      );
    }
    if (Option.isNone(rso)) return;

    // where riot sends someone back to after they sign in through /link
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
        Effect.catch((error) =>
          Effect.logWarning("riot sign-in callback failed", error).pipe(
            Effect.as(
              HttpServerResponse.html(
                resultPage(
                  site,
                  "Couldn't link your account",
                  `${error._tag === "RsoError" ? escapeHtml(error.reason) : "Something went wrong"}. Run <code>/link</code> in Discord to try again.`,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }),
);

// Railway routes its public domain to PORT
export const WebLive = HttpRouter.serve(Routes, { disableLogger: true }).pipe(
  Layer.provide(
    NodeHttpServer.layerConfig(createServer, {
      port: Config.port("PORT").pipe(Config.withDefault(3000)),
    }),
  ),
);
