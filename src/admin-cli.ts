import { NodeRuntime } from "@effect/platform-node";
import { Config, Effect } from "effect";
import process from "node:process";
import { DEFAULT_SOCKET_PATH } from "./services/admin/index.ts";
import type { AdminRequest, AdminResponse } from "./services/admin/protocol.ts";
import { sendAdminRequest } from "./services/admin/socket.ts";

const usage = `Usage:
  riot-tracker-bot admin [--json] status|pause|resume
  riot-tracker-bot admin [--json] signout --discord-user-id ID
  riot-tracker-bot admin [--json] rank-check --discord-user-id ID --game val|lol
  riot-tracker-bot admin [--json] signup --discord-user-id ID --discord-name NAME --riot-name NAME --riot-tag TAG`;

const option = (args: ReadonlyArray<string>, name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

const required = (args: ReadonlyArray<string>, name: string) => {
  const value = option(args, name);
  if (value === undefined || value.length === 0)
    throw new Error(`Missing ${name}`);
  return value;
};

const discordId = (args: ReadonlyArray<string>) => {
  const value = required(args, "--discord-user-id");
  if (!/^\d+$/.test(value))
    throw new Error("--discord-user-id must be numeric");
  return value;
};

const parse = (args: ReadonlyArray<string>): AdminRequest => {
  const command = args.find((arg) => !arg.startsWith("--"));
  switch (command) {
    case "status":
    case "pause":
    case "resume":
      return { command };
    case "signout":
      return { command, discord_user_id: discordId(args) };
    case "signup":
      return {
        command,
        discord_user_id: discordId(args),
        discord_name: required(args, "--discord-name"),
        riot_name: required(args, "--riot-name"),
        riot_tag: required(args, "--riot-tag"),
      };
    case "rank-check": {
      const game = required(args, "--game");
      if (game !== "val" && game !== "lol") {
        throw new Error("--game must be val or lol");
      }
      return { command, discord_user_id: discordId(args), game };
    }
    default:
      throw new Error("Missing or unknown admin command");
  }
};

const printHuman = (response: AdminResponse) => {
  if (response.error !== undefined) {
    console.error(`${response.error.code}: ${response.error.message}`);
    return;
  }
  const data = response.data;
  if (data === undefined) return;
  switch (data.type) {
    case "signup":
      console.log(
        `Signed up ${data.value.discord_name} (Discord ID ${data.value.discord_user_id}) as ${data.value.riot_name}#${data.value.riot_tag}.\nTracked accounts: ${data.value.tracked_accounts}`,
      );
      break;
    case "signout":
      console.log(
        `Signed out ${data.value.discord_name} (Discord ID ${data.value.discord_user_id}).\nTracked accounts: ${data.value.tracked_accounts}`,
      );
      break;
    case "polling-state":
      console.log(
        `Polling ${data.value.polling_paused ? "paused" : "resumed"}.`,
      );
      break;
    case "rank-check":
      if (data.value.game === "val") {
        console.log(
          `${data.value.discord_name}: ${data.value.tier} - ${data.value.rr} RR`,
        );
      } else {
        const division = data.value.division ? ` ${data.value.division}` : "";
        console.log(
          `${data.value.discord_name}: ${data.value.tier}${division} - ${data.value.league_points} LP (${data.value.queue})`,
        );
      }
      break;
    case "status":
      console.log(
        `Admin socket: available\nTracked accounts: ${data.value.tracked_accounts}\nPolling: ${data.value.polling_paused ? "paused" : "active"}\nDatabase: ${data.value.database_path}\nSchema version: ${data.value.schema_version}`,
      );
  }
};

export const isAdminCli = process.argv[2] === "admin";

export const runAdminCli = () => {
  const json = process.argv.includes("--json");
  let request: AdminRequest;
  try {
    request = parse(process.argv.slice(3).filter((arg) => arg !== "--json"));
  } catch (error) {
    console.error(`${String(error)}\n${usage}`);
    process.exitCode = 2;
    return;
  }

  const program = Effect.gen(function* () {
    const socketPath = yield* Config.string("ADMIN_SOCKET_PATH").pipe(
      Config.withDefault(DEFAULT_SOCKET_PATH),
    );
    const response = yield* sendAdminRequest(socketPath, request).pipe(
      Effect.timeoutOrElse({
        duration: "4 seconds",
        orElse: () => Effect.fail(new Error("admin socket timed out")),
      }),
    );
    if (json) console.log(JSON.stringify(response, undefined, 2));
    else printHuman(response);
    process.exitCode = response.error?.exit_code ?? 0;
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(`Admin socket unavailable: ${String(error)}`);
        process.exitCode = 3;
      }),
    ),
  );
  NodeRuntime.runMain(program);
};
