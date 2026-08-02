import {
  Context,
  Effect,
  Layer,
  Schedule,
  Semaphore,
  SubscriptionRef,
} from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Schema } from "effect";
import { AppConfig } from "../config.ts";
import { MatchEngine, type PollSummary } from "../match-engine/index.ts";
import { PollingState } from "./state.ts";

export type PollResult =
  | { readonly _tag: "Paused" }
  | { readonly _tag: "Completed"; readonly summary: PollSummary };

type PollFailure = SqlError | Schema.SchemaError;

export class Polling extends Context.Service<
  Polling,
  {
    readonly runOnce: () => Effect.Effect<PollResult, PollFailure>;
    readonly run: Effect.Effect<void, never>;
  }
>()("app/Polling") {}

export const PollingLive = Layer.effect(
  Polling,
  Effect.gen(function* () {
    const matchEngine = yield* MatchEngine;
    const { paused } = yield* PollingState;
    const { pollInterval } = yield* AppConfig;
    const passLock = yield* Semaphore.make(1);

    const runOnce = Effect.fn("Polling.runOnce")(() =>
      passLock.withPermits(1)(
        Effect.gen(function* () {
          if (yield* SubscriptionRef.get(paused)) {
            return { _tag: "Paused" } as const;
          }
          return {
            _tag: "Completed",
            summary: yield* matchEngine.pollOnce(),
          } as const;
        }),
      ),
    );

    const pass = runOnce().pipe(
      Effect.tap((result) =>
        result._tag === "Completed"
          ? Effect.logInfo("polling pass completed").pipe(
              Effect.annotateLogs({ ...result.summary }),
            )
          : Effect.logInfo("polling pass skipped while paused"),
      ),
      Effect.tapError((error) => Effect.logError("polling pass failed", error)),
      Effect.ignore,
    );
    const run = pass.pipe(
      Effect.repeat(Schedule.spaced(pollInterval)),
      Effect.asVoid,
    );

    return Polling.of({ runOnce, run });
  }),
);
