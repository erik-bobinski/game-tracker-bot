import { describe, expect, it } from "vitest";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Ref,
  Schema,
  SubscriptionRef,
} from "effect";
import { TestClock } from "effect/testing";
import { AppConfig } from "../src/services/config.ts";
import { MatchEngine } from "../src/services/match-engine/index.ts";
import { Polling, PollingLive } from "../src/services/polling/index.ts";
import { PollingState } from "../src/services/polling/state.ts";
import { config, run } from "./helpers.ts";

class PollCounter extends Context.Service<
  PollCounter,
  { readonly value: Ref.Ref<number> }
>()("test/PollCounter") {}

const testLayer = Layer.effectContext(
  Effect.gen(function* () {
    const paused = yield* SubscriptionRef.make(false);
    const value = yield* Ref.make(0);
    const engine = MatchEngine.of({
      pollOnce: () =>
        Ref.updateAndGet(value, (count) => count + 1).pipe(
          Effect.map(() => ({
            accountsChecked: 1,
            apiFailures: 0,
            discoveredMatches: 0,
            reportsSent: 0,
            reportFailures: 0,
          })),
        ),
    });
    return Context.empty().pipe(
      Context.add(PollingState, PollingState.of({ paused })),
      Context.add(MatchEngine, engine),
      Context.add(PollCounter, PollCounter.of({ value })),
    );
  }),
);

const pollingLayer = PollingLive.pipe(
  Layer.provideMerge(testLayer),
  Layer.provideMerge(Layer.succeed(AppConfig, config(":memory:"))),
);

describe("Polling", () => {
  it("does nothing while paused and runs immediately after resuming", async () => {
    await run(
      Effect.gen(function* () {
        const polling = yield* Polling;
        const state = yield* PollingState;
        const counter = yield* PollCounter;
        yield* SubscriptionRef.set(state.paused, true);
        expect((yield* polling.runOnce())._tag).toBe("Paused");
        expect(yield* Ref.get(counter.value)).toBe(0);
        yield* SubscriptionRef.set(state.paused, false);
        expect((yield* polling.runOnce())._tag).toBe("Completed");
        expect(yield* Ref.get(counter.value)).toBe(1);
      }).pipe(Effect.provide(pollingLayer)),
    );
  });

  it("advances scheduled polling deterministically", async () => {
    await run(
      Effect.gen(function* () {
        const polling = yield* Polling;
        const counter = yield* PollCounter;
        const fiber = yield* polling.run.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(yield* Ref.get(counter.value)).toBe(1);
        yield* TestClock.adjust("1 minute");
        expect(yield* Ref.get(counter.value)).toBe(2);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(pollingLayer), Effect.provide(TestClock.layer())),
    );
  });

  it("logs a typed pass failure and continues on the next schedule", async () => {
    const failureLayer = Layer.effectContext(
      Effect.gen(function* () {
        const paused = yield* SubscriptionRef.make(false);
        const value = yield* Ref.make(0);
        const engine = MatchEngine.of({
          pollOnce: () =>
            Ref.updateAndGet(value, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Schema.decodeUnknownEffect(Schema.Number)("invalid").pipe(
                      Effect.as({
                        accountsChecked: 0,
                        apiFailures: 0,
                        discoveredMatches: 0,
                        reportsSent: 0,
                        reportFailures: 0,
                      }),
                    )
                  : Effect.succeed({
                      accountsChecked: 1,
                      apiFailures: 0,
                      discoveredMatches: 0,
                      reportsSent: 0,
                      reportFailures: 0,
                    }),
              ),
            ),
        });
        return Context.empty().pipe(
          Context.add(PollingState, PollingState.of({ paused })),
          Context.add(MatchEngine, engine),
          Context.add(PollCounter, PollCounter.of({ value })),
        );
      }),
    );
    const layer = PollingLive.pipe(
      Layer.provideMerge(failureLayer),
      Layer.provideMerge(Layer.succeed(AppConfig, config(":memory:"))),
    );
    await run(
      Effect.gen(function* () {
        const polling = yield* Polling;
        const counter = yield* PollCounter;
        const fiber = yield* polling.run.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(yield* Ref.get(counter.value)).toBe(1);
        yield* TestClock.adjust("1 minute");
        expect(yield* Ref.get(counter.value)).toBe(2);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
    );
  });
  it("serializes concurrent manual and scheduled passes", async () => {
    await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const calls = yield* Ref.make(0);
        const paused = yield* SubscriptionRef.make(false);
        const engine = MatchEngine.of({
          pollOnce: () =>
            Effect.gen(function* () {
              yield* Ref.update(calls, (count) => count + 1);
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return {
                accountsChecked: 1,
                apiFailures: 0,
                discoveredMatches: 0,
                reportsSent: 0,
                reportFailures: 0,
              };
            }),
        });
        const layer = PollingLive.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(PollingState, PollingState.of({ paused })),
              Layer.succeed(MatchEngine, engine),
              Layer.succeed(AppConfig, config(":memory:")),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const polling = yield* Polling;
          const first = yield* polling.runOnce().pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const second = yield* polling.runOnce().pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          expect(yield* Ref.get(calls)).toBe(1);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          expect(yield* Ref.get(calls)).toBe(2);
        }).pipe(Effect.provide(layer));
      }),
    );
  });
});
