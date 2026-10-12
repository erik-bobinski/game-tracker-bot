import { createHmac, timingSafeEqual } from "node:crypto";
import {
  Clock,
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

export class RsoError extends Schema.TaggedError<RsoError>()("RsoError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// Who a riot sign-in links, carried through riot's redirect in the state.
export const RsoLink = Schema.Struct({
  discordUserId: Schema.String,
  discordName: Schema.String,
  guildId: Schema.String,
});
export interface RsoLink extends Schema.Schema.Type<typeof RsoLink> {}

const SignedLink = Schema.fromJsonString(
  Schema.Struct({ ...RsoLink.fields, expiresAt: Schema.Number }),
);

// a link is for whoever asked for it, so it lapses before it can travel far
const LINK_LIFETIME_MILLIS = 15 * 60 * 1_000;

// Riot Sign On: players sign in with riot to opt in to games that require it.
// None until riot grants an RSO client to a product, which needs a production
// key first.
export class Rso extends Context.Service<
  Rso,
  Option.Option<{
    // riot's sign-in page; signing in there links that riot account
    readonly signInUrl: (link: RsoLink) => Effect.Effect<string>;
    // the link a sign-in came back for, and the riot account that signed in
    readonly complete: (callback: {
      readonly code: string;
      readonly state: string;
    }) => Effect.Effect<
      {
        readonly link: RsoLink;
        readonly riotName: string;
        readonly riotTag: string;
      },
      RsoError
    >;
  }>
>()("app/Rso") {}

export const RsoLive = Layer.effect(
  Rso,
  Effect.gen(function* () {
    const clientId = yield* Config.string("RSO_CLIENT_ID").pipe(
      Config.withDefault(""),
    );
    if (!clientId) return Option.none();
    const clientSecret = yield* Config.redacted("RSO_CLIENT_SECRET");
    const redirectUri = new URL(
      "/rso/callback",
      yield* Config.string("PUBLIC_URL"),
    ).href;
    // accounts/me answers from any cluster
    const cluster = yield* Config.string("RIOT_REGION").pipe(
      Config.withDefault("americas"),
    );
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

    const signature = (payload: string) =>
      createHmac("sha256", Redacted.value(clientSecret))
        .update(payload)
        .digest();

    const signInUrl = Effect.fn("Rso.signInUrl")(function* (link: RsoLink) {
      const expiresAt = (yield* Clock.currentTimeMillis) + LINK_LIFETIME_MILLIS;
      const payload = Buffer.from(
        JSON.stringify({ ...link, expiresAt }),
      ).toString("base64url");
      const url = new URL("https://auth.riotgames.com/authorize");
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid",
        state: `${payload}.${signature(payload).toString("base64url")}`,
      }).toString();
      return url.href;
    });

    const complete = Effect.fn("Rso.complete")(function* ({
      code,
      state,
    }: {
      readonly code: string;
      readonly state: string;
    }) {
      const [payload = "", signed = ""] = state.split(".");
      const expected = signature(payload);
      const given = Buffer.from(signed, "base64url");
      if (
        given.length !== expected.length ||
        !timingSafeEqual(given, expected)
      ) {
        return yield* new RsoError({ reason: "the link was tampered with" });
      }
      const { expiresAt, ...link } = yield* Schema.decodeUnknownEffect(
        SignedLink,
      )(Buffer.from(payload, "base64url").toString()).pipe(
        Effect.mapError(
          (cause) => new RsoError({ reason: "the link is malformed", cause }),
        ),
      );
      if ((yield* Clock.currentTimeMillis) > expiresAt) {
        return yield* new RsoError({ reason: "the link expired" });
      }

      const account = yield* Effect.gen(function* () {
        const token = yield* http.execute(
          HttpClientRequest.post("https://auth.riotgames.com/token").pipe(
            HttpClientRequest.basicAuth(clientId, clientSecret),
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
          HttpClientRequest.get(
            `https://${cluster}.api.riotgames.com/riot/account/v1/accounts/me`,
          ).pipe(HttpClientRequest.bearerToken(access_token)),
        );
        return yield* Schema.decodeUnknownEffect(
          Schema.Struct({ gameName: Schema.String, tagLine: Schema.String }),
        )(yield* me.json);
      }).pipe(
        Effect.mapError(
          (cause) => new RsoError({ reason: "riot sign-in failed", cause }),
        ),
      );

      return { link, riotName: account.gameName, riotTag: account.tagLine };
    });

    return Option.some({ signInUrl, complete });
  }),
);
