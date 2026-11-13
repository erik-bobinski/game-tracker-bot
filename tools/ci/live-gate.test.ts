import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";

// Runs the real inline scripts of live-gate.yml and live.yml against a fake
// GitHub. PR runs use master's copy of these workflows, so a workflow change
// cannot prove itself on its own PR: it has to pass here first.

const Step = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  with: Schema.optionalKey(
    Schema.Struct({
      script: Schema.optionalKey(Schema.String),
      user: Schema.optionalKey(Schema.String),
    }),
  ),
});
type Step = typeof Step.Type;

const Workflow = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      if: Schema.optionalKey(Schema.String),
      secrets: Schema.optionalKey(Schema.String),
      outputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      steps: Schema.optionalKey(Schema.Array(Step)),
    }),
  ),
});
type Workflow = typeof Workflow.Type;

const loadWorkflow = async (name: string) =>
  Schema.decodeUnknownSync(Workflow)(
    Bun.YAML.parse(
      await Bun.file(
        new URL(`../../.github/workflows/${name}`, import.meta.url),
      ).text(),
    ),
  );

const gate = await loadWorkflow("live-gate.yml");
const live = await loadWorkflow("live.yml");

const findStep = (workflow: Workflow, job: string, id: string) => {
  const step = workflow.jobs[job]?.steps?.find(
    (candidate) => candidate.id === id,
  );
  if (!step) throw new Error(`step ${job}.${id} is missing`);
  return step;
};

const scopeStep = findStep(gate, "select", "scope");
const trustStep = findStep(gate, "select", "trust");
const authorizeStep = findStep(gate, "select", "authorize");
const resolveStep = findStep(live, "resolve", "commit");
const reportStep = live.jobs.report?.steps?.[0];

interface Repo {
  id: number;
  full_name: string;
  default_branch: string;
  owner: { id: number };
}

interface Pull {
  number: number;
  state: string;
  html_url: string;
  changed_files: number;
  user: { login: string; id: number };
  head: { sha: string; repo: Repo | null };
  base: { ref: string; repo: Repo };
}

interface Status {
  context: string;
  state: string;
  description: string;
  creator: { login: string };
}

interface ChangedFile {
  filename: string;
}

interface World {
  readonly pulls: Map<number, Pull>;
  readonly files: Map<number, ReadonlyArray<ChangedFile>>;
  readonly statuses: Map<string, Array<Status>>;
  readonly labels: Map<number, Set<string>>;
  readonly permissions: Map<string, string>;
  readonly trust: Map<string, string>;
  readonly writes: Array<string>;
  reads: number;
  onRead?: (reads: number, world: World) => void;
  betweenSteps?: (world: World) => void;
}

const SHA = "a".repeat(40);
const NEXT = "b".repeat(40);
const RELEVANT: ReadonlyArray<ChangedFile> = [{ filename: "src/index.ts" }];
const DOCS: ReadonlyArray<ChangedFile> = [{ filename: "README.md" }];
const LABEL = "live:verify";

const repo = (id: number, fullName: string, ownerId: number): Repo => ({
  id,
  full_name: fullName,
  default_branch: "master",
  owner: { id: ownerId },
});
const upstream = () => repo(1, "erik-bobinski/game-tracker-bot", 100);
const ownFork = () => repo(2, "author/game-tracker-bot", 200);
const outsiderFork = () => repo(3, "outsider/game-tracker-bot", 300);
const orgFork = () => repo(4, "some-org/game-tracker-bot", 400);

const pull = (overrides: Partial<Pull> = {}): Pull => ({
  number: 7,
  state: "open",
  html_url: "https://github.com/erik-bobinski/game-tracker-bot/pull/7",
  changed_files: 1,
  user: { login: "author", id: 200 },
  head: { sha: SHA, repo: ownFork() },
  base: { ref: "master", repo: upstream() },
  ...overrides,
});

const world = (
  pulls: ReadonlyArray<Pull>,
  trust: ReadonlyArray<readonly [string, string]> = [
    ["author", "collaborator"],
  ],
  files: ReadonlyArray<ChangedFile> = RELEVANT,
): World => ({
  pulls: new Map(pulls.map((pr) => [pr.number, pr])),
  files: new Map(pulls.map((pr) => [pr.number, files])),
  statuses: new Map(),
  labels: new Map(pulls.map((pr) => [pr.number, new Set<string>()])),
  permissions: new Map([
    ["maintainer", "write"],
    ["outsider", "read"],
    ["author", "read"],
  ]),
  trust: new Map(trust),
  writes: [],
  reads: 0,
});

