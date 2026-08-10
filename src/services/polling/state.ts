import { Context, Effect, Layer, Schedule, SubscriptionRef } from "effect";
import { Database } from "../database/index.ts";

// short enough that `admin pause` looks instant to whoever ran it
const REFRESH_INTERVAL = "5 seconds";

// The database row is the source of truth, because the admin cli flips it from
// its own process; `paused` is the live copy the poll loop and the discord
// presence read, and `setPaused` is the only writer inside the bot.
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

  yield* database.getPollingPaused().pipe(
    Effect.flatMap((next) => SubscriptionRef.set(paused, next)),
    Effect.catch((error) =>
      Effect.logError("failed to re-read pause state", error),
    ),
    Effect.repeat(Schedule.spaced(REFRESH_INTERVAL)),
    Effect.forkScoped,
  );

  return { paused, setPaused };
});

export class PollingState extends Context.Service<
  PollingState,
  Effect.Success<typeof makePollingState>
>()("app/PollingState") {}

export const PollingStateLive = Layer.effect(PollingState, makePollingState);
