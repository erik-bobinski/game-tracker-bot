import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { buildMockMatchReport } from "../services/discord/dev-commands.ts";
import {
  PRODUCTION_NOTIFICATION_CHANNEL_IDS,
  testingDiscordRefusal,
  testingNotificationChannelId,
} from "../services/discord/destination.ts";
import {
  matchReportMessage,
  rankImagesFrom,
} from "../services/discord/embed.ts";
import { lolRankIcons } from "../services/game/game-adapters/lol.ts";
import { valRankIcons } from "../services/game/game-adapters/valorant.ts";
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

const testingChannelId = testingNotificationChannelId(process.env);

const sharedEnv = () => {
  const env: Record<string, string | undefined> = { ...process.env };
  env.DB_PATH = dbPath;
  env.DEV_MODE = "true";
  env.LOG_LEVEL = "Warn";
  // Never inherit an ambient destination. Only the testing allowlist is valid.
  delete env.NOTIFICATION_CHANNEL_ID;
  if (testingChannelId) env.NOTIFICATION_CHANNEL_ID = testingChannelId;
  return env;
};

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
  const discordDest = testingChannelId
    ? `export NOTIFICATION_CHANNEL_ID="${testingChannelId}"`
    : "unset NOTIFICATION_CHANNEL_ID";
  const command = [
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '. "$NVM_DIR/nvm.sh"',
    "nvm use 24",
    'export PATH="$NVM_BIN:$PATH"',
    `export DB_PATH="${dbPath}" DEV_MODE=true LOG_LEVEL=Info`,
    "unset NOTIFICATION_CHANNEL_ID",
    discordDest,
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
    JSON.stringify(
      {
        runId,
        dbPath,
        riotId,
        testingChannelId: testingChannelId ?? null,
        results,
      },
      null,
      2,
    ),
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

const mediaUrlsFrom = (node: unknown): Array<string> => {
  if (Array.isArray(node)) return node.flatMap(mediaUrlsFrom);
  if (!node || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const nested = [
    record.components,
    record.items,
    record.accessory,
    record.media,
  ].flatMap(mediaUrlsFrom);
  return typeof record.url === "string" ? [record.url, ...nested] : nested;
};

const hasComponentType = (node: unknown, type: number): boolean => {
  if (Array.isArray(node)) {
    return node.some((item) => hasComponentType(item, type));
  }
  if (!node || typeof node !== "object") return false;
  const record = node as Record<string, unknown>;
  if (record.type === type) return true;
  return [record.components, record.items, record.accessory].some((child) =>
    hasComponentType(child, type),
  );
};

const inspectLolMockReport = () => {
  const report = Effect.runSync(buildMockMatchReport("lol"));
  const message = matchReportMessage(
    report,
    {},
    rankImagesFrom([
      { game: "lol", rankIcons: lolRankIcons },
      { game: "valorant", rankIcons: valRankIcons },
    ]),
  );
  const urls = mediaUrlsFrom(message.components);
  const bad = urls.filter(
    (url) => !/\.(png|jpe?g|webp|gif)(?:\?|$)/i.test(url),
  );
  const hasGallery = hasComponentType(message.components, 12);
  if ((message.flags & 32768) === 0) {
    return {
      step: "inspect lol mock payload",
      ok: false,
      detail: "missing IS_COMPONENTS_V2",
    } satisfies StepResult;
  }
  if (hasGallery) {
    return {
      step: "inspect lol mock payload",
      ok: false,
      detail: "match reports must not include a Media Gallery",
    } satisfies StepResult;
  }
  if (bad.length > 0) {
    return {
      step: "inspect lol mock payload",
      ok: false,
      detail: `non-file image urls: ${bad.join(", ")}`,
    } satisfies StepResult;
  }
  return {
    step: "inspect lol mock payload",
    ok: true,
    detail: `${urls.length} image urls, no media gallery`,
    stdout: JSON.stringify({ flags: message.flags, urls, hasGallery }, null, 2),
  } satisfies StepResult;
};

const reportMockRefusesNonTesting = () => {
  const [prodChannelId] = PRODUCTION_NOTIFICATION_CHANNEL_IDS;
  if (!prodChannelId) {
    return {
      step: "report-mock refuses non-testing Discord",
      ok: false,
      detail: "production channel denylist is empty",
    } satisfies StepResult;
  }
  const result = run(["admin", "report-mock", "--game", "lol", "--json"], {
    ...sharedEnv(),
    NOTIFICATION_CHANNEL_ID: prodChannelId,
  });
  const text = `${result.stdout}\n${result.stderr}\n${result.detail ?? ""}`;
  const refused = !result.ok && /riot-tracker-testing/.test(text);
  return {
    step: "report-mock refuses non-testing Discord",
    ok: refused,
    stdout: result.stdout,
    stderr: result.stderr,
    detail: refused
      ? testingDiscordRefusal(prodChannelId)
      : "report-mock did not refuse a non-testing channel",
  } satisfies StepResult;
};

const main = () => {
  mkdirSync(artifactDir, { recursive: true });
  if (exists(dbPath)) rmSync(dbPath);

  let riotId = "";
  try {
    riotId = resolveVerifyRiotId();
    console.log(`[verify] using riot id ${riotId}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  record({
    step: "discord destination",
    ok: true,
    detail: testingChannelId
      ? `riot-tracker-testing channel ${testingChannelId}`
      : "no allowlisted testing Discord destination; skipping Discord send",
  });

  record(run(["typecheck"]));
  if (!results.at(-1)?.ok) fail("typecheck failed", riotId);

  record(inspectLolMockReport());
  if (!results.at(-1)?.ok) fail("lol mock payload is not postable", riotId);

  record(reportMockRefusesNonTesting());
  if (!results.at(-1)?.ok) {
    fail("report-mock must refuse non-testing Discord", riotId);
  }

  if (testingChannelId) {
    startBot();
    const ready = waitForBotReady();
    record(ready);
    if (!ready.ok) fail("bot did not become ready", riotId);
  } else {
    record({
      step: "wait for discord gateway ready",
      ok: true,
      detail:
        "skipped bot boot; no allowlisted riot-tracker-testing destination",
    });
  }

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

  if (!testingChannelId) {
    record({
      step: "pnpm admin report-mock --game lol --json",
      ok: true,
      detail:
        "skipped Discord send; set VERIFY_NOTIFICATION_CHANNEL_ID or DISCORD_TEST_CHANNEL_URL to riot-tracker-testing",
    });
  } else {
    const reportMock = run(["admin", "report-mock", "--game", "lol", "--json"]);
    record(reportMock);
    if (!reportMock.ok) fail("report-mock failed", riotId);
    const reportPayload = parseJsonStdout(reportMock.stdout);
    if (reportPayload.channelId !== testingChannelId) {
      fail(
        "report-mock posted somewhere other than riot-tracker-testing",
        riotId,
      );
    }
    if (
      typeof reportPayload.flags !== "number" ||
      (reportPayload.flags & 32768) === 0
    ) {
      fail("report-mock was not a Components V2 message", riotId);
    }
  }

  record(run(["admin", "signout", devDiscordId, "--yes", "--json"]));

  record({
    step: "bot log tail",
    ok: true,
    stdout: testingChannelId ? captureBotLog() : "",
    detail: testingChannelId ? undefined : "bot was not started",
  });

  writeArtifacts(riotId);
  console.log(`[verify] passed; artifacts in ${artifactDir}`);
  if (testingChannelId) {
    console.log(`[verify] bot left running in tmux session ${botSession}`);
  } else {
    console.log(
      "[verify] Discord send skipped; bot was not started without riot-tracker-testing",
    );
  }
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
