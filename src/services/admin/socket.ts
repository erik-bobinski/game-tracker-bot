import { NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { Deferred, Effect, Fiber, Schema, type Scope } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import { chmod, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { Admin } from "./index.ts";
import { AdminRequest, AdminResponse, failure } from "./protocol.ts";

const readLine = (
  socket: Socket.Socket,
): Effect.Effect<string, Socket.SocketError, Scope.Scope> =>
  Effect.gen(function* () {
    const line = yield* Deferred.make<string>();
    let buffer = "";
    yield* socket
      .runString((chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        return newline >= 0
          ? Deferred.succeed(line, buffer.slice(0, newline))
          : Effect.void;
      })
      .pipe(Effect.forkScoped);
    return yield* Deferred.await(line);
  });

const parseJson = (input: string): Effect.Effect<unknown, unknown> =>
  Effect.try({
    try: () => JSON.parse(input) as unknown,
    catch: (cause) => cause,
  });

const socketIsActive = (path: string) =>
  Effect.promise(
    () =>
      new Promise<boolean>((resolve) => {
        const socket = createConnection(path);
        let settled = false;
        const finish = (active: boolean) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(active);
        };
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.setTimeout(500, () => finish(false));
      }),
  );

export const makeAdminServer = Effect.fn("AdminServer.make")(function* () {
  const admin = yield* Admin;
  if (yield* socketIsActive(admin.socketPath)) {
    return yield* Effect.fail(
      new Error(`admin socket ${admin.socketPath} is already active`),
    );
  }
  yield* Effect.tryPromise({
    try: () => rm(admin.socketPath, { force: true }),
    catch: (cause) => cause,
  });
  const server = yield* NodeSocketServer.make({ path: admin.socketPath });
  yield* Effect.addFinalizer(() =>
    Effect.tryPromise({
      try: () => rm(admin.socketPath, { force: true }),
      catch: (cause) => cause,
    }).pipe(Effect.ignore),
  );
  yield* Effect.tryPromise({
    try: () => chmod(admin.socketPath, 0o600),
    catch: (cause) => cause,
  });
  yield* Effect.logInfo("admin socket ready").pipe(
    Effect.annotateLogs({ path: admin.socketPath }),
  );

  return server.run((socket) =>
    Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* socket.writer;
        const response = yield* readLine(socket).pipe(
          Effect.flatMap(parseJson),
          Effect.flatMap(Schema.decodeUnknownEffect(AdminRequest)),
          Effect.flatMap(admin.dispatch),
          Effect.catch((error) =>
            Effect.succeed(
              failure(
                "unknown",
                "invalid_request",
                `Malformed request: ${String(error)}`,
                4,
              ),
            ),
          ),
        );
        yield* writer(`${JSON.stringify(response)}\n`);
      }),
    ).pipe(
      Effect.catch((error) => Effect.logError("admin connection error", error)),
    ),
  );
});

export const sendAdminRequest = (
  socketPath: string,
  request: AdminRequest,
): Effect.Effect<AdminResponse, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const socket = yield* NodeSocket.makeNet({
        path: socketPath,
        openTimeout: "3 seconds",
      });
      const writer = yield* socket.writer;
      const response = readLine(socket).pipe(
        Effect.flatMap(parseJson),
        Effect.flatMap(Schema.decodeUnknownEffect(AdminResponse)),
        Effect.forkScoped,
      );
      yield* writer(`${JSON.stringify(request)}\n`);
      return yield* Fiber.join(yield* response);
    }),
  );
