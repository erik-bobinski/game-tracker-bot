import { Duration, Effect, Layer, Option, Redacted, Schedule } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as Headers from "effect/unstable/http/Headers";
import { RateLimiter } from "effect/unstable/persistence";

// Riot limits a key on each routing host over several windows at once, and
// every response states them, as "requests:seconds" pairs. A host that hasn't
// answered yet gets a personal key's limits, the lowest any key has.
const PERSONAL_KEY_LIMITS = "20:1,100:120";

// Riot counts each window from whenever its first request lands, so pacing has
// to hold for any stretch of that length, not just ours. A bucket a tenth of
// the limit deep, refilled at 80% of the limit's rate, lets through at most
// 90% of it in any such stretch.
const parseLimits = (header: string) =>
  header.split(",").flatMap((pair) => {
    const [requests, seconds] = pair.split(":").map(Number);
    if (!requests || !seconds) return [];
    const burst = Math.max(1, Math.floor(requests / 10));
    return [
      {
        seconds,
        burst,
        refill: Duration.seconds((burst * seconds) / (requests * 0.8)),
      },
    ];
  });

// An http client for one riot key, aimed at `cluster` until a request sets its
// own url. Every attempt, retries included, waits its turn under the key's
// limits on the host it goes to.
export const makeRiotHttpClient = Effect.fn("makeRiotHttpClient")(function* (
  name: string,
  key: Redacted.Redacted,
  cluster: string,
) {
  const base = yield* HttpClient.HttpClient;
  const limiter = yield* RateLimiter.RateLimiter;
  const limitsByHost = new Map<string, ReturnType<typeof parseLimits>>();

  return base.pipe(
    HttpClient.transform((send, request) =>
      Effect.gen(function* () {
        const host = new URL(request.url).host;
        const limits =
          limitsByHost.get(host) ?? parseLimits(PERSONAL_KEY_LIMITS);
        for (const { seconds, burst, refill } of limits) {
          // the in-memory store can't fail
          yield* RateLimiter.sleep(limiter, {
            key: `riot:${name}:${host}:${seconds}`,
            algorithm: "token-bucket",
            limit: burst,
            window: refill,
          }).pipe(Effect.orDie);
        }
        const response = yield* send;
        const header = Headers.get(response.headers, "x-app-rate-limit");
        if (Option.isSome(header)) {
          limitsByHost.set(host, parseLimits(header.value));
        }
        return response;
      }),
    ),
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({
      times: 5,
      schedule: Schedule.exponential("1 second").pipe(
        Schedule.modifyDelay(({ duration, input }) => {
          const header =
            HttpClientError.isHttpClientError(input) &&
            input.response !== undefined
              ? Option.getOrUndefined(
                  Headers.get(input.response.headers, "retry-after"),
                )
              : undefined;
          const seconds = Number(header);
          const wait =
            Number.isFinite(seconds) && seconds > 0
              ? Duration.min(Duration.seconds(seconds), Duration.seconds(15))
              : Duration.zero;
          return Effect.succeed(Duration.max(duration, wait));
        }),
        Schedule.jittered,
      ),
    }),
    HttpClient.mapRequest(
      HttpClientRequest.prependUrl(`https://${cluster}.api.riotgames.com`),
    ),
    HttpClient.mapRequest(
      HttpClientRequest.setHeader("X-Riot-Token", Redacted.value(key)),
    ),
  );
});

// the store each riot client layer paces its own key with
export const RiotRateLimiterLive = RateLimiter.layer.pipe(
  Layer.provide(RateLimiter.layerStoreMemory),
);
