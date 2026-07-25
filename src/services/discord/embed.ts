import type { Discord } from "dfx";
import type { GameId, MatchCandidate } from "../game/index.ts";

export interface MatchReport {
  readonly discordNames: ReadonlyArray<string>;
  // TODO: grows into the full match result (teams, score, rank deltas) once
  // GameAdapter can fetch match details.
  readonly match: MatchCandidate;
}

const gameNames: Record<GameId, string> = {
  lol: "League of Legends",
  valorant: "Valorant",
};

// "**A**", "**A** and **B**", "**A**, **B** and **C**"
const nameList = (names: ReadonlyArray<string>) => {
  const bolded = names.map((name) => `**${name}**`);
  const last = bolded.at(-1) ?? "";
  return bolded.length > 1
    ? `${bolded.slice(0, -1).join(", ")} and ${last}`
    : last;
};

export const matchEmbed = (report: MatchReport): Discord.RichEmbed => ({
  title: `${gameNames[report.match.game]} match complete`,
  // <t:..:t> renders in each viewer's local timezone
  description: [
    `${nameList(report.discordNames)} just finished a game`,
    `Started <t:${Math.floor(report.match.date / 1000)}:t>`,
  ].join("\n"),
  // TODO: green/red by outcome once the result carries a win flag.
  color: 0x95a5a6,
});
