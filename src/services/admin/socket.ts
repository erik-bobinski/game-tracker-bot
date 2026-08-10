import { NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { Deferred, Effect, Fiber, Schema, type Scope } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import { chmod, rm } from "node:fs/promises";
import { Admin } from "./index.ts";
import { AdminRequest, AdminResponse } from "./protocol.ts";

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
        return newline < 0
          ? Effect.void
          : Deferred.succeed(line, buffer.slice(0, newline));
      })
      .pipe(Effect.forkScoped);
    return yield* Deferred.await(line);
  });

const parseJson = (input: string) =>
  Effect.try({
    try: () => JSON.parse(input) as unknown,
    catch: (cause) => cause,
  });

const decodeRequest = (input: string) =>
  parseJson(input).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AdminRequest)),
  );

const decodeResponse = (input: string) =>
  parseJson(input).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AdminResponse)),
  );

export const serveAdmin = Effect.fn("Admin.serve")(function* () {
  const admin = yield* Admin;
  yield* Effect.tryPromise({
    try: () => rm(admin.socketPath, { force: true }),
    catch: (cause) => cause,
  });
  const server = yield* NodeSocketServer.make({ path: admin.socketPath });
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => rm(admin.socketPath, { force: true })),
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
          Effect.flatMap(decodeRequest),
          Effect.flatMap(admin.dispatch),
          Effect.catch((error) =>
            Effect.succeed({
              ok: false,
              message: `Invalid request: ${String(error)}`,
            }),
          ),
        );
        yield* writer(`${JSON.stringify(response)}\n`);
      }),
    ).pipe(
      Effect.catch((error) => Effect.logError("admin socket error", error)),
    ),
  );
});

export const sendAdminRequest = (socketPath: string, request: AdminRequest) =>
  Effect.scoped(
    Effect.gen(function* () {
      const socket = yield* NodeSocket.makeNet({
        path: socketPath,
        openTimeout: "3 seconds",
      });
      const writer = yield* socket.writer;
      const response = readLine(socket).pipe(
        Effect.flatMap(decodeResponse),
        Effect.forkScoped,
      );
      yield* writer(`${JSON.stringify(request)}\n`);
      return yield* Fiber.join(yield* response);
    }),
  );
