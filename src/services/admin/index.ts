import { Context, Effect, Layer, SubscriptionRef } from "effect";
import { AppConfig } from "../config.ts";
import type { Account } from "../database/index.ts";
import { Database, SCHEMA_VERSION } from "../database/index.ts";
import {
  rankCheckWorkflow,
  signoutWorkflow,
  signupWorkflow,
} from "../discord/workflows.ts";
import { GameAdapters } from "../game/game-adapters/index.ts";
import type { GameId, RankSummary } from "../game/index.ts";
import { PollingState } from "../polling/state.ts";
import {
  type AdminRequest,
  type AdminResponse,
  type AdminResponseData,
  failure,
} from "./protocol.ts";

export const DEFAULT_SOCKET_PATH = "/tmp/riot-tracker-bot-admin.sock";

export class Admin extends Context.Service<
  Admin,
  {
    readonly socketPath: string;
    readonly dispatch: (request: AdminRequest) => Effect.Effect<AdminResponse>;
  }
>()("app/Admin") {}

const identity = (account: Account) => ({
  discord_user_id: account.discordUserId,
  discord_name: account.discordName,
  riot_name: account.riotName,
  riot_tag: account.riotTag,
});

const numericPoints = (rank: RankSummary) =>
  Number.parseInt(rank.pointsLabel ?? "0", 10);

const lolTier = (label: string) => {
  const parts = label.split(" ");
  const division = parts.at(-1) ?? "";
  return /^[IV]+$/.test(division)
    ? { tier: parts.slice(0, -1).join(" "), division }
    : { tier: label, division: "" };
};

const makeAdmin = Effect.gen(function* () {
  const config = yield* AppConfig;
  const database = yield* Database;
  const gameAdapters = yield* GameAdapters;
  const pollingState = yield* PollingState;
  const workflowDeps = { database, gameAdapters };

  const reject = (
    command: string,
    code: string,
    message: string,
    exitCode = 4,
  ) => Effect.succeed(failure(command, code, message, exitCode));

  const success = (
    command: string,
    data: AdminResponseData,
  ): AdminResponse => ({ ok: true, command, data });

  const dispatch = Effect.fn("Admin.dispatch")(function* (
    request: AdminRequest,
  ) {
    const command = request.command;
    return yield* Effect.gen(function* () {
      switch (request.command) {
        case "signup": {
          if (yield* database.hasAccount(request.discord_user_id)) {
            return yield* reject(
              command,
              "already_tracked",
              `Discord user ${request.discord_user_id} is already tracked`,
            );
          }
          const message = yield* signupWorkflow(workflowDeps, {
            discordUserId: request.discord_user_id,
            discordName: request.discord_name,
            riotName: request.riot_name,
            riotTag: request.riot_tag,
          });
          const account = yield* database.getAccount(request.discord_user_id);
          if (!account) {
            const upstreamFailed = message.includes("Could not check");
            return yield* reject(
              command,
              upstreamFailed
                ? "upstream_unavailable"
                : "riot_account_not_found",
              message,
              upstreamFailed ? 5 : 4,
            );
          }
          return success(command, {
            type: "signup",
            value: {
              ...identity(account),
              tracked_accounts: (yield* database.getAccounts()).length,
            },
          });
        }
        case "signout": {
          const account = yield* database.getAccount(request.discord_user_id);
          if (!account) {
            return yield* reject(
              command,
              "not_found",
              `Discord user ${request.discord_user_id} is not tracked`,
            );
          }
          yield* signoutWorkflow(database, request.discord_user_id);
          return success(command, {
            type: "signout",
            value: {
              ...identity(account),
              tracked_accounts: (yield* database.getAccounts()).length,
            },
          });
        }
        case "pause":
        case "resume": {
          const paused = request.command === "pause";
          yield* SubscriptionRef.set(pollingState.paused, paused);
          return success(command, {
            type: "polling-state",
            value: { polling_paused: paused },
          });
        }
        case "rank-check": {
          const game: GameId = request.game === "val" ? "valorant" : "lol";
          const rankResult = yield* rankCheckWorkflow(
            workflowDeps,
            request.discord_user_id,
            game,
          ).pipe(Effect.result);
          if (rankResult._tag === "Failure") {
            return yield* reject(
              command,
              "upstream_unavailable",
              `${game} rank lookup failed`,
              5,
            );
          }
          const result = rankResult.success;
          if (result._tag === "Message") {
            const code =
              result.content === "Unranked." ? "unranked" : "not_found";
            return yield* reject(command, code, result.content);
          }
          const rank = result.ranks[0];
          if (!rank) return yield* reject(command, "unranked", "Unranked.");
          if (request.game === "val") {
            return success(command, {
              type: "rank-check",
              value: {
                game: "val",
                discord_user_id: request.discord_user_id,
                discord_name: result.discordName,
                tier: rank.label,
                rr: numericPoints(rank),
                image_url: result.iconUrl ?? "",
              },
            });
          }
          const { tier, division } = lolTier(rank.label);
          return success(command, {
            type: "rank-check",
            value: {
              game: "lol",
              discord_user_id: request.discord_user_id,
              discord_name: result.discordName,
              tier,
              division,
              league_points: numericPoints(rank),
              queue: rank.queueLabel ?? "",
              image_url: result.iconUrl ?? "",
            },
          });
        }
        case "status": {
          return success(command, {
            type: "status",
            value: {
              socket_available: true,
              tracked_accounts: (yield* database.getAccounts()).length,
              polling_paused: yield* SubscriptionRef.get(pollingState.paused),
              database_path: config.dbPath,
              schema_version: SCHEMA_VERSION,
            },
          });
        }
      }
    }).pipe(
      Effect.catch((cause) =>
        Effect.logError("admin command failed", cause).pipe(
          Effect.annotateLogs({ command }),
          Effect.as(failure(command, "database_error", String(cause), 5)),
        ),
      ),
    );
  });

  return Admin.of({ socketPath: config.adminSocketPath, dispatch });
});

export const AdminLive = Layer.effect(Admin, makeAdmin);
