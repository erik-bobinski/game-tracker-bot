import { Context, Effect, Layer, Schedule, SubscriptionRef } from "effect";
import { MatchEngine } from "../match-engine/index.ts";
import { PollingState } from "./state.ts";

export class Polling extends Context.Service<
  Polling,
  {
    readonly run: Effect.Effect<void, unknown>;
  }
>()("app/Polling") {}

const makePolling = Effect.gen(function* () {
  const matchEngine = yield* MatchEngine;
  const { paused } = yield* PollingState;

  const pollTick = Effect.gen(function* () {
    if (yield* SubscriptionRef.get(paused)) {
      return yield* Effect.logInfo("poll skipped").pipe(
        Effect.annotateLogs({ paused: true }),
      );
    }

    yield* Effect.logInfo("poll started");
    const summary = yield* matchEngine.pollOnce();
    yield* Effect.logInfo("poll finished").pipe(
      Effect.annotateLogs({
        accountsScanned: summary.accountsScanned,
        matchesFound: summary.matchesFound,
        matchesReported: summary.matchesReported,
      }),
    );
  });

  const pollLoop = pollTick.pipe(
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
