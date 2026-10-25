import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { TestClock } from "effect/testing";
import { Rso, RsoLive } from "./index.ts";

// riot's token and account endpoints, answering for whoever signed in
const riot = HttpClient.make((request, url) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      Response.json(
        url.pathname === "/token"
          ? { access_token: "token" }
          : { gameName: "Faker", tagLine: "KR1" },
      ),
    ),
  ),
);

const RsoTest = RsoLive.pipe(
  Layer.provide(Layer.succeed(HttpClient.HttpClient, riot)),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        RSO_CLIENT_ID: "client",
        RSO_CLIENT_SECRET: "secret",
        PUBLIC_URL: "https://bot.example",
      }),
    ),
  ),
  Layer.provideMerge(TestClock.layer()),
);

const link = (discordUserId: string) => ({
  discordUserId,
  discordName: discordUserId,
  guildId: "guild",
});

const stateOf = (signInUrl: string) =>
  new URL(signInUrl).searchParams.get("state") ?? "";

const run = <A, E>(program: Effect.Effect<A, E, Rso | TestClock.TestClock>) =>
  program.pipe(Effect.provide(RsoTest), Effect.runPromise);

const withRso = Effect.gen(function* () {
  const rso = yield* Rso;
  if (Option.isNone(rso)) return yield* Effect.die("rso is configured");
  return rso.value;
});

describe("Rso", () => {
  test("a sign-in link comes back as the link it was made for", async () => {
    const result = await run(
      Effect.gen(function* () {
        const rso = yield* withRso;
        const state = stateOf(yield* rso.signInUrl(link("alice")));
        return yield* rso.complete({ code: "code", state });
      }),
    );
    expect(result).toEqual({
      link: link("alice"),
      riotName: "Faker",
      riotTag: "KR1",
    });
  });

  test("a link signed for someone else is rejected", async () => {
    const error = await run(
      Effect.gen(function* () {
        const rso = yield* withRso;
        const [alicePayload] = stateOf(
          yield* rso.signInUrl(link("alice")),
        ).split(".");
        const [, bobSignature] = stateOf(
          yield* rso.signInUrl(link("bob")),
        ).split(".");
        return yield* rso
          .complete({ code: "code", state: `${alicePayload}.${bobSignature}` })
          .pipe(Effect.flip);
      }),
    );
    expect(error.reason).toBe("the link was tampered with");
  });

  test("a signature that isn't base64url is rejected", async () => {
    const error = await run(
      Effect.gen(function* () {
        const rso = yield* withRso;
        const [payload] = stateOf(yield* rso.signInUrl(link("alice"))).split(
          ".",
        );
        return yield* rso
          .complete({ code: "code", state: `${payload}.***` })
          .pipe(Effect.flip);
      }),
    );
    expect(error.reason).toBe("the link was tampered with");
  });

  test("a link lapses after 15 minutes", async () => {
    const error = await run(
      Effect.gen(function* () {
        const rso = yield* withRso;
        const state = stateOf(yield* rso.signInUrl(link("alice")));
        yield* TestClock.adjust("16 minutes");
        return yield* rso.complete({ code: "code", state }).pipe(Effect.flip);
      }),
    );
    expect(error.reason).toBe("the link expired");
  });
});
