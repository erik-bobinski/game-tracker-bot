import { Context, Effect, Layer, SubscriptionRef } from "effect";
import { Database } from "../database/index.ts";

// The database row is the source of truth, because the admin cli flips it from
// its own process; `paused` is the live copy the poll loop and the discord
// presence read. `setPaused` is the only writer inside the bot, and `refresh`
// is how a write from outside it gets noticed.
const makePollingState = Effect.gen(function* () {
  const database = yield* Database;
  const paused = yield* SubscriptionRef.make(
    yield* database.getPollingPaused(),
  );

  const setPaused = Effect.fn("PollingState.setPaused")(function* (
    next: boolean,
  ) {
    yield* database.setPollingPaused(next);
    yield* SubscriptionRef.set(paused, next);
  });

  // A failed read leaves the last known value in place rather than skipping the
  // poll it was called from.
  const refresh = Effect.fn("PollingState.refresh")(
    function* () {
      yield* SubscriptionRef.set(paused, yield* database.getPollingPaused());
    },
    Effect.catch((error) =>
      Effect.logError("failed to re-read pause state", error),
    ),
  );

  return { paused, setPaused, refresh };
});

export class PollingState extends Context.Service<
  PollingState,
  Effect.Success<typeof makePollingState>
>()("app/PollingState") {}

export const PollingStateLive = Layer.effect(PollingState, makePollingState);
