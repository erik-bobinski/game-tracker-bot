import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVerifyRiotId } from "./production-riot-id.ts";

const workspace = join(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = process.env.VERIFY_RUN_ID ?? `verify-${Date.now()}`;
const dbPath = process.env.VERIFY_DB_PATH ?? `/tmp/riot-verify-${runId}.sqlite`;
const artifactDir =
  process.env.VERIFY_ARTIFACT_DIR ?? `/opt/cursor/artifacts/verify-${runId}`;
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
  spawnSync("tmux", ["-f", "/exec-daemon/tmux.portal.conf", ...args], {
    encoding: "utf-8",
  });

const sharedEnv = () => ({
  ...process.env,
  DB_PATH: dbPath,
  DEV_MODE: "true",
  LOG_LEVEL: "Warn",
});

const run = (args: ReadonlyArray<string>, env = sharedEnv()) => {
  const result = spawnSync("pnpm", args, {
    cwd: workspace,
    env,
    encoding: "utf-8",
  });
  return {
    step: `pnpm ${args.join(" ")}`,
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    detail:
      result.status === 0
        ? undefined
        : (result.stderr || result.stdout || `exit ${result.status}`).trim(),
  } satisfies StepResult;
};

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
  return JSON.parse(jsonText) as Record<string, unknown>;
};

const stopBotSessions = () => {
  for (const session of [botSession, "riot-bot-dev"]) {
    tmux(["kill-session", "-t", session]);
  }
};

const startBot = () => {
  stopBotSessions();
  tmux(["new-session", "-d", "-s", botSession, "-c", workspace, "--", "bash", "-l"]);
  const command = [
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '. "$NVM_DIR/nvm.sh"',
    "nvm use 24",
    'export PATH="$NVM_BIN:$PATH"',
    `export DB_PATH="${dbPath}" DEV_MODE=true LOG_LEVEL=Info`,
    `cd "${workspace}"`,
    "pnpm start",
  ].join(" && ");
  tmux(["send-keys", "-t", `${botSession}:0.0`, command, "C-m"]);
};

const captureBotLog = () =>
  tmux(["capture-pane", "-t", `${botSession}:0.0`, "-p"]).stdout ?? "";

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
    spawnSync("sleep", ["1"]);
  }
  return {
    step: "wait for discord gateway ready",
    ok: false,
    stdout: captureBotLog(),
    detail: `Timed out after ${gatewayTimeoutMs}ms`,
  } satisfies StepResult;
};

const writeArtifacts = (riotId: string) => {
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, "results.json"),
    JSON.stringify({ runId, dbPath, riotId, results }, null, 2),
  );
  const botLog = results.find((entry) => entry.step === "bot log tail");
  if (botLog?.stdout) {
    writeFileSync(join(artifactDir, "bot.log"), botLog.stdout);
  }
};

const fail = (message: string, riotId = "unknown"): never => {
  writeArtifacts(riotId);
  console.error(`[verify] ${message}`);
  process.exit(1);
};

const main = () => {
  mkdirSync(artifactDir, { recursive: true });
  if (exists(dbPath)) rmSync(dbPath);

  let riotId = "";
  try {
    riotId = resolveVerifyRiotId(workspace);
    console.log(`[verify] using riot id ${riotId}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  record(run(["typecheck"]));
  if (!results.at(-1)?.ok) fail("typecheck failed", riotId);

  startBot();
  const ready = waitForBotReady();
  record(ready);
  if (!ready.ok) fail("bot did not become ready", riotId);

  const [riotName, riotTag] = riotId.split("#");
  if (!riotName || !riotTag) {
    fail(`resolved riot id must be name#tag, got ${riotId}`, riotId);
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
  if (!results.at(-1)?.ok) fail("signup failed", riotId);

  const firstRefresh = run(["admin", "refresh", devDiscordId, "--json"]);
  record(firstRefresh);
  if (!firstRefresh.ok) fail("first refresh failed", riotId);

  const secondRefresh = run(["admin", "refresh", devDiscordId, "--json"]);
  record(secondRefresh);
  if (!secondRefresh.ok) fail("second refresh failed", riotId);

  const refreshPayload = parseJsonStdout(secondRefresh.stdout) as {
    added: ReadonlyArray<string>;
  };
  if (refreshPayload.added.length > 0) {
    fail("second refresh should be idempotent (added should be empty)", riotId);
  }

  record(run(["admin", "status", "--json"]));

  record(run(["admin", "report-mock", "--game", "lol", "--json"]));
  if (!results.at(-1)?.ok) fail("report-mock failed", riotId);

  record(run(["admin", "signout", devDiscordId, "--yes", "--json"]));

  record({
    step: "bot log tail",
    ok: true,
    stdout: captureBotLog(),
  });

  writeArtifacts(riotId);
  console.log(`[verify] passed; artifacts in ${artifactDir}`);
  console.log(`[verify] bot left running in tmux session ${botSession}`);
};

function exists(path: string) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

try {
  main();
} catch (error) {
  console.error("[verify] unexpected error", error);
  writeArtifacts("unknown");
  process.exit(1);
}
