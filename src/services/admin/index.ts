import { Config, Context, Effect, Layer, SubscriptionRef } from "effect";
import { Database } from "../database/index.ts";
import { registerAccount } from "../discord/commands.ts";
import { gameNames } from "../discord/embed.ts";
import { GameAdapters } from "../game/game-adapters/index.ts";
import { PollingState } from "../polling/state.ts";
import type { AdminRequest, AdminResponse } from "./protocol.ts";

export const DEFAULT_SOCKET_PATH = "/tmp/riot-tracker-bot-admin.sock";

export class Admin extends Context.Service<
  Admin,
  {
    readonly socketPath: string;
    readonly dispatch: (request: AdminRequest) => Effect.Effect<AdminResponse>;
  }
>()("app/Admin") {}

const makeAdmin = Effect.gen(function* () {
  const database = yield* Database;
  const gameAdapters = yield* GameAdapters;
  const pollingState = yield* PollingState;
  const socketPath = yield* Config.string("ADMIN_SOCKET_PATH").pipe(
    Config.withDefault(DEFAULT_SOCKET_PATH),
  );

  const dispatch = Effect.fn("Admin.dispatch")(function* (
    request: AdminRequest,
  ) {
    return yield* Effect.gen(function* () {
      switch (request.command) {
        case "signup": {
          if (yield* database.hasAccount(request.discordUserId)) {
            return {
              ok: false,
              message: "That Discord user is already tracked.",
            };
          }
          const result = yield* registerAccount(
            { database, gameAdapters },
            {
              discordUserId: request.discordUserId,
              discordName: request.discordName,
              riotName: request.riotName,
              riotTag: request.riotTag,
            },
          );
          return result === "ok"
            ? { ok: true, message: `Signed up ${request.discordName}.` }
            : { ok: false, message: "Riot account not found." };
        }
        case "signout": {
          if (!(yield* database.hasAccount(request.discordUserId))) {
            return { ok: false, message: "That Discord user is not tracked." };
          }
          yield* database.deleteAccount(request.discordUserId);
          return { ok: true, message: "Account deleted." };
        }
        case "pause":
        case "resume": {
          const paused = request.command === "pause";
          yield* SubscriptionRef.set(pollingState.paused, paused);
          return {
            ok: true,
            message: `Polling ${paused ? "paused" : "resumed"}.`,
          };
        }
        case "rank-check": {
          const account = yield* database.getAccount(request.discordUserId);
          const game = account?.games[request.game];
          if (!account || !game) {
            return {
              ok: false,
              message: `That Discord user is not tracked for ${gameNames[request.game]}.`,
            };
          }
          const adapter = gameAdapters.all.find(
            (candidate) => candidate.game === request.game,
          );
          if (!adapter) {
            return {
              ok: false,
              message: `${gameNames[request.game]} is not supported.`,
            };
          }
          const rank = yield* adapter.getRank(game.puuid, game.region);
          return rank
            ? {
                ok: true,
                message: `${account.discordName}: ${rank.tier}${rank.detail ? ` (${rank.detail})` : ""}`,
                data: rank,
              }
            : { ok: true, message: `${account.discordName}: Unranked.` };
        }
        case "status": {
          return {
            ok: true,
            message: "Admin socket available.",
            data: {
              trackedAccounts: (yield* database.getAccounts()).length,
              pollingPaused: yield* SubscriptionRef.get(pollingState.paused),
            },
          };
        }
      }
    }).pipe(
      Effect.catch((cause) =>
        Effect.logError("admin command failed", cause).pipe(
          Effect.as({ ok: false, message: String(cause) }),
        ),
      ),
    );
  });

  return Admin.of({ socketPath, dispatch });
});

export const AdminLive = Layer.effect(Admin, makeAdmin);
