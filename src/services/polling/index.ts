import { Context, Effect, Layer, Schedule, SubscriptionRef } from "effect";
import { MatchEngine } from "../match-engine/index.ts";
import { PollingState } from "./state.ts";

export class Polling extends Context.Service<
  Polling,
  {
    /** Runs the polling loop until its parent scope is interrupted. */
    readonly run: Effect.Effect<void, unknown>;
  }
>()("app/Polling") {}

const makePolling = Effect.gen(function* () {
  const matchEngine = yield* MatchEngine;
  const { paused } = yield* PollingState;

  const pollTick = Effect.gen(function* () {
    if (yield* SubscriptionRef.get(paused)) return;
    yield* matchEngine.pollOnce();
  });

  const pollLoop = pollTick.pipe(
    // TODO: Decide whether errors should be logged, retried, or reported.
    Effect.catchIf(
      () => true,
      (error) => Effect.logError("Polling cycle failed", error),
    ),
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.asVoid,
  );

  return Polling.of({ run: pollLoop });
});

export const PollingLive = Layer.effect(Polling, makePolling);
