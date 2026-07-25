import { Discord, Ix } from "dfx";
import { Effect } from "effect";
import type { Database } from "../database/index.ts";
import type { GameAdapters } from "../game/game-adapters/index.ts";

export interface CommandDeps {
  readonly database: Database["Service"];
  readonly gameAdapters: GameAdapters["Service"];
}

const reply = (content: string): Discord.CreateInteractionResponseRequest => ({
  type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
  data: { content },
});

const todo = (name: string) =>
  Effect.succeed(reply(`\`/${name}\` isn't implemented yet.`));

// TODO: resolve the riot id against every adapter, then Database.addAccount.
const signup = Ix.global(
  {
    name: "signup",
    description: "Get your riot account's match results reported",
    options: [
      {
        type: Discord.ApplicationCommandOptionType.STRING,
        name: "riot_name",
        description: "before the # (e.g. syan)",
        required: true,
      },
      {
        type: Discord.ApplicationCommandOptionType.STRING,
        name: "riot_tag",
        description: "after the # (e.g. NA1)",
        required: true,
      },
    ],
  },
  () => todo("signup"),
);

// TODO: needs Database.deleteAccount.
const signout = Ix.global(
  {
    name: "signout",
    description: "Stop tracking all your data",
  },
  () => todo("signout"),
);

// TODO: pause/resume need a paused flag both Polling and this service can
// reach; it cannot live on Polling itself without a dependency cycle.
const pause = Ix.global(
  {
    name: "pause",
    description: "Pause all match reports",
  },
  () => todo("pause"),
);

const resume = Ix.global(
  {
    name: "resume",
    description: "Resume all match reports",
  },
  () => todo("resume"),
);

// TODO: needs a GameAdapter.getRank and the account's stored region.
const rankCheck = Ix.global(
  {
    name: "rank_check",
    description: "Check a signed-up user's Valorant or League rank",
    options: [
      {
        type: Discord.ApplicationCommandOptionType.USER,
        name: "user",
        description: "the discord user to check",
        required: true,
      },
      {
        type: Discord.ApplicationCommandOptionType.STRING,
        name: "game",
        description: "which game's rank to check",
        required: true,
        choices: [
          { name: "val", value: "valorant" },
          { name: "lol", value: "lol" },
        ],
      },
    ],
  },
  () => todo("rank_check"),
);

export const commands = (_deps: CommandDeps) =>
  Ix.builder
    .add(signup)
    .add(signout)
    .add(pause)
    .add(resume)
    .add(rankCheck)
    .catchAllCause(Effect.logError);
