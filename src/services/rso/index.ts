import {
  Clock,
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import { Base64Url } from "effect/encoding";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

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

// the state's payload half: the link as base64url json
const SignedLink = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(
    Schema.fromJsonString(
      Schema.Struct({ ...RsoLink.fields, expiresAt: Schema.Number }),
    ),
  ),
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
    const clientId = yield* Config.String("RSO_CLIENT_ID").pipe(
      Config.withDefault(""),
    );
    if (!clientId) return Option.none();
    const clientSecret = yield* Config.Redacted("RSO_CLIENT_SECRET");
    const redirectUri = new URL(
      "/rso/callback",
      yield* Config.String("PUBLIC_URL"),
    ).href;
    // accounts/me answers from any cluster
    const cluster = yield* Config.String("RIOT_REGION").pipe(
      Config.withDefault("americas"),
    );
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

    const encoder = new TextEncoder();
    const hmacKey = yield* Effect.promise(() =>
      crypto.subtle.importKey(
        "raw",
        encoder.encode(Redacted.value(clientSecret)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      ),
    );

    const signInUrl = Effect.fn("Rso.signInUrl")(function* (link: RsoLink) {
      const expiresAt = (yield* Clock.currentTimeMillis) + LINK_LIFETIME_MILLIS;
      const payload = yield* Schema.encodeEffect(SignedLink)({
        ...link,
        expiresAt,
      }).pipe(Effect.orDie);
      const signature = yield* Effect.promise(() =>
        crypto.subtle.sign("HMAC", hmacKey, encoder.encode(payload)),
      );
      const url = new URL("https://auth.riotgames.com/authorize");
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid",
        state: `${payload}.${Base64Url.encode(new Uint8Array(signature))}`,
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
      // an undecodable signature verifies as an empty one, which never matches
      const given = Uint8Array.from(
        Result.getOrElse(Base64Url.decode(signed), () => []),
      );
      const valid = yield* Effect.promise(() =>
        crypto.subtle.verify("HMAC", hmacKey, given, encoder.encode(payload)),
      );
      if (!valid) {
        return yield* new RsoError({ reason: "the link was tampered with" });
      }
      const { expiresAt, ...link } = yield* Schema.decodeUnknownEffect(
        SignedLink,
      )(payload).pipe(
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
