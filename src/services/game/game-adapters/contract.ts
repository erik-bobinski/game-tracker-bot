import { Effect } from "effect";
import { type GameId } from "../index.js";

export interface GameAccount {
  readonly game: GameId;
}

export interface MatchCandidate {
  readonly game: GameId;
  readonly id: string;
}

// the source of truth the match engine needs from each game
export interface GameAdapter {
  readonly game: GameId;

  readonly resolveAccount: (
    name: string,
    tag: string,
  ) => Effect.Effect<GameAccount>;

  readonly getRecentMatches: (
    account: GameAccount,
  ) => Effect.Effect<ReadonlyArray<MatchCandidate>>;
}
