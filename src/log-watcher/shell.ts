import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect, Schema } from "effect";

const execFileAsync = promisify(execFile);

export class ShellError extends Schema.TaggedErrorClass<ShellError>()(
  "LogWatcher.ShellError",
  {
    command: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const sh = Effect.fn("LogWatcher.sh")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly env?: Record<string, string>;
  } = {},
) {
  const result = yield* Effect.tryPromise({
    try: () =>
      execFileAsync(command, [...args], {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
        env: options.env ? { ...process.env, ...options.env } : process.env,
      }),
    catch: (cause) =>
      new ShellError({ command: `${command} ${args[0]}`, cause }),
  });

  return result.stdout;
});
