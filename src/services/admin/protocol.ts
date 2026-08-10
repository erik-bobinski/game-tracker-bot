import { Schema } from "effect";

const DiscordUserId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d+$/)),
);

export const AdminRequest = Schema.Union([
  Schema.Struct({
    command: Schema.Literal("signup"),
    discordUserId: DiscordUserId,
    discordName: Schema.String,
    riotName: Schema.String,
    riotTag: Schema.String,
  }),
  Schema.Struct({
    command: Schema.Literal("signout"),
    discordUserId: DiscordUserId,
  }),
  Schema.Struct({ command: Schema.Literal("pause") }),
  Schema.Struct({ command: Schema.Literal("resume") }),
  Schema.Struct({
    command: Schema.Literal("rank-check"),
    discordUserId: DiscordUserId,
    game: Schema.Literals(["lol", "valorant"]),
  }),
  Schema.Struct({ command: Schema.Literal("status") }),
]);
export type AdminRequest = typeof AdminRequest.Type;

export const AdminResponse = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
});
export type AdminResponse = typeof AdminResponse.Type;
