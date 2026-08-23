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
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.asVoid,
  );

  // Riot ids often exist in only one game at signup; this retries the
  // missing ones on a slower cadence so we don't hammer the apis.
  const missingTick = Effect.gen(function* () {
    yield* refresh();

    if (yield* SubscriptionRef.get(paused)) {
      return yield* Effect.logInfo("missing-game check skipped").pipe(
        Effect.annotateLogs({ paused: true }),
      );
    }

    yield* Effect.logInfo("missing-game check started");
    const summary = yield* matchEngine.resolveMissingGames();
    yield* Effect.logInfo("missing-game check finished").pipe(
      Effect.annotateLogs(summary),
    );
  });

  const missingLoop = missingTick.pipe(
    Effect.tapError((error) =>
      Effect.logError("missing-game check failed", error),
    ),
    Effect.ignore,
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.asVoid,
  );

  return {
    run: Effect.all([pollLoop, missingLoop], {
      concurrency: "unbounded",
      discard: true,
    }),
  };
});

export class Polling extends Context.Service<
  Polling,
  Effect.Success<typeof makePolling>
>()("app/Polling") {}

export const PollingLive = Layer.effect(Polling, makePolling);
