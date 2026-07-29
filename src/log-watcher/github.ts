import { Context, Effect, Layer, Redacted, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpBody from "effect/unstable/http/HttpBody";

export interface KnownWork {
  readonly kind: "pr" | "issue";
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

const PullRequest = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
});

const Issue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  pull_request: Schema.optionalKey(Schema.Unknown),
});

const CreatedPullRequest = Schema.Struct({
  number: Schema.Number,
  html_url: Schema.String,
});

export class GitHub extends Context.Service<
  GitHub,
  {
    readonly listKnownWork: () => Effect.Effect<
      ReadonlyArray<KnownWork>,
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
    readonly createDraftPr: (input: {
      readonly title: string;
      readonly head: string;
      readonly base: string;
      readonly body: string;
    }) => Effect.Effect<
      { readonly number: number; readonly html_url: string },
      HttpClientError.HttpClientError | Schema.SchemaError
    >;
  }
>()("app/LogWatcher/GitHub") {}

export const GitHubLive = (repo: string, token: Redacted.Redacted<string>) =>
  Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(
          HttpClientRequest.prependUrl(`https://api.github.com/repos/${repo}`),
        ),
        HttpClient.mapRequest(
          HttpClientRequest.setHeaders({
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${Redacted.value(token)}`,
            "X-GitHub-Api-Version": "2022-11-28",
          }),
        ),
        HttpClient.filterStatusOk,
        HttpClient.retryTransient({ times: 3 }),
      );

      const listKnownWork = Effect.fn("LogWatcher.GitHub.listKnownWork")(
        function* () {
          const [prsRes, issuesRes] = yield* Effect.all(
            [
              client.get("/pulls?state=open&per_page=100"),
              client.get("/issues?state=open&per_page=100"),
            ],
            { concurrency: 2 },
          );

          const prs = yield* Schema.decodeUnknownEffect(
            Schema.Array(PullRequest),
          )(yield* prsRes.json);
          const issues = yield* Schema.decodeUnknownEffect(Schema.Array(Issue))(
            yield* issuesRes.json,
          );

          const work: Array<KnownWork> = prs.map((pr) => ({
            kind: "pr" as const,
            number: pr.number,
            title: pr.title,
            body: pr.body ?? "",
          }));

          // the issues endpoint also returns PRs; skip those to avoid double counting
          for (const issue of issues) {
            if (issue.pull_request !== undefined) continue;
            work.push({
              kind: "issue",
              number: issue.number,
              title: issue.title,
              body: issue.body ?? "",
            });
          }

          return work;
        },
      );

      const createDraftPr = Effect.fn("LogWatcher.GitHub.createDraftPr")(
        function* (input: {
          title: string;
          head: string;
          base: string;
          body: string;
        }) {
          const res = yield* client.post("/pulls", {
            body: HttpBody.jsonUnsafe({ ...input, draft: true }),
          });
          return yield* Schema.decodeUnknownEffect(CreatedPullRequest)(
            yield* res.json,
          );
        },
      );

      return GitHub.of({ listKnownWork, createDraftPr });
    }),
  );
