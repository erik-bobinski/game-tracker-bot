import { Context, Effect, Layer, Schedule, SubscriptionRef } from "effect";
import { MatchEngine } from "../match-engine/index.ts";
import { PollingState } from "./state.ts";

const makePolling = Effect.gen(function* () {
  const matchEngine = yield* MatchEngine;
  const { paused, refresh } = yield* PollingState;

  const pollTick = Effect.gen(function* () {
    // the admin cli pauses by writing the row from its own process
    yield* refresh();

    if (yield* SubscriptionRef.get(paused)) {
      return yield* Effect.logInfo("poll skipped").pipe(
        Effect.annotateLogs({ paused: true }),
      );
    }

    yield* Effect.logInfo("poll started");
    const summary = yield* matchEngine.pollOnce();
    yield* Effect.logInfo("poll finished").pipe(Effect.annotateLogs(summary));
  });

  const pollLoop = pollTick.pipe(
    Effect.tapError((error) => Effect.logError("poll failed", error)),
    Effect.ignore,
    Effect.repeat(Schedule.spaced("3 minutes")),
    Effect.asVoid,
  );

  // the import has to finish before polling replaces the histories it reads
  const importHistory = matchEngine.importHistory().pipe(
    Effect.tapError((error) => Effect.logError("history import failed", error)),
    Effect.ignore,
  );
  const refetchMatches = matchEngine.refetchMatches().pipe(
    Effect.tapError((error) => Effect.logError("refetch failed", error)),
    Effect.ignore,
  );

  return {
    run: refetchMatches.pipe(
      Effect.andThen(importHistory),
      Effect.andThen(pollLoop),
    ),
  };
});

export class Polling extends Context.Service<
  Polling,
  Effect.Success<typeof makePolling>
>()("app/Polling") {}

export const PollingLive = Layer.effect(Polling, makePolling);
