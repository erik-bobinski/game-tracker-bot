import { expect, test } from "bun:test";
import { Effect, Exit, Fiber } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { TestClock } from "effect/testing";
import { LiveHttp, LiveHttpLive } from "./http.ts";

test("live API attempts are paced and capped, including retries", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let sent = 0;
      const budget = yield* LiveHttp.pipe(
        Effect.provide(LiveHttpLive),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              sent += 1;
              return HttpClientResponse.fromWeb(
                request,
                new Response("", { status: 503 }),
              );
            }),
          ),
        ),
      );
      const client = budget.client.pipe(
        HttpClient.filterStatusOk,
        HttpClient.retryTransient({ times: 30 }),
      );
      const fiber = yield* client
        .get("https://api.henrikdev.xyz/test")
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("1 second");
      expect(sent).toBe(0);
      yield* TestClock.adjust("5 minutes");
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
      expect(sent).toBe(24);
      expect((yield* budget.counts).api).toBe(24);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});

test("throttling and ambiguous Discord posts cannot trigger another attempt", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      for (const status of [401, 403, 429, 503]) {
        let sent = 0;
        const budget = yield* LiveHttp.pipe(
          Effect.provide(LiveHttpLive),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                sent += 1;
                return HttpClientResponse.fromWeb(
                  request,
                  new Response("", { status }),
                );
              }),
            ),
          ),
        );
        const client = budget.client.pipe(
          HttpClient.filterStatusOk,
          HttpClient.retryTransient({ times: 3 }),
        );
        const fiber = yield* client
          .post("https://discord.com/api/v10/channels/123/messages")
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust("1 minute");
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
        expect(sent).toBe(1);
        expect((yield* budget.counts).posts).toBe(1);
      }
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});
