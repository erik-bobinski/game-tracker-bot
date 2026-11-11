import { Context, Effect, Layer, Ref, Semaphore } from "effect";
import * as HttpClient from "effect/http/HttpClient";

const make = Effect.gen(function* () {
  const base = yield* HttpClient.HttpClient;
  const requests = yield* Ref.make({
    api: 0,
    assets: 0,
    posts: 0,
    lastStatus: 0,
  });
  const gate = yield* Semaphore.make(1);
  const client = base.pipe(
    HttpClient.transform((send, request) =>
      gate.withPermit(
        Effect.gen(function* () {
          const url = new URL(request.url);
          const api =
            url.hostname === "discord.com" ||
            url.hostname === "api.henrikdev.xyz" ||
            url.hostname.endsWith(".api.riotgames.com");
          const counts = yield* Ref.get(requests);
          const post =
            url.hostname === "discord.com" &&
            request.method === "POST" &&
            /\/channels\/\d+\/messages$/.test(url.pathname);
          if (post && counts.posts >= 1)
            return yield* Effect.die(
              "Live Discord post attempt budget exhausted",
            );
          const kind = api ? "api" : "assets";
          if (counts[kind] >= (api ? 24 : 40))
            return yield* Effect.die("Live request budget exhausted");
          yield* Ref.set(requests, {
            ...counts,
            [kind]: counts[kind] + 1,
            posts: counts.posts + Number(post),
          });
          if (api) yield* Effect.sleep("2 seconds");
          const response = yield* send;
          yield* Ref.update(requests, (current) => ({
            ...current,
            lastStatus: response.status,
          }));
          // Bypass HTTP retries and adapters' optional-enrichment fallback.
          if ([401, 403, 429].includes(response.status))
            return yield* Effect.die(`Live HTTP stopped on ${response.status}`);
          return response;
        }),
      ),
    ),
  );
  return { client, counts: Ref.get(requests) };
});

export class LiveHttp extends Context.Service<
  LiveHttp,
  Effect.Success<typeof make>
>()("verify/LiveHttp") {}

export const LiveHttpLive = Layer.effect(LiveHttp, make);
