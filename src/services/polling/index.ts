import { Context, Effect, Layer, Schedule } from "effect";
import { MatchEngine } from "../match-engine/index.ts";

export class Polling extends Context.Service<
  Polling,
  {
    /** Runs the polling loop until its parent scope is interrupted. */
    readonly run: Effect.Effect<void, unknown>;
  }
>()("app/Polling") {}

const makePolling = Effect.gen(function* () {
  const matchEngine = yield* MatchEngine;

  const pollLoop = matchEngine.pollOnce().pipe(
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

/** Polling depends on MatchEngine; the application root wires it. */
export const PollingLive = Layer.effect(Polling, makePolling);
