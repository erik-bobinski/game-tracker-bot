import { Schema } from "effect";

const AdminStatus = Schema.fromJsonString(
  Schema.Struct({
    accounts: Schema.Array(
      Schema.Struct({
        riotId: Schema.String,
        games: Schema.Array(Schema.String),
      }),
    ),
  }),
);

const parseStatus = (stdout: string) => {
  const start = stdout.indexOf("{");
  const { accounts } = Schema.decodeUnknownSync(AdminStatus)(
    start >= 0 ? stdout.slice(start) : stdout,
  );
  const riotId = (
    accounts.find((account) => account.games.length > 0) ?? accounts[0]
  )?.riotId;
  if (!riotId) {
    throw new Error("production status returned no accounts");
  }
  return riotId;
};

const statusFromDb = (workspace: string, dbPath: string) => {
  const result = Bun.spawnSync(["bun", "run", "admin", "status", "--json"], {
    cwd: workspace,
    env: { ...Bun.env, DB_PATH: dbPath, LOG_LEVEL: "Warn" },
  });
  if (!result.success) {
    throw new Error(
      (
        result.stderr.toString() ||
        result.stdout.toString() ||
        "admin status failed"
      ).trim(),
    );
  }
  return parseStatus(result.stdout.toString());
};

const railwayEnv = () => ({
  ...Bun.env,
  // Cursor Cloud injects RAILWAY_API_KEY; the CLI expects RAILWAY_API_TOKEN.
  RAILWAY_API_TOKEN:
    Bun.env.RAILWAY_API_TOKEN ??
    Bun.env.RAILWAY_API_KEY ??
    Bun.env.RAILWAY_TOKEN,
});

const statusFromRailway = (workspace: string) => {
  const service = Bun.env.RAILWAY_SERVICE ?? "game-tracker-bot";
  const args = ["ssh", "--service", service];
  const project = Bun.env.RAILWAY_PROJECT_ID ?? Bun.env.RAILWAY_PROJECT;
  const environment =
    Bun.env.RAILWAY_ENVIRONMENT ?? Bun.env.RAILWAY_ENVIRONMENT_ID;
  if (project) {
    args.push("--project", project);
  }
  if (environment) {
    args.push("--environment", environment);
  }
  args.push("--", "bun", "run", "admin", "status", "--json");

  // the railway CLI comes from railway.com/install.sh, not the package.json
  if (!Bun.which("railway")) {
    throw new Error(
      "railway CLI not found; install it with `curl -fsSL https://railway.com/install.sh | sh`",
    );
  }
  const result = Bun.spawnSync(["railway", ...args], {
    cwd: workspace,
    env: railwayEnv(),
    timeout: 90_000,
  });
  if (!result.success) {
    throw new Error(
      (
        result.stderr.toString() ||
        result.stdout.toString() ||
        "railway ssh failed"
      ).trim(),
    );
  }
  return parseStatus(result.stdout.toString());
};

// Picks a real riot id for verification: explicit env, a copied prod sqlite,
// or live production via `railway ssh` when a Railway token is set.
export const resolveVerifyRiotId = async (workspace: string) => {
  if (Bun.env.VERIFY_RIOT_ID) {
    return Bun.env.VERIFY_RIOT_ID;
  }

  const productionDb = Bun.env.PRODUCTION_DB_PATH;
  if (productionDb && (await Bun.file(productionDb).exists())) {
    return statusFromDb(workspace, productionDb);
  }

  if (
    Bun.env.RAILWAY_API_KEY ||
    Bun.env.RAILWAY_API_TOKEN ||
    Bun.env.RAILWAY_TOKEN
  ) {
    return statusFromRailway(workspace);
  }

  throw new Error(
    "Set VERIFY_RIOT_ID, PRODUCTION_DB_PATH, or RAILWAY_API_TOKEN to use a real riot account",
  );
};
