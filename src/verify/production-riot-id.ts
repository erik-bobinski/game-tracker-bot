import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

interface StatusAccount {
  readonly riotId: string;
  readonly games: ReadonlyArray<string>;
}

interface AdminStatus {
  readonly accounts: ReadonlyArray<StatusAccount>;
}

const pickRiotId = (status: AdminStatus) => {
  const withGames = status.accounts.filter((account) => account.games.length > 0);
  return (withGames[0] ?? status.accounts[0])?.riotId;
};

const parseStatus = (stdout: string) => {
  const start = stdout.indexOf("{");
  const status = JSON.parse(start >= 0 ? stdout.slice(start) : stdout) as AdminStatus;
  const riotId = pickRiotId(status);
  if (!riotId) {
    throw new Error("production status returned no accounts");
  }
  return riotId;
};

const statusFromDb = (workspace: string, dbPath: string) => {
  const result = spawnSync("pnpm", ["admin", "status", "--json"], {
    cwd: workspace,
    env: { ...process.env, DB_PATH: dbPath, LOG_LEVEL: "Warn" },
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "admin status failed").trim(),
    );
  }
  return parseStatus(result.stdout);
};

const railwayEnv = () => ({
  ...process.env,
  // Cursor Cloud injects RAILWAY_API_KEY; the CLI expects RAILWAY_API_TOKEN.
  RAILWAY_API_TOKEN:
    process.env.RAILWAY_API_TOKEN ??
    process.env.RAILWAY_API_KEY ??
    process.env.RAILWAY_TOKEN,
});

const statusFromRailway = (workspace: string) => {
  const service = process.env.RAILWAY_SERVICE ?? "riot-tracker-bot";
  const args = ["exec", "railway", "ssh", "--service", service];
  const project = process.env.RAILWAY_PROJECT_ID ?? process.env.RAILWAY_PROJECT;
  const environment =
    process.env.RAILWAY_ENVIRONMENT ?? process.env.RAILWAY_ENVIRONMENT_ID;
  if (project) {
    args.push("--project", project);
  }
  if (environment) {
    args.push("--environment", environment);
  }
  args.push("--", "pnpm", "admin", "status", "--json");

  const result = spawnSync("pnpm", args, {
    cwd: workspace,
    env: railwayEnv(),
    encoding: "utf-8",
    timeout: 90_000,
  });
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "railway ssh failed").trim(),
    );
  }
  return parseStatus(result.stdout);
};

// Picks a real riot id for verification: explicit env, a copied prod sqlite,
// or live production via `railway ssh` when a Railway token is set.
export const resolveVerifyRiotId = (workspace: string) => {
  if (process.env.VERIFY_RIOT_ID) {
    return process.env.VERIFY_RIOT_ID;
  }

  const productionDb = process.env.PRODUCTION_DB_PATH;
  if (productionDb && existsSync(productionDb)) {
    return statusFromDb(workspace, productionDb);
  }

  if (
    process.env.RAILWAY_API_KEY ||
    process.env.RAILWAY_API_TOKEN ||
    process.env.RAILWAY_TOKEN
  ) {
    return statusFromRailway(workspace);
  }

  throw new Error(
    "Set VERIFY_RIOT_ID, PRODUCTION_DB_PATH, or RAILWAY_API_TOKEN to use a real riot account",
  );
};
