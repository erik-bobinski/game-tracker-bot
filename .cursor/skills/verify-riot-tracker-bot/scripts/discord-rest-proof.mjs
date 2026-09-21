#!/usr/bin/env node
// Proves the mock report reached Discord.
// Lists global slash commands, posts with `pnpm admin report-mock`, and reads
// the channel message back. Does not log into Discord and does not print
// tokens, emails, or passwords.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const workspace = join(dirname(scriptPath), "../../../..");
const runId = process.env.VERIFY_RUN_ID ?? `discord-${Date.now()}`;
const artifactDir =
  process.env.VERIFY_ARTIFACT_DIR ?? `/opt/cursor/artifacts/verify-${runId}`;
const dbPath = `/tmp/riot-verify-${runId}.sqlite`;
const service = process.env.RAILWAY_SERVICE ?? "riot-tracker-bot";

const secretKey = (key) =>
  /TOKEN|KEY|PASSWORD|SECRET|EMAIL/i.test(key) && !key.endsWith("_NAMES");

const redact = (text) => {
  let out = String(text ?? "");
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8 || !secretKey(key)) continue;
    out = out.split(value).join(`[redacted:${key}]`);
  }
  return out;
};

const writeJson = (name, value) => {
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, name), `${JSON.stringify(value, null, 2)}\n`);
};

const browserStatus = () => {
  const missing = [
    "AGENT_EMAIL",
    "AGENT_EMAIL_PASSWORD",
    "DISCORD_TEST_CHANNEL_URL",
  ].filter((key) => !process.env[key]);
  if (missing.length > 0) {
    return {
      status: "blocked",
      reason:
        "AGENT_EMAIL, AGENT_EMAIL_PASSWORD, or DISCORD_TEST_CHANNEL_URL is unset. Do not log into Discord. Prove the channel with the bot token.",
      missing,
    };
  }
  return {
    status: "ready",
    reason:
      "UI secrets are set. Drive Discord in the browser as SKILL.md describes. This script does not log in. Stop if captcha, an email code, or 2FA appears.",
  };
};

const fail = (message, extra = {}) => {
  writeJson("results.json", {
    runId,
    ok: false,
    error: message,
    ...extra,
  });
  console.error(`[discord-proof] ${message}`);
  process.exit(1);
};

const railwayEnvironment = () => {
  if (process.env.VERIFY_RAILWAY_ENVIRONMENT) {
    return process.env.VERIFY_RAILWAY_ENVIRONMENT;
  }
  if (process.env.RAILWAY_API_TOKEN_DEV || process.env.RAILWAY_TOKEN) {
    return process.env.RAILWAY_API_TOKEN_DEV ? "dev" : "production";
  }
  if (process.env.RAILWAY_API_TOKEN_PROD) return "production";
  return "";
};

const projectToken = (environment) => {
  if (process.env.RAILWAY_TOKEN && !process.env.RAILWAY_API_TOKEN_DEV) {
    return process.env.RAILWAY_TOKEN;
  }
  if (environment === "dev" && process.env.RAILWAY_API_TOKEN_DEV) {
    return process.env.RAILWAY_API_TOKEN_DEV;
  }
  if (environment === "production" && process.env.RAILWAY_API_TOKEN_PROD) {
    return process.env.RAILWAY_API_TOKEN_PROD;
  }
  return process.env.RAILWAY_TOKEN ?? "";
};

const enterRailway = (environment) => {
  const token = projectToken(environment);
  if (!token) {
    fail(
      "DISCORD_BOT_TOKEN is unset and no Railway project token is available (RAILWAY_TOKEN, RAILWAY_API_TOKEN_DEV, or RAILWAY_API_TOKEN_PROD)",
      { browser: browserStatus() },
    );
  }

  const env = {
    ...process.env,
    RAILWAY_TOKEN: token,
    DISCORD_REST_PROOF_INNER: "1",
    VERIFY_RUN_ID: runId,
    VERIFY_ARTIFACT_DIR: artifactDir,
    VERIFY_RAILWAY_ENVIRONMENT: environment,
  };
  // A project token in RAILWAY_API_TOKEN does not select the project.
  delete env.RAILWAY_API_TOKEN;

  console.log(
    `[discord-proof] loading ${environment} service env via railway run (values stay in the child)`,
  );
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "railway",
      "run",
      "--service",
      service,
      "--environment",
      environment,
      "--",
      "node",
      scriptPath,
    ],
    { cwd: workspace, env, encoding: "utf8" },
  );
  if (result.stdout) process.stdout.write(redact(result.stdout));
  if (result.stderr) process.stderr.write(redact(result.stderr));
  process.exit(result.status ?? 1);
};

const parseJson = (stdout) => {
  const start = stdout.indexOf("{");
  if (start < 0) {
    throw new Error(`no json in admin stdout: ${redact(stdout).slice(0, 240)}`);
  }
  return JSON.parse(stdout.slice(start));
};

