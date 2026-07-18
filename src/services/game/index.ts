import { Schema } from "effect";

// Source of truth for the games the app supports
export const GameId = Schema.Literals(["lol", "valorant"]);
export type GameId = typeof GameId.Type;
