import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Logger, Redacted } from "effect";

import { GitHub, GitHubLive } from "./github.ts";
import { sh } from "./shell.ts";
import {
  groupBySignature,
  looksKnown,
  type ErrorSignature,
} from "./signatures.ts";

const config = Config.all({
  railwayToken: Config.redacted("RAILWAY_TOKEN"),
  githubToken: Config.redacted("GITHUB_TOKEN"),
  claudeToken: Config.redacted("CLAUDE_CODE_OAUTH_TOKEN"),
  repo: Config.string("GITHUB_REPO").pipe(
    Config.withDefault("erik-bobinski/riot-tracker-bot"),
  ),
  baseBranch: Config.string("BASE_BRANCH").pipe(
    Config.withDefault("effect/rewrite"),
  ),
  watchService: Config.string("WATCH_SERVICE").pipe(
    Config.withDefault("riot-tracker-bot"),
  ),
  logLines: Config.string("LOG_LINES").pipe(Config.withDefault("500")),
});

const buildPrompt = (
  group: ErrorSignature,
  knownWork: ReadonlyArray<{
    readonly kind: string;
    readonly number: number;
    readonly title: string;
  }>,
): string =>
  `You are triaging a production runtime error in this repository.

The service is a Discord bot that polls Riot and HenrikDev APIs for League of Legends
and Valorant matches and reports them to Discord. It runs on Railway and logs one JSON
object per line. Read AGENTS.md before writing any code.

A keyword prefilter suggests no open PR or issue covers this, but that check is
weak — confirm it yourself before doing any work. These are currently open:

${knownWork.map((item) => `- ${item.kind} #${item.number}: ${item.title}`).join("\n") || "- (none)"}

If any of them already addresses this error, make NO changes and say which one.

Occurrences in the sampled window: ${group.count}
Level: ${group.level || "(none)"}
First seen: ${group.firstSeen ?? "unknown"}
Last seen: ${group.lastSeen ?? "unknown"}

Sample log line:
${group.sample}
${
  group.annotations
    ? `\nStructured annotations:\n${JSON.stringify(group.annotations, null, 2)}\n`
    : ""
}
Your task:
1. Find the code path that produces this log line.
2. Determine the root cause. Read the surrounding code before concluding.
3. Only if you are confident in the diagnosis, make the minimal fix.
4. Stage and commit your changes with a message explaining the root cause.

Constraints:
- Do NOT push and do NOT open a pull request. The calling script handles that.
- If you cannot determine the root cause with confidence, make NO changes and explain
  what you found and what evidence is missing. No commit is an acceptable outcome.
- Do not widen a type or swallow an error to make a symptom disappear unless that is
  genuinely the correct fix.`;

const openFixPr = Effect.fn("LogWatcher.openFixPr")(function* (
  target: ErrorSignature,
  knownWork: ReadonlyArray<{
    readonly kind: string;
    readonly number: number;
    readonly title: string;
  }>,
  settings: {
    readonly repo: string;
    readonly baseBranch: string;
    readonly githubToken: Redacted.Redacted<string>;
    readonly claudeToken: Redacted.Redacted<string>;
  },
) {
  const github = yield* GitHub;
  const dir = mkdtempSync(join(tmpdir(), "log-watcher-"));
  const branch = `log-watcher/fix-${Date.now()}`;
  const origin = `https://x-access-token:${Redacted.value(settings.githubToken)}@github.com/${settings.repo}.git`;

  yield* Effect.gen(function* () {
    yield* sh("git", [
      "clone",
      "--depth",
      "50",
      "--branch",
      settings.baseBranch,
      origin,
      dir,
    ]);
    yield* sh("git", ["config", "user.name", "log-watcher"], { cwd: dir });
    yield* sh(
      "git",
      ["config", "user.email", "log-watcher@users.noreply.github.com"],
      { cwd: dir },
    );
    yield* sh("git", ["checkout", "-b", branch], { cwd: dir });

    const summary = yield* sh(
      "pnpm",
      [
        "exec",
        "claude",
        "-p",
        buildPrompt(target, knownWork),
        "--permission-mode",
        "acceptEdits",
        "--allowed-tools",
        "Read,Edit,Write,Glob,Grep,Bash(git add:*),Bash(git commit:*),Bash(git status:*),Bash(git diff:*)",
      ],
      {
        cwd: dir,
        timeoutMs: 20 * 60 * 1000,
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: Redacted.value(settings.claudeToken),
        },
      },
    );

    const commits = yield* sh(
      "git",
      ["rev-list", "--count", `origin/${settings.baseBranch}..HEAD`],
      { cwd: dir },
    );

    if (commits.trim() === "0") {
      yield* Effect.logWarning("agent produced no fix").pipe(
        Effect.annotateLogs({ signature: target.signature, summary }),
      );
      return;
    }

    yield* sh("git", ["push", "origin", branch], { cwd: dir });

    const pr = yield* github.createDraftPr({
      title: `fix: ${target.sample.slice(0, 60)}`,
      head: branch,
      base: settings.baseBranch,
      body: [
        "> Opened automatically by the log watcher. **Unreviewed agent output — verify the diagnosis before merging.**",
        "",
        "## Observed in production",
        "",
        `- **Occurrences in sampled window:** ${target.count}`,
        `- **Level:** ${target.level || "(none)"}`,
        `- **First seen:** ${target.firstSeen ?? "unknown"}`,
        `- **Last seen:** ${target.lastSeen ?? "unknown"}`,
        "",
        "```",
        target.sample,
        "```",
        "",
        "## Agent diagnosis",
        "",
        summary.trim(),
      ].join("\n"),
    });

    yield* Effect.logInfo(`opened draft PR ${pr.html_url}`);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    ),
  );
});

const main = Effect.gen(function* () {
  const settings = yield* config;

  const rawLogs = yield* sh(
    "pnpm",
    [
      "exec",
      "railway",
      "logs",
      "--service",
      settings.watchService,
      "--lines",
      settings.logLines,
      "--json",
    ],
    {
      timeoutMs: 2 * 60 * 1000,
      env: { RAILWAY_TOKEN: Redacted.value(settings.railwayToken) },
    },
  );

  const groups = groupBySignature(rawLogs.split("\n"));
  yield* Effect.logInfo(`found ${groups.length} distinct error signatures`);
  if (groups.length === 0) return;

  const github = yield* GitHub;
  const knownWork = yield* github.listKnownWork();
  const novel = groups.filter(
    (group) => !looksKnown(group.signature, knownWork),
  );

  yield* Effect.logInfo(
    `${knownWork.length} open PRs/issues, ${novel.length} signatures unaddressed`,
  );

  // One fix per run: a cycle surfacing several distinct failures wants a human
  // look, not several agent-written PRs.
  const target = novel[0];
  if (!target) return;

  yield* openFixPr(target, knownWork, settings);
});

const runnable = Effect.gen(function* () {
  const { repo, githubToken } = yield* config;
  yield* main.pipe(Effect.provide(GitHubLive(repo, githubToken)));
}).pipe(
  Effect.provide(NodeHttpClient.layerUndici),
  Effect.provide(Logger.layer([Logger.consoleJson])),
);

NodeRuntime.runMain(runnable);
