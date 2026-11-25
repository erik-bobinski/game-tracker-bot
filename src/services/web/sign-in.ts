// Signing in to the website with Discord. Discord only says who someone is
// (the identify scope); what they can see comes from their subscriptions. Its
// access token is dropped after that one lookup, and the session cookie's
// token is stored only as a hash.

import {
  Clock,
  Config,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { Base64Url } from "effect/encoding";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpApiError } from "effect/http-api";
import { Database } from "../database/index.ts";
import { Discord } from "../discord/index.ts";
import { EpochMillis } from "../game/index.ts";
import { SignedIn, Viewer, sessionCookie } from "./api.ts";
import { resultPage, type Site } from "./pages.ts";

const SESSION_LIFETIME = Duration.days(30);
const STATE_COOKIE = "discord_sign_in_state";

const Callback = Schema.Struct({
  code: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
});

const randomToken = () =>
  Base64Url.encode(crypto.getRandomValues(new Uint8Array(32)));

const hashToken = (token: string) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  ).pipe(Effect.map((digest) => Base64Url.encode(new Uint8Array(digest))));

// Off until the bot's OAuth client secret is configured, like /link.
export const addSignInRoutes = Effect.fn("addSignInRoutes")(function* (
  router: HttpRouter.HttpRouter,
  site: Site,
) {
  const clientSecret = yield* Config.Redacted("DISCORD_CLIENT_SECRET").pipe(
    Config.option,
  );
  if (Option.isNone(clientSecret)) return;
  const clientId = (yield* Discord).application.id;
  const database = yield* Database;
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const redirectUri = new URL(
    "/auth/discord/callback",
    yield* Config.String("PUBLIC_URL"),
  ).href;

  const failedPage = (title: string, message: string) =>
    HttpServerResponse.html(resultPage(site, title, message));

  // the state cookie proves the callback finishes a sign-in this browser began
  yield* router.add(
    "GET",
    "/auth/discord",
    Effect.gen(function* () {
      const state = randomToken();
      const url = new URL("https://discord.com/oauth2/authorize");
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "identify",
        state,
        prompt: "none",
      }).toString();
      return yield* HttpServerResponse.redirect(url).pipe(
        HttpServerResponse.setCookie(STATE_COOKIE, state, {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/auth",
          maxAge: "10 minutes",
        }),
      );
    }).pipe(Effect.orDie),
  );

  yield* router.add(
    "GET",
    "/auth/discord/callback",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const { code, state } =
        yield* HttpServerRequest.schemaSearchParams(Callback);
      if (!code || !state || state !== request.cookies[STATE_COOKIE]) {
        return failedPage(
          "Sign-in cancelled",
          'Nothing changed. <a href="/auth/discord">Try again</a>.',
        );
      }

      const token = yield* http.execute(
        HttpClientRequest.post("https://discord.com/api/v10/oauth2/token").pipe(
          HttpClientRequest.basicAuth(clientId, clientSecret.value),
          HttpClientRequest.bodyUrlParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
          }),
        ),
      );
      const { access_token } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String }),
      )(yield* token.json);
      const me = yield* http.execute(
        HttpClientRequest.get("https://discord.com/api/v10/users/@me").pipe(
          HttpClientRequest.bearerToken(access_token),
        ),
      );
      const user = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ id: Schema.String }),
      )(yield* me.json);

      // only players the bot tracks get a session, so nothing is kept about
      // anyone else
      if (!(yield* database.hasAccount(user.id))) {
        return failedPage(
          "Not signed up yet",
          "Run <code>/signup</code> in a server with the bot, then sign in again.",
        );
      }
      const sessionToken = randomToken();
      yield* database.createSession({
        tokenHash: yield* hashToken(sessionToken),
        discordUserId: user.id,
        expiresAt: EpochMillis.make(
          (yield* Clock.currentTimeMillis) +
            Duration.toMillis(SESSION_LIFETIME),
        ),
      });
      yield* Effect.logInfo("website sign-in").pipe(
        Effect.annotateLogs({ discordUserId: user.id }),
      );
      return yield* HttpServerResponse.redirect("/feed").pipe(
        HttpServerResponse.setCookie(sessionCookie.key, sessionToken, {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
          maxAge: SESSION_LIFETIME,
        }),
        Effect.flatMap(
          HttpServerResponse.expireCookie(STATE_COOKIE, { path: "/auth" }),
        ),
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("website sign-in failed", error).pipe(
          Effect.as(
            failedPage(
              "Couldn't sign you in",
              'Something went wrong. <a href="/auth/discord">Try again</a>.',
            ),
          ),
        ),
      ),
    ),
  );

  yield* router.add(
    "POST",
    "/auth/sign-out",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const token = request.cookies[sessionCookie.key];
      if (token) yield* database.deleteSession(yield* hashToken(token));
      return yield* HttpServerResponse.redirect("/").pipe(
        HttpServerResponse.expireCookie(sessionCookie.key, { path: "/" }),
      );
    }).pipe(Effect.orDie),
  );
});

export const SignedInLive = Layer.effect(
  SignedIn,
  Effect.gen(function* () {
    const database = yield* Database;
    return SignedIn.of({
      session: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const user = yield* database
            .getSessionUser({
              tokenHash: yield* hashToken(Redacted.value(credential)),
              now: EpochMillis.make(yield* Clock.currentTimeMillis),
            })
            .pipe(Effect.orDie);
          if (Option.isNone(user)) {
            return yield* new HttpApiError.Unauthorized();
          }
          return yield* Effect.provideService(httpEffect, Viewer, {
            discordUserId: user.value,
          });
        }),
    });
  }),
);