const discordFetch = async (path) => {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN missing in proof process");
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Discord ${path} failed (${response.status}): ${redact(text).slice(0, 300)}`,
    );
  }
  return JSON.parse(text);
};

const waitForBot = (chunks, timeoutMs) =>
  new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const output = chunks.join("");
      const ready =
        /discord gateway ready/.test(output) ||
        (/slash commands registered/.test(output) &&
          /application started/.test(output));
      if (ready) {
        clearInterval(timer);
        resolve({ ok: true, output });
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        resolve({ ok: false, output });
      }
    }, 500);
  });

const startBot = () => {
  const chunks = [];
  const child = spawn("pnpm", ["start"], {
    cwd: workspace,
    detached: true,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      DEV_MODE: "true",
      LOG_LEVEL: "Info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (buf) => chunks.push(buf.toString());
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return { child, chunks };
};

const stopBot = (child) => {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }
  }
};

const messageEmbed = (message) => message.embeds?.[0];

const savedBrowser = () => {
  try {
    return JSON.parse(readFileSync(join(artifactDir, "browser.json"), "utf8"));
  } catch {
    return browserStatus();
  }
};

const prove = async () => {
  const environment = process.env.VERIFY_RAILWAY_ENVIRONMENT ?? "local";
  const startGateway = environment !== "production";
  let bot = null;
  let boot = { ok: false, output: "" };

  try {
    if (startGateway) {
      console.log("[discord-proof] starting bot with DEV_MODE=true");
      bot = startBot();
      boot = await waitForBot(bot.chunks, 60_000);
      writeFileSync(join(artifactDir, "bot.log"), redact(boot.output));
      console.log(
        `[discord-proof] bot ${boot.ok ? "up" : "not ready before timeout"}`,
      );
    } else {
      console.log(
        "[discord-proof] production environment: REST only, gateway left to the live service",
      );
    }

    const application = await discordFetch("/applications/@me");
    const commands = await discordFetch(
      `/applications/${application.id}/commands`,
    );
    const names = commands.map((command) => command.name).sort();
    writeJson("slash-commands.json", {
      applicationId: application.id,
      names,
    });
    console.log(`[discord-proof] commands: ${names.join(", ")}`);

    const channelId = process.env.NOTIFICATION_CHANNEL_ID;
    if (!channelId) throw new Error("NOTIFICATION_CHANNEL_ID missing");

    const before = await discordFetch(
      `/channels/${channelId}/messages?limit=20`,
    );
    const beforeIds = new Set(before.map((message) => message.id));

    const admin = spawnSync(
      "pnpm",
      ["admin", "report-mock", "--game", "lol", "--json"],
      {
        cwd: workspace,
        encoding: "utf8",
        env: {
          ...process.env,
          DB_PATH: dbPath,
          LOG_LEVEL: "Warn",
        },
      },
    );
    if (admin.status !== 0) {
      throw new Error(
        `report-mock failed: ${redact(admin.stderr || admin.stdout)}`,
      );
    }
    const report = parseJson(admin.stdout ?? "");
    console.log(
      `[discord-proof] posted match ${report.matchId} to channel ${report.channelId}`,
    );

    const after = await discordFetch(
      `/channels/${report.channelId}/messages?limit=20`,
    );
    const created = after.find((message) => !beforeIds.has(message.id));
    const embed = created ? messageEmbed(created) : undefined;
    if (!created || !embed?.title) {
      throw new Error("posted report did not appear in the channel history");
    }

    const testUrl = process.env.DISCORD_TEST_CHANNEL_URL ?? "";
    const urlChannel = testUrl.split("/").filter(Boolean).at(-1) ?? "";
    const channelNote = urlChannel
      ? {
          testChannelMatchesNotification: urlChannel === report.channelId,
        }
      : {
          testChannelMatchesNotification: null,
          note: "DISCORD_TEST_CHANNEL_URL unset; embed was checked on NOTIFICATION_CHANNEL_ID",
        };

    writeJson("report.json", {
      game: report.game,
      channelId: report.channelId,
      matchId: report.matchId,
      messageId: created.id,
      embedTitle: embed.title,
      embedDescription: String(embed.description ?? "").slice(0, 240),
      ...channelNote,
    });
    writeJson("results.json", {
      runId,
      ok: true,
      environment,
      browser: savedBrowser(),
      botStarted: startGateway,
      botReady: boot.ok,
      devReportRegistered: names.includes("dev_report"),
      commands: names,
      messageId: created.id,
      embedTitle: embed.title,
      matchId: report.matchId,
      channelId: report.channelId,
    });
    console.log(`[discord-proof] embed "${embed.title}" message ${created.id}`);
    if (startGateway && !names.includes("dev_report")) {
      console.error(
        "[discord-proof] dev_report was not in the global command list",
      );
      process.exitCode = 1;
    }
  } finally {
    if (bot) stopBot(bot.child);
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
};

const main = async () => {
  mkdirSync(artifactDir, { recursive: true });
  if (process.env.DISCORD_REST_PROOF_INNER !== "1") {
    writeJson("browser.json", browserStatus());
  }

  if (!process.env.DISCORD_BOT_TOKEN) {
    if (process.env.DISCORD_REST_PROOF_INNER === "1") {
      fail("railway run did not provide DISCORD_BOT_TOKEN");
    }
    const environment = railwayEnvironment();
    if (!environment) {
      fail(
        "DISCORD_BOT_TOKEN is unset and no Railway project token is available",
        { browser: browserStatus() },
      );
    }
    enterRailway(environment);
    return;
  }

  await prove();
};

main().catch((error) => {
  const message = redact(
    error instanceof Error ? error.message : String(error),
  );
  try {
    writeJson("results.json", { runId, ok: false, error: message });
  } catch {
    // artifact dir may be the failure
  }
  console.error(`[discord-proof] ${message}`);
  process.exit(1);
});
