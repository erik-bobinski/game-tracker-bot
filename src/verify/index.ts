import { Schema } from "effect";
import { resolveVerifyRiotId } from "./production-riot-id.ts";

const workspace = Bun.fileURLToPath(new URL("../..", import.meta.url));
const runId = Bun.env.VERIFY_RUN_ID ?? `verify-${Date.now()}`;
const dbPath = Bun.env.VERIFY_DB_PATH ?? `/tmp/riot-verify-${runId}.sqlite`;
const artifactDir =
  Bun.env.VERIFY_ARTIFACT_DIR ?? `/opt/cursor/artifacts/verify-${runId}`;
const devDiscordId = "verify-agent-user";
const botSession = "riot-bot-verify";
const gatewayTimeoutMs = 60_000;

interface StepResult {
  readonly step: string;
  readonly ok: boolean;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
  readonly detail?: string | undefined;
}

const results: Array<StepResult> = [];

const record = (result: StepResult) => {
  results.push(result);
  const status = result.ok ? "ok" : "FAIL";
  console.log(`[verify] ${status}: ${result.step}`);
  if (!result.ok) {
    if (result.detail) console.error(`  ${result.detail}`);
    if (result.stderr) console.error(result.stderr.trim());
  }
};

const tmux = (args: ReadonlyArray<string>) =>
  Bun.spawnSync(["tmux", "-f", "/exec-daemon/tmux.portal.conf", ...args]);

const sharedEnv = () => ({
  ...Bun.env,
  DB_PATH: dbPath,
  DEV_MODE: "true",
  LOG_LEVEL: "Warn",
});