const pullOf = (state: World, number: number) => {
  const pr = state.pulls.get(number);
  if (!pr) throw new Error(`no pull request #${number}`);
  return pr;
};

const fakeGitHub = (state: World) => ({
  paginate: async <Params, Data>(
    request: (params: Params) => Promise<{ data: Data }>,
    params: Params,
  ) => (await request(params)).data,
  rest: {
    pulls: {
      get: async ({ pull_number }: { pull_number: number }) => {
        state.reads += 1;
        state.onRead?.(state.reads, state);
        return { data: structuredClone(pullOf(state, pull_number)) };
      },
      listFiles: async ({ pull_number }: { pull_number: number }) => ({
        data: state.files.get(pull_number) ?? [],
      }),
    },
    repos: {
      getCollaboratorPermissionLevel: async ({
        username,
      }: {
        username: string;
      }) => ({
        data: { permission: state.permissions.get(username) ?? "none" },
      }),
      listCommitStatuses: async ({ ref }: { ref: string }) => ({
        data: state.statuses.get(ref) ?? [],
      }),
      createCommitStatus: async (status: {
        sha: string;
        context: string;
        state: string;
        description: string;
      }) => {
        state.writes.push(`status:${status.state}`);
        state.statuses.set(status.sha, [
          {
            context: status.context,
            state: status.state,
            description: status.description,
            creator: { login: "github-actions[bot]" },
          },
          ...(state.statuses.get(status.sha) ?? []),
        ]);
      },
    },
    issues: {
      removeLabel: async ({
        issue_number,
        name,
      }: {
        issue_number: number;
        name: string;
      }) => {
        if (!state.labels.get(issue_number)?.delete(name)) {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        }
        state.writes.push("label:removed");
      },
    },
  },
});

interface Context {
  repo: { owner: string; repo: string };
  issue: { number: number };
  actor: string;
  serverUrl: string;
  runId: number;
  payload: {
    action: string;
    pull_request: Pull;
    label: { name: string } | undefined;
  };
}

interface Core {
  setOutput: (key: string, value: string) => void;
  summary: { addRaw: (text: string) => { write: () => Promise<void> } };
}

type Script = (
  github: ReturnType<typeof fakeGitHub>,
  context: Context,
  core: Core,
  process: { env: Record<string, string> },
) => Promise<void>;

// SAFETY: every async function shares the AsyncFunction constructor, which is
// how actions/github-script compiles a step's script.
const AsyncFunction = Object.getPrototypeOf(async () => undefined)
  .constructor as new (...params: ReadonlyArray<string>) => Script;

const runScript = async (
  step: Step,
  args: { github: ReturnType<typeof fakeGitHub>; context: Context },
  env: Record<string, string>,
) => {
  const script = step.with?.script;
  if (script === undefined) throw new Error(`step ${step.id} has no script`);
  const outputs = new Map<string, string>();
  const core: Core = {
    setOutput: (key, value) => {
      outputs.set(key, value);
    },
    summary: { addRaw: () => ({ write: async () => undefined }) },
  };
  await new AsyncFunction("github", "context", "core", "process", script)(
    args.github,
    args.context,
    core,
    { env },
  );
  return outputs;
};

// Expands only the `${{ steps.<id>.outputs.<key> }}` form these steps use.
const stepEnv = (step: Step, outputs: Map<string, Map<string, string>>) =>
  Object.fromEntries(
    Object.entries(step.env ?? {}).map(([key, value]) => [
      key,
      value.replace(
        /\$\{\{ steps\.(\w+)\.outputs\.(\w+) \}\}/g,
        (_expression, id: string, name: string) =>
          outputs.get(id)?.get(name) ?? "",
      ),
    ]),
  );

const contextFor = (
  state: World,
  number: number,
  action: string,
  by: { actor?: string; label?: string },
): Context => ({
  repo: { owner: "erik-bobinski", repo: "game-tracker-bot" },
  issue: { number },
  actor: by.actor ?? "author",
  serverUrl: "https://github.com",
  runId: 1,
  payload: {
    action,
    pull_request: structuredClone(pullOf(state, number)),
    label: by.label === undefined ? undefined : { name: by.label },
  },
});

