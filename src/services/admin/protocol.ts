import { Schema } from "effect";

const DiscordUserId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d+$/)),
);

export const AdminRequest = Schema.Union([
  Schema.Struct({
    command: Schema.tag("signup"),
    discord_user_id: DiscordUserId,
    discord_name: Schema.String,
    riot_name: Schema.String,
    riot_tag: Schema.String,
  }),
  Schema.Struct({
    command: Schema.tag("signout"),
    discord_user_id: DiscordUserId,
  }),
  Schema.Struct({ command: Schema.tag("pause") }),
  Schema.Struct({ command: Schema.tag("resume") }),
  Schema.Struct({
    command: Schema.tag("rank-check"),
    discord_user_id: DiscordUserId,
    game: Schema.Literals(["val", "lol"]),
  }),
  Schema.Struct({ command: Schema.tag("status") }),
]);
export type AdminRequest = typeof AdminRequest.Type;

export const AccountIdentity = Schema.Struct({
  discord_user_id: Schema.String,
  discord_name: Schema.String,
  riot_name: Schema.String,
  riot_tag: Schema.String,
});

export const SignupResult = Schema.Struct({
  ...AccountIdentity.fields,
  tracked_accounts: Schema.Number,
});

export const SignoutResult = SignupResult;

export const PollingStateResult = Schema.Struct({
  polling_paused: Schema.Boolean,
});

export const RankCheckResult = Schema.Union([
  Schema.Struct({
    game: Schema.tag("val"),
    discord_user_id: Schema.String,
    discord_name: Schema.String,
    tier: Schema.String,
    rr: Schema.Number,
    image_url: Schema.String,
  }),
  Schema.Struct({
    game: Schema.tag("lol"),
    discord_user_id: Schema.String,
    discord_name: Schema.String,
    tier: Schema.String,
    division: Schema.String,
    league_points: Schema.Number,
    queue: Schema.String,
    image_url: Schema.String,
  }),
]);

export const StatusResult = Schema.Struct({
  socket_available: Schema.Boolean,
  tracked_accounts: Schema.Number,
  polling_paused: Schema.Boolean,
  database_path: Schema.String,
  schema_version: Schema.Number,
});

export const AdminResponseData = Schema.Union([
  Schema.Struct({ type: Schema.tag("signup"), value: SignupResult }),
  Schema.Struct({ type: Schema.tag("signout"), value: SignoutResult }),
  Schema.Struct({
    type: Schema.tag("polling-state"),
    value: PollingStateResult,
  }),
  Schema.Struct({ type: Schema.tag("rank-check"), value: RankCheckResult }),
  Schema.Struct({ type: Schema.tag("status"), value: StatusResult }),
]);
export type AdminResponseData = typeof AdminResponseData.Type;

export const AdminError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  exit_code: Schema.Number,
});
export type AdminError = typeof AdminError.Type;

export const AdminResponse = Schema.Struct({
  ok: Schema.Boolean,
  command: Schema.String,
  data: Schema.optionalKey(AdminResponseData),
  error: Schema.optionalKey(AdminError),
});
export type AdminResponse = typeof AdminResponse.Type;

export const failure = (
  command: string,
  code: string,
  message: string,
  exitCode: number,
): AdminResponse => ({
  ok: false,
  command,
  error: { code, message, exit_code: exitCode },
});