const run = (args: ReadonlyArray<string>, env = sharedEnv()) => {
  const result = Bun.spawnSync(["bun", "run", ...args], {
    cwd: workspace,
    env,
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  return {
    step: `bun run ${args.join(" ")}`,
    ok: result.success,
    stdout,
    stderr,
    detail: result.success
      ? undefined
      : (stderr || stdout || `exit ${result.exitCode}`).trim(),
  } satisfies StepResult;
};

const TrackResult = Schema.fromJsonString(
  Schema.Struct({
    added: Schema.optional(Schema.Array(Schema.String)),
    removed: Schema.optional(Schema.Array(Schema.String)),
  }),
);

const parseJsonStdout = (stdout: string) => {
  const marker = stdout.lastIndexOf('{\n  "');
  const jsonText =
    marker >= 0
      ? stdout.slice(marker)
      : stdout
          .trim()
          .split("\n")
          .toReversed()
          .find((entry) => entry.startsWith("{"));
  if (!jsonText) {
    throw new Error(`no json object in stdout: ${stdout.slice(0, 200)}`);
  }
  return Schema.decodeUnknownSync(TrackResult)(jsonText);
};

const stopBotSessions = () => {
  for (const session of [botSession, "riot-bot-dev"]) {
    tmux(["kill-session", "-t", session]);
  }
};

const startBot = () => {
  stopBotSessions();
  tmux([
    "new-session",
    "-d",
    "-s",
    botSession,
    "-c",
    workspace,
    "--",
    "bash",
    "-l",
  ]);
  const command = [
    `export DB_PATH="${dbPath}" DEV_MODE=true LOG_LEVEL=Info`,
    `cd "${workspace}"`,
    "bun start",
  ].join(" && ");
  tmux(["send-keys", "-t", `${botSession}:0.0`, command, "C-m"]);
};

const captureBotLog = () =>
  tmux(["capture-pane", "-t", `${botSession}:0.0`, "-p"]).stdout.toString();

const waitForBotReady = () => {
  const deadline = Date.now() + gatewayTimeoutMs;
  while (Date.now() < deadline) {
    const output = captureBotLog();
    // READY can fire before makeDiscord subscribes; slash commands + app start still mean the bot is up.
    if (
      /discord gateway ready/.test(output) ||
      (/slash commands registered/.test(output) &&
        /application started/.test(output))
    ) {
      return {
        step: "wait for discord gateway ready",
        ok: true,
        stdout: output,
      } satisfies StepResult;
    }
    Bun.sleepSync(1000);
  }
  return {
    step: "wait for discord gateway ready",
    ok: false,
    stdout: captureBotLog(),
    detail: `Timed out after ${gatewayTimeoutMs}ms`,
  } satisfies StepResult;
};

// Bun.write creates the artifact directory
const writeArtifacts = async (riotId: string) => {
  await Bun.write(
    `${artifactDir}/results.json`,
    JSON.stringify({ runId, dbPath, riotId, results }, null, 2),
  );
  const botLog = results.find((entry) => entry.step === "bot log tail");
  if (botLog?.stdout) {
    await Bun.write(`${artifactDir}/bot.log`, botLog.stdout);
  }
};

const fail = async (message: string, riotId = "unknown"): Promise<never> => {
  await writeArtifacts(riotId);
  console.error(`[verify] ${message}`);
  process.exit(1);
};

const main = async () => {
  const db = Bun.file(dbPath);
  if (await db.exists()) await db.delete();

  let riotId = "";
  try {
    riotId = await resolveVerifyRiotId(workspace);
    console.log(`[verify] using riot id ${riotId}`);
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error));
  }

  record(run(["typecheck"]));
  if (!results.at(-1)?.ok) await fail("typecheck failed", riotId);

  startBot();
  const ready = waitForBotReady();
  record(ready);
  if (!ready.ok) await fail("bot did not become ready", riotId);

  const [riotName, riotTag] = riotId.split("#");
  if (!riotName || !riotTag) {
    await fail(`resolved riot id must be name#tag, got ${riotId}`, riotId);
  }

  record(
    run([
      "admin",
      "signup",
      `${riotName}#${riotTag}`,
      "--discord-id",
      devDiscordId,
      "--json",
    ]),
  );
  if (!results.at(-1)?.ok) await fail("signup failed", riotId);

  const trackLol = ["admin", "track", devDiscordId, "--game", "lol", "--json"];
  const firstTrack = run(trackLol);
  record(firstTrack);
  if (!firstTrack.ok) await fail("first track failed", riotId);
  if (!parseJsonStdout(firstTrack.stdout).added?.includes("lol")) {
    await fail("first track should add lol", riotId);
  }

  const secondTrack = run(trackLol);
  record(secondTrack);
  if (!secondTrack.ok) await fail("second track failed", riotId);
  if ((parseJsonStdout(secondTrack.stdout).added ?? []).length > 0) {
    await fail(
      "second track should be idempotent (added should be empty)",
      riotId,
    );
  }

  const untrack = run([
    "admin",
    "untrack",
    devDiscordId,
    "--game",
    "lol",
    "--json",
  ]);
  record(untrack);
  if (!untrack.ok) await fail("untrack failed", riotId);
  if (!parseJsonStdout(untrack.stdout).removed?.includes("lol")) {
    await fail("untrack should remove lol", riotId);
  }

  record(run(["admin", "status", "--json"]));

  record(run(["admin", "report-mock", "--game", "lol", "--json"]));
  if (!results.at(-1)?.ok) await fail("report-mock lol failed", riotId);

  record(run(["admin", "report-mock", "--game", "tft", "--json"]));
  if (!results.at(-1)?.ok) await fail("report-mock tft failed", riotId);

  record(run(["admin", "signout", devDiscordId, "--yes", "--json"]));

  record({
    step: "bot log tail",
    ok: true,
    stdout: captureBotLog(),
  });

  await writeArtifacts(riotId);
  console.log(`[verify] passed; artifacts in ${artifactDir}`);
  console.log(`[verify] bot left running in tmux session ${botSession}`);
};

try {
  await main();
} catch (error) {
  console.error("[verify] unexpected error", error);
  await writeArtifacts("unknown");
  process.exit(1);
}