// One pull_request_target event through the select job: scope, the vouch
// check (faked from `trust`), then authorize when scope says it's needed.
const event = async (
  state: World,
  number: number,
  action: string,
  by: { actor?: string; label?: string } = {},
) => {
  const context = contextFor(state, number, action, by);
  if (by.label !== undefined) state.labels.get(number)?.add(by.label);
  const args = { github: fakeGitHub(state), context };
  const outputs = new Map<string, Map<string, string>>();
  const scope = await runScript(scopeStep, args, stepEnv(scopeStep, outputs));
  outputs.set("scope", scope);
  if (scope.get("needed") === "true") {
    outputs.set(
      "trust",
      new Map([
        ["status", state.trust.get(scope.get("author") ?? "") ?? "unknown"],
      ]),
    );
    state.betweenSteps?.(state);
    outputs.set(
      "authorize",
      await runScript(authorizeStep, args, stepEnv(authorizeStep, outputs)),
    );
  }
  return {
    scope,
    live: outputs.get("authorize")?.get("run") === "true",
    gate: state.statuses.get(context.payload.pull_request.head.sha)?.[0]?.state,
  };
};

const labels = (state: World, number: number) =>
  state.labels.get(number) ?? new Set<string>();

describe("live-gate.yml wiring", () => {
  test("matches what these tests emulate", () => {
    expect(trustStep.if).toBe("steps.scope.outputs.needed == 'true'");
    expect(authorizeStep.if).toBe("steps.scope.outputs.needed == 'true'");
    expect(trustStep.with?.user).toBe("${{ steps.scope.outputs.author }}");
    expect(gate.jobs.select?.outputs?.["run"]).toBe(
      "${{ steps.authorize.outputs.run }}",
    );
    expect(gate.jobs.live?.if).toBe("needs.select.outputs.run == 'true'");
  });

  test("passes secrets to live.yml, which otherwise gets empty values (#53)", () => {
    expect(gate.jobs.live?.secrets).toBe("inherit");
  });
});

describe("live-gate.yml trust", () => {
  for (const trust of ["collaborator", "vouched"]) {
    test(`${trust} author on an outsider's fork: gate pending, no automatic run`, async () => {
      const state = world(
        [pull({ head: { sha: SHA, repo: outsiderFork() } })],
        [["author", trust]],
      );
      const result = await event(state, 7, "synchronize");
      expect(result.live).toBe(false);
      expect(result.gate).toBe("pending");
    });

    test(`${trust} author on their own fork: automatic run`, async () => {
      const state = world([pull()], [["author", trust]]);
      const result = await event(state, 7, "opened");
      expect(result.live).toBe(true);
      expect(result.gate).toBe("pending");
      expect(result.scope.get("sha")).toBe(SHA);
    });

    test(`${trust} author on an upstream branch: automatic run`, async () => {
      const state = world(
        [pull({ head: { sha: SHA, repo: upstream() } })],
        [["author", trust]],
      );
      const result = await event(state, 7, "opened");
      expect(result.live).toBe(true);
      expect(result.gate).toBe("pending");
    });

    test(`${trust} author with a deleted fork: gate pending, no run`, async () => {
      const state = world(
        [pull({ head: { sha: SHA, repo: null } })],
        [["author", trust]],
      );
      const result = await event(state, 7, "synchronize");
      expect(result.live).toBe(false);
      expect(result.gate).toBe("pending");
    });
  }

  test("owner on an upstream branch: automatic run", async () => {
    const state = world(
      [
        pull({
          user: { login: "erik-bobinski", id: 100 },
          head: { sha: SHA, repo: upstream() },
        }),
      ],
      [["erik-bobinski", "collaborator"]],
    );
    const result = await event(state, 7, "opened", {
      actor: "erik-bobinski",
    });
    expect(result.live).toBe(true);
  });

  test("trusted author on an organization's fork: no automatic run", async () => {
    const state = world([pull({ head: { sha: SHA, repo: orgFork() } })]);
    const result = await event(state, 7, "opened");
    expect(result.live).toBe(false);
    expect(result.gate).toBe("pending");
  });

  for (const trust of ["bot", "unknown", "denounced", ""]) {
    test(`trust status "${trust}": gate pending, no automatic run`, async () => {
      const state = world([pull()], [["author", trust]]);
      const result = await event(state, 7, "opened");
      expect(result.live).toBe(false);
      expect(result.gate).toBe("pending");
    });
  }
});

