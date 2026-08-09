import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";
import { Database } from "../database/index.ts";

export class PollingState extends Context.Service<
  PollingState,
  {
    readonly paused: SubscriptionRef.SubscriptionRef<boolean>;
  }
>()("app/PollingState") {}

export const PollingStateLive = Layer.effect(
  PollingState,
  Effect.gen(function* () {
    const database = yield* Database;
    const paused = yield* SubscriptionRef.make(
      yield* database.getPollingPaused(),
    );

    yield* SubscriptionRef.changes(paused).pipe(
      Stream.drop(1),
      Stream.changes,
      Stream.runForEach((next) =>
        database
          .setPollingPaused(next)
          .pipe(
            Effect.catch((error) =>
              Effect.logError("failed to persist pause state", error),
            ),
          ),
      ),
      Effect.forkScoped,
    );

    return PollingState.of({ paused });
  }),
);
