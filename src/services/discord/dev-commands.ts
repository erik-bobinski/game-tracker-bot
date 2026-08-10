import { Discord, Ix } from "dfx";
import { Effect, Option, Schema } from "effect";
import type { MatchDetails } from "../game/index.ts";
import { LolMatch } from "../game/game-api/lol/match-schema.ts";
import { ValRawMatch } from "../game/game-api/val/match-schema.ts";
import { lolMatchToDetails } from "../game/game-adapters/lol.ts";
import { valMatchToDetails } from "../game/game-adapters/valorant.ts";
import {
  deferredReply,
  registerAccount,
  reply,
  type CommandDeps,
} from "./commands.ts";

const lolParticipant = (
  slot: number,
  team: 100 | 200,
  championName: string,
  [kills, deaths, assists]: readonly [number, number, number],
  win: boolean,
) => ({
  puuid: `dev-lol-${slot}`,
  riotIdGameName: `DevPlayer${slot}`,
  riotIdTagline: "DEV",
  teamId: team,
  championName,
  kills,
  deaths,
  assists,
  win,
  totalMinionsKilled: 140 + slot * 9,
  neutralMinionsKilled: slot % 3 === 0 ? 24 : 0,
  totalDamageDealtToChampions: 11_000 + slot * 1_750,
  largestMultiKill: slot === 1 ? 5 : 2,
  gameEndedInSurrender: false,
});

export const lolMockResponse = () => {
  const now = Date.now();
  const durationSeconds = 1_961;
  const blue = (
    [
      ["Ahri", [12, 3, 9]],
      ["Jinx", [9, 4, 11]],
      ["Thresh", [1, 5, 22]],
      ["LeeSin", [7, 6, 8]],
      ["Garen", [5, 4, 6]],
    ] as const
  ).map(([champion, kda], index) =>
    lolParticipant(index + 1, 100, champion, kda, true),
  );
  const red = (
    [
      ["Lux", [8, 7, 5]],
      ["Darius", [6, 8, 3]],
      ["Lulu", [0, 6, 14]],
      ["Ezreal", [5, 7, 6]],
      ["Morgana", [3, 8, 9]],
    ] as const
  ).map(([champion, kda], index) =>
    lolParticipant(index + 6, 200, champion, kda, false),
  );
  const participants = [...blue, ...red];

  return {
    metadata: {
      matchId: `NA1_DEV_${now}`,
      participants: participants.map((participant) => participant.puuid),
    },
    info: {
      gameMode: "CLASSIC",
      gameDuration: durationSeconds,
      gameStartTimestamp: now - durationSeconds * 1_000,
      queueId: 420,
      platformId: "NA1",
      participants,
    },
  };
};

const lolMockRanks: ReadonlyArray<readonly [tier: string, division: string]> = [
  ["Challenger", ""],
  ["Grandmaster", ""],
  ["Master", ""],
  ["Diamond", "II"],
  ["Emerald", "IV"],
  ["Platinum", "I"],
  ["Gold", "III"],
  ["Silver", "II"],
  ["Bronze", "IV"],
  ["Iron", "III"],
];

export const withMockLolRanks = (match: MatchDetails): MatchDetails => ({
  ...match,
  players: match.players.map((player, index) => {
    const entry = lolMockRanks[index % lolMockRanks.length];
    if (!entry) return player;
    const [tier, division] = entry;
    return {
      ...player,
      rank: division ? `${tier} ${division}` : tier,
      rankIconKey: tier.toLowerCase(),
      ...(division ? { rankDivision: division } : {}),
    };
  }),
});

const valAgents = {
  Jett: "add6443a-41bd-e414-f6ad-e58d267f4e95",
  Sova: "320b2a48-4d9b-a075-30f1-1f93a9b638fa",
  Sage: "569fdd95-4d10-43ab-ca70-79becc718b46",
  Phoenix: "eb93336a-449b-9c1b-0a54-a891f7921d69",
  Brimstone: "9f0d8ba9-4140-b941-57d3-a7ad57c6b417",
  Reyna: "a3bfb853-43b2-7238-a4f1-ad90e9e46bcc",
  Omen: "8e253930-4c05-31dd-1b6c-968525494517",
  Killjoy: "1e58de9c-4950-5125-93e9-a0aee9f98746",
  Raze: "f94c3b30-42be-e959-889c-5aa313dba261",
  Breach: "5f8d3a7f-467b-97f3-062c-13acf203c006",
} as const;