describe("live-gate.yml live:verify label", () => {
  for (const [kind, headRepo] of [
    ["an outsider's", outsiderFork()],
    ["an organization's", orgFork()],
  ] as const) {
    test(`maintainer label on ${kind} fork: label consumed, run allowed`, async () => {
      const state = world([pull({ head: { sha: SHA, repo: headRepo } })]);
      await event(state, 7, "opened");
      const result = await event(state, 7, "labeled", {
        actor: "maintainer",
        label: LABEL,
      });
      expect(result.live).toBe(true);
      expect(labels(state, 7).has(LABEL)).toBe(false);
      expect(result.gate).toBe("pending");
      expect(result.scope.get("sha")).toBe(SHA);
    });
  }

  test("untrusted author: not automatic, a maintainer label runs it", async () => {
    const state = world([pull()], []);
    const automatic = await event(state, 7, "opened");
    expect(automatic.live).toBe(false);
    expect(automatic.gate).toBe("pending");
    const labelled = await event(state, 7, "labeled", {
      actor: "maintainer",
      label: LABEL,
    });
    expect(labelled.live).toBe(true);
    expect(labels(state, 7).has(LABEL)).toBe(false);
  });

  test("label from someone without write access: kept, nothing written", async () => {
    const state = world([pull()], []);
    const result = await event(state, 7, "labeled", {
      actor: "outsider",
      label: LABEL,
    });
    expect(result.live).toBe(false);
    expect(labels(state, 7).has(LABEL)).toBe(true);
    expect(state.writes).toEqual([]);
  });

  test("maintainer label on a deleted fork: kept, nothing written, no run", async () => {
    const state = world([pull({ head: { sha: SHA, repo: null } })]);
    const result = await event(state, 7, "labeled", {
      actor: "maintainer",
      label: LABEL,
    });
    expect(result.live).toBe(false);
    expect(labels(state, 7).has(LABEL)).toBe(true);
    expect(state.writes).toEqual([]);
  });
});

describe("live-gate.yml base branch", () => {
  for (const [kind, files] of [
    ["relevant", RELEVANT],
    ["docs-only", DOCS],
  ] as const) {
    for (const action of ["opened", "synchronize", "edited", "labeled"]) {
      test(`${kind} PR into dev, ${action}: no status, label use, outputs or run`, async () => {
        const state = world(
          [pull({ base: { ref: "dev", repo: upstream() } })],
          undefined,
          files,
        );
        const result = await event(
          state,
          7,
          action,
          action === "labeled" ? { actor: "maintainer", label: LABEL } : {},
        );
        expect(result.live).toBe(false);
        expect(state.writes).toEqual([]);
        expect(result.scope.size).toBe(0);
        if (action === "labeled")
          expect(labels(state, 7).has(LABEL)).toBe(true);
      });
    }
  }

  test("same SHA in a docs-only PR into dev keeps the master PR's gate pending", async () => {
    const author = { login: "outsider", id: 300 };
    const head = () => ({ sha: SHA, repo: outsiderFork() });
    const state = world(
      [
        pull({ user: author, head: head() }),
        pull({
          number: 8,
          user: author,
          head: head(),
          base: { ref: "dev", repo: upstream() },
        }),
      ],
      [],
    );
    state.files.set(8, DOCS);
    const first = await event(state, 7, "opened", { actor: "outsider" });
    const second = await event(state, 8, "opened", { actor: "outsider" });
    const third = await event(state, 8, "edited", { actor: "outsider" });
    expect([first.gate, second.gate, third.gate]).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(state.writes).toEqual(["status:pending"]);
  });

  test("docs-only PR into master: gate passes without a run", async () => {
    const state = world([pull()], [], DOCS);
    const result = await event(state, 7, "opened");
    expect(result.live).toBe(false);
    expect(result.gate).toBe("success");
    expect(result.scope.get("needed")).toBe("false");
  });
});

describe("live-gate.yml races", () => {
  const races = {
    retarget: (state: World) => {
      pullOf(state, 7).base.ref = "dev";
    },
    close: (state: World) => {
      pullOf(state, 7).state = "closed";
    },
    "head advance": (state: World) => {
      pullOf(state, 7).head.sha = NEXT;
    },
  };

  for (const [race, mutate] of Object.entries(races)) {
    for (const manual of [false, true]) {
      const action = manual ? "labeled" : "synchronize";
      const by = manual ? { actor: "maintainer", label: LABEL } : {};

      test(`${race} between the scope reads (${action}): nothing selected`, async () => {
        const state = world([pull()]);
        state.onRead = (reads, current) => {
          if (reads === 2) mutate(current);
        };
        const result = await event(state, 7, action, by);
        expect(result.live).toBe(false);
        expect(state.writes).toEqual([]);
        expect(result.scope.size).toBe(0);
      });

      test(`${race} between selection and authorization (${action}): no run, label kept`, async () => {
        const state = world([pull()]);
        state.betweenSteps = mutate;
        const result = await event(state, 7, action, by);
        expect(result.live).toBe(false);
        expect(state.writes).not.toContain("label:removed");
        if (manual) {
          expect(state.writes).toEqual([]);
          expect(labels(state, 7).has(LABEL)).toBe(true);
        }
      });
    }
  }
});

