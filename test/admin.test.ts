import { describe, expect, it } from "vitest";
import { Effect, Layer, Schema } from "effect";
import { Admin, AdminLive } from "../src/services/admin/index.ts";
import { AdminRequest } from "../src/services/admin/protocol.ts";
import { PollingStateLive } from "../src/services/polling/state.ts";
import {
  configLayer,
  databaseLayer,
  run,
  simulatedGameLayer,
} from "./helpers.ts";

const adminLayer = () => {
  const config = configLayer(":memory:");
  const database = databaseLayer(":memory:");
  const state = PollingStateLive.pipe(Layer.provideMerge(database));
  return AdminLive.pipe(
    Layer.provide(Layer.mergeAll(config, state, simulatedGameLayer())),
  );
};

describe("admin CLI workflows", () => {
  it("shares signup, rank, status, pause, and signout behavior", async () => {
    await run(
      Effect.gen(function* () {
        const admin = yield* Admin;
        const signup = yield* admin.dispatch({
          command: "signup",
          discord_user_id: "502202450183454721",
          discord_name: "Tester",
          riot_name: "MockAlpha",
          riot_tag: "NA1",
        });
        expect(signup).toMatchObject({
          ok: true,
          data: { type: "signup", value: { tracked_accounts: 1 } },
        });

        const rank = yield* admin.dispatch({
          command: "rank-check",
          discord_user_id: "502202450183454721",
          game: "val",
        });
        expect(rank).toMatchObject({
          ok: true,
          data: {
            type: "rank-check",
            value: { game: "val", rr: 38 },
          },
        });

        const paused = yield* admin.dispatch({ command: "pause" });
        expect(paused).toMatchObject({
          data: {
            type: "polling-state",
            value: { polling_paused: true },
          },
        });

        const status = yield* admin.dispatch({ command: "status" });
        expect(status).toMatchObject({
          data: {
            type: "status",
            value: { tracked_accounts: 1, polling_paused: true },
          },
        });

        const signout = yield* admin.dispatch({
          command: "signout",
          discord_user_id: "502202450183454721",
        });
        expect(signout).toMatchObject({
          ok: true,
          data: { type: "signout", value: { tracked_accounts: 0 } },
        });
      }).pipe(Effect.provide(adminLayer())),
    );
  });

  it("rejects malformed Discord IDs at the socket protocol boundary", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknownEffect(AdminRequest)({
        command: "signout",
        discord_user_id: "not-an-id",
      }).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
  });
});