const valPlayer = (
  slot: number,
  teamId: "Blue" | "Red",
  agent: keyof typeof valAgents,
  tier: string,
  [kills, deaths, assists]: readonly [number, number, number],
) => ({
  puuid: `dev-val-${slot}`,
  name: `DevPlayer${slot}`,
  tag: "DEV",
  team_id: teamId,
  agent: { id: valAgents[agent], name: agent },
  tier: { id: 0, name: tier },
  stats: {
    kills,
    deaths,
    assists,
    score: (kills * 3 + assists) * 55,
    headshots: 5 + kills,
    bodyshots: 30 + kills * 2,
    legshots: 4,
  },
});

export const valMockResponse = () => {
  const now = Date.now();
  const gameLengthMs = 2_215_000;
  const blue = (
    [
      ["Jett", "Ascendant 1", [24, 12, 4]],
      ["Sova", "Diamond 2", [17, 13, 9]],
      ["Sage", "Diamond 3", [11, 14, 12]],
      ["Phoenix", "Platinum 1", [15, 15, 6]],
      ["Brimstone", "Unrated", [12, 16, 8]],
    ] as const
  ).map(([agent, tier, kda], index) =>
    valPlayer(index + 1, "Blue", agent, tier, kda),
  );
  const red = (
    [
      ["Reyna", "Diamond 1", [21, 16, 3]],
      ["Omen", "Platinum 3", [14, 15, 10]],
      ["Killjoy", "Platinum 2", [13, 16, 7]],
      ["Raze", "Gold 3", [12, 16, 5]],
      ["Breach", "Unrated", [10, 17, 13]],
    ] as const
  ).map(([agent, tier, kda], index) =>
    valPlayer(index + 6, "Red", agent, tier, kda),
  );

  return {
    metadata: {
      match_id: `dev-val-${now}`,
      map: { id: "dev-map", name: "Ascent" },
      game_length_in_ms: gameLengthMs,
      started_at: new Date(now - gameLengthMs).toISOString(),
      is_completed: true,
      queue: { id: "competitive", name: "Competitive", mode_type: null },
    },
    players: [...blue, ...red],
    teams: [
      { team_id: "Blue", won: true, rounds: { won: 13, lost: 9 } },
      { team_id: "Red", won: false, rounds: { won: 9, lost: 13 } },
    ],
    rounds: Array.from({ length: 22 }, () => ({ result: "Elimination" })),
  };
};

const devClear = ({ database }: CommandDeps) =>
  Ix.global(
    {
      name: "dev_clear",
      description:
        "[dev] Forget reported matches so the next poll re-reports them",
    },
    () =>
      database.clearReportedMatches().pipe(
        Effect.as(
          reply(
            "Cleared reported matches; the next poll re-reports everyone's recent matches.",
          ),
        ),
        Effect.catch((error) =>
          Effect.logError("dev_clear failed", error).pipe(
            Effect.as(reply("Clear failed, check the logs.")),
          ),
        ),
      ),
  );

const devReport = (deps: CommandDeps) =>
  Ix.global(
    {
      name: "dev_report",
      description: "[dev] Post a match report built from mock api responses",
      options: [
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "game",
          description: "which game's mock match to report",
          required: true,
          choices: [
            { name: "val", value: "valorant" },
            { name: "lol", value: "lol" },
          ],
        },
      ],
    },
    (i) =>
      Effect.gen(function* () {
        const user = i.interaction.member?.user ?? i.interaction.user;

        const match =
          i.optionValue("game") === "lol"
            ? withMockLolRanks(
                lolMatchToDetails(
                  yield* Schema.decodeUnknownEffect(LolMatch)(
                    lolMockResponse(),
                  ),
                ),
              )
            : valMatchToDetails(
                yield* Schema.decodeUnknownEffect(ValRawMatch)(
                  valMockResponse(),
                ),
              );

        // claim two mock players as tracked so the multi-user report renders
        yield* deps.notifyMatch({
          discordNames: [user?.username ?? "DevUser", "DevTeammate"],
          trackedPuuids: match.players
            .slice(0, 2)
            .map((player) => player.puuid),
          match,
        });
        return reply("Mock match report sent.");
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("dev_report failed", error).pipe(
            Effect.as(reply("Mock report failed, check the logs.")),
          ),
        ),
      ),
  );

// The account key a dev command acts on: a real discord member when `user` is
// given, otherwise a fabricated identity derived from the riot id. The fake id
// is never sent to discord, it is only a database key, so one tester can hold
// several tracked accounts at once.
const fakeIdentity = (riotName: string, riotTag: string) => ({
  discordUserId: `dev-${riotName}-${riotTag}`.toLowerCase(),
  discordName: `${riotName} (dev)`,
});