describe("live.yml report → live-gate.yml", () => {
  for (const [result, final] of [
    ["success", "success"],
    ["failure", "failure"],
  ] as const) {
    test(`a ${result} live run is final for its commit: the gate leaves it alone`, async () => {
      if (!reportStep) throw new Error("live.yml report job has no steps");
      const state = world([pull()]);
      await runScript(
        reportStep,
        {
          github: fakeGitHub(state),
          context: contextFor(state, 7, "workflow_call", {}),
        },
        { TESTED_SHA: SHA, LIVE_RESULT: result },
      );
      const after = await event(state, 7, "edited");
      expect(after.gate).toBe(final);
      expect(after.live).toBe(false);
      expect(state.writes).toEqual([`status:${final}`]);
    });
  }
});

// The resolve step is bash + jq with a fake `gh`; skip where they're missing.
const hasShell = Bun.which("bash") !== null && Bun.which("jq") !== null;

const apiPull = (overrides: Partial<Pull> = {}) => pull(overrides);

const resolve = (
  pr: Pull,
  inputs: { number?: string; expectedSha?: string } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "live-resolve-" });
    yield* fs.makeDirectory(`${dir}/bin`);
    yield* fs.writeFileString(`${dir}/step.sh`, resolveStep.run ?? "");
    yield* fs.writeFileString(
      `${dir}/bin/gh`,
      '#!/usr/bin/env bash\n[[ "$1" == api && "$2" == "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" ]] || exit 9\ncat "$FAKE_PR"\n',
    );
    yield* fs.chmod(`${dir}/bin/gh`, 0o755);
    yield* fs.writeFileString(`${dir}/pr.json`, JSON.stringify(pr));
    yield* fs.writeFileString(`${dir}/output`, "");
    const run = Bun.spawnSync(["bash", "-e", `${dir}/step.sh`], {
      env: {
        PATH: `${dir}/bin:${Bun.env.PATH ?? ""}`,
        GITHUB_REPOSITORY: "erik-bobinski/game-tracker-bot",
        GITHUB_SHA: "c".repeat(40),
        RUNNER_TEMP: dir,
        GITHUB_OUTPUT: `${dir}/output`,
        GITHUB_STEP_SUMMARY: `${dir}/summary`,
        PR_NUMBER: inputs.number ?? "7",
        EXPECTED_SHA: inputs.expectedSha ?? "",
        FAKE_PR: `${dir}/pr.json`,
      },
    });
    const output = (yield* fs.readFileString(`${dir}/output`)).trim();
    return { exitCode: run.exitCode, output };
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);

const pinnedFork = `repository=author/game-tracker-bot\nsha=${SHA}`;

describe.skipIf(!hasShell)("live.yml resolve step", () => {
  test("pins the fork head of an open PR into master", async () => {
    expect(await resolve(apiPull())).toEqual({
      exitCode: 0,
      output: pinnedFork,
    });
  });

  test("accepts the SHA the gate selected", async () => {
    expect(await resolve(apiPull(), { expectedSha: SHA })).toEqual({
      exitCode: 0,
      output: pinnedFork,
    });
  });

  test("blank PR number tests the selected branch", async () => {
    expect(await resolve(apiPull(), { number: "" })).toEqual({
      exitCode: 0,
      output: `repository=erik-bobinski/game-tracker-bot\nsha=${"c".repeat(40)}`,
    });
  });

  const refused: ReadonlyArray<
    readonly [string, Pull, { number?: string; expectedSha?: string }]
  > = [
    [
      "a head that moved past the selected SHA",
      apiPull(),
      { expectedSha: NEXT },
    ],
    ["a PR into dev", apiPull({ base: { ref: "dev", repo: upstream() } }), {}],
    ["a closed PR", apiPull({ state: "closed" }), {}],
    [
      "a deleted head repository",
      apiPull({ head: { sha: SHA, repo: null } }),
      {},
    ],
    [
      "a PR against another repository",
      apiPull({ base: { ref: "master", repo: repo(9, "other/repo", 900) } }),
      {},
    ],
  ];
  for (const [name, pr, inputs] of refused) {
    test(`refuses ${name}`, async () => {
      const result = await resolve(pr, inputs);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toBe("");
    });
  }
});
