import { NodeRuntime } from "@effect/platform-node";
import { Config, Effect } from "effect";
import process from "node:process";
import { DEFAULT_SOCKET_PATH } from "./services/admin/index.ts";
import type { AdminRequest } from "./services/admin/protocol.ts";
import { sendAdminRequest } from "./services/admin/socket.ts";

const usage = `Usage:
  pnpm admin -- status|pause|resume [--json]
  pnpm admin -- signout ID [--json]
  pnpm admin -- rank-check ID lol|valorant [--json]
  pnpm admin -- signup ID DISCORD_NAME RIOT_NAME RIOT_TAG [--json]`;

const required = (args: ReadonlyArray<string>, index: number) => {
  const value = args[index];
  if (!value) throw new Error("Missing argument");
  return value;
};

const discordId = (args: ReadonlyArray<string>, index: number) => {
  const value = required(args, index);
  if (!/^\d+$/.test(value)) throw new Error("Discord ID must be numeric");
  return value;
};

const parse = (args: ReadonlyArray<string>): AdminRequest => {
  switch (args[0]) {
    case "status":
    case "pause":
    case "resume":
      return { command: args[0] };
    case "signout":
      return { command: "signout", discordUserId: discordId(args, 1) };
    case "rank-check": {
      const game = required(args, 2);
      if (game !== "lol" && game !== "valorant") {
        throw new Error("Game must be lol or valorant");
      }
      return {
        command: "rank-check",
        discordUserId: discordId(args, 1),
        game,
      };
    }
    case "signup":
      return {
        command: "signup",
        discordUserId: discordId(args, 1),
        discordName: required(args, 2),
        riotName: required(args, 3),
        riotTag: required(args, 4),
      };
    default:
      throw new Error("Unknown command");
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
    const response = yield* sendAdminRequest(socketPath, request);
    console[response.ok ? "log" : "error"](
      json ? JSON.stringify(response, undefined, 2) : response.message,
    );
    process.exitCode = response.ok ? 0 : 4;
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