// Tracks a real riot account under a fabricated discord identity, or under a
// real member of the dev server, so shared matches produce multi-user reports
// without everyone in the server having to sign up.
const devSignup = (deps: CommandDeps) =>
  Ix.global(
    {
      name: "dev_signup",
      description: "[dev] Track a riot account for a fake or real discord user",
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
        {
          type: Discord.ApplicationCommandOptionType.USER,
          name: "user",
          description: "sign up on this user's behalf (default: a fake user)",
          required: false,
        },
      ],
    },
    (i) =>
      Effect.gen(function* () {
        const riotName = i.optionValue("riot_name");
        const riotTag = i.optionValue("riot_tag");
        const fake = fakeIdentity(riotName, riotTag);
        const { discordUserId, discordName } = Option.match(
          i.optionValueOptional("user"),
          {
            onNone: () => fake,
            onSome: (userId) => ({
              discordUserId: userId,
              // the username rather than a <@id> mention, which would ping them
              discordName: Option.getOrElse(
                i.resolve("user", (id, data) => data.users?.[id]?.username),
                () => fake.discordName,
              ),
            }),
          },
        );

        const existing = yield* deps.database.hasAccount(discordUserId);
        if (existing) return reply(`Already tracking **${discordName}**.`);

        const followUp = (content: string) =>
          deps.rest.updateOriginalWebhookMessage(
            i.interaction.application_id,
            i.interaction.token,
            { payload: { content } },
          );

        const register = registerAccount(deps, {
          discordUserId,
          discordName,
          riotName,
          riotTag,
        }).pipe(
          Effect.flatMap((result) =>
            followUp(
              result === "ok"
                ? `Now tracking **${discordName}**; shared matches report as multi-user.`
                : "Couldn't find recent account data for that Riot ID :(",
            ),
          ),
          Effect.catch((error) =>
            Effect.logError("dev_signup failed", error).pipe(
              Effect.andThen(followUp("dev_signup failed, check the logs.")),
              Effect.ignore({
                log: "Error",
                message: "dev_signup follow-up failed",
              }),
            ),
          ),
        );

        yield* Effect.forkDetach(register);
        return deferredReply;
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("dev_signup lookup failed", error).pipe(
            Effect.as(reply("dev_signup failed, check the logs.")),
          ),
        ),
      ),
  );

// The counterpart to dev_signup: drops either a real member's account or the
// fabricated identity dev_signup created for a riot id.
const devSignout = ({ database }: CommandDeps) =>
  Ix.global(
    {
      name: "dev_signout",
      description: "[dev] Stop tracking a fake or real discord user's account",
      options: [
        {
          type: Discord.ApplicationCommandOptionType.USER,
          name: "user",
          description: "sign out on this user's behalf",
          required: false,
        },
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "riot_name",
          description: "before the # of a fake dev_signup (e.g. syan)",
          required: false,
        },
        {
          type: Discord.ApplicationCommandOptionType.STRING,
          name: "riot_tag",
          description: "after the # of a fake dev_signup (e.g. NA1)",
          required: false,
        },
      ],
    },
    (i) =>
      Effect.gen(function* () {
        const riotId = Option.all([
          i.optionValueOptional("riot_name"),
          i.optionValueOptional("riot_tag"),
        ]).pipe(
          Option.map(([riotName, riotTag]) => fakeIdentity(riotName, riotTag)),
        );
        const target = Option.orElse(
          i.optionValueOptional("user").pipe(
            Option.map((userId) => ({
              discordUserId: userId,
              discordName: Option.getOrElse(
                i.resolve("user", (id, data) => data.users?.[id]?.username),
                () => userId,
              ),
            })),
          ),
          () => riotId,
        );

        if (Option.isNone(target)) {
          return reply(
            "Pass a user, or the riot_name and riot_tag it was signed up with.",
          );
        }

        const { discordUserId, discordName } = target.value;
        const existing = yield* database.hasAccount(discordUserId);
        if (!existing) return reply(`**${discordName}** isn't signed up.`);

        yield* database.deleteAccount(discordUserId);
        return reply(`**${discordName}** signed out, all data deleted.`);
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("dev_signout failed", error).pipe(
            Effect.as(reply("dev_signout failed, check the logs.")),
          ),
        ),
      ),
  );

export const devCommands = (deps: CommandDeps) =>
  Ix.builder
    .add(devClear(deps))
    .add(devReport(deps))
    .add(devSignup(deps))
    .add(devSignout(deps));
