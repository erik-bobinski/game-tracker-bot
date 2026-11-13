import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Redacted,
  Schema,
} from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  DiscordConfig,
  DiscordREST,
  DiscordRESTLive,
  MemoryRateLimitStoreLive,
} from "dfx";
import { Database, DatabaseLive } from "../services/database/index.ts";
import {
  DeliveryQueue,
  DeliveryQueueLive,
} from "../services/delivery-queue/index.ts";
import { Discord, DiscordError } from "../services/discord/index.ts";
import {
  MatchCard,
  MatchCardLive,
  postMatchReport,
} from "../services/discord/match-card.tsx";
import {
  GameAdapters,
  GameAdaptersLive,
} from "../services/game/game-adapters/index.ts";
import { RiotApiLive } from "../services/game/game-api/lol/riot-api-client.ts";
import { GameId } from "../services/game/index.ts";
import { LiveHttp, LiveHttpLive } from "./http.ts";
import {
  MatchEngine,
  MatchEngineLive,
} from "../services/match-engine/index.ts";

// This is deliberately finite: no gateway, command sync, production database,
// automatic account discovery, or polling daemon. See .agents/skills/verify-game-tracker-bot/SKILL.md.
const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const artifactDir = yield* Config.String("LIVE_ARTIFACT_DIR").pipe(
    Config.withDefault("artifacts/live"),
  );
  yield* fs.makeDirectory(artifactDir, { recursive: true });
  const budget = yield* LiveHttp;
  let stage = "configuration";
  let passed = false;
  const messageIds: string[] = [];
  const verify = Effect.gen(function* () {
    if (!(yield* Config.Boolean("DEV_MODE")))
      return yield* Effect.die("DEV_MODE must be true");
    const guildId = yield* Config.String("DEV_GUILD_ID");
    const channelId = yield* Config.String("NOTIFICATION_CHANNEL_ID");
    const applicationId = yield* Config.String("LIVE_DISCORD_APPLICATION_ID");
    const riotId = yield* Config.String("LIVE_RIOT_ID");
    const game = yield* Config.String("LIVE_GAME").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GameId)),
    );
    const [riotName, riotTag, extra] = riotId.split("#");
    if (!riotName || !riotTag || extra !== undefined)
      return yield* Effect.die("LIVE_RIOT_ID must be name#tag");
    const temp = yield* fs.makeTempDirectoryScoped({
      prefix: "game-tracker-live-",
    });
    // Serialize local runs across worktrees. CI also serializes across runners.
    yield* Effect.acquireRelease(
      fs.writeFileString(
        `${Bun.env.TMPDIR ?? "/tmp"}/game-tracker-live.lock`,
        "live\n",
        { flag: "wx" },
      ),
      () =>
        fs
          .remove(`${Bun.env.TMPDIR ?? "/tmp"}/game-tracker-live.lock`)
          .pipe(Effect.orDie),
    );
    const transport = budget.client;
    const http = Layer.succeed(HttpClient.HttpClient, transport);
    const restLive = DiscordRESTLive.pipe(
      Layer.provide(MemoryRateLimitStoreLive),
      Layer.provide(
        DiscordConfig.layerConfig({
          token: Config.Redacted("DISCORD_BOT_TOKEN"),
        }),
      ),
    );
    const adaptersLive = GameAdaptersLive.pipe(Layer.provide(RiotApiLive));
    const run = Effect.gen(function* () {
      stage = "dev destination preflight";
      const token = yield* Config.Redacted("DISCORD_BOT_TOKEN");
      const client = transport.pipe(HttpClient.filterStatusOk);
      const headers = { authorization: `Bot ${Redacted.value(token)}` };
      const me = yield* client
        .get("https://discord.com/api/v10/users/@me", { headers })
        .pipe(
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(
              Schema.Struct({ id: Schema.String, bot: Schema.Boolean }),
            ),
          ),
        );
      const guilds = yield* client
        .get("https://discord.com/api/v10/users/@me/guilds", { headers })
        .pipe(
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(
              Schema.Array(Schema.Struct({ id: Schema.String })),
            ),
          ),
        );
      const channel = yield* client
        .get(`https://discord.com/api/v10/channels/${channelId}`, { headers })
        .pipe(
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(
              Schema.Struct({ guild_id: Schema.String }),
            ),
          ),
        );
      if (
        !me.bot ||
        me.id !== applicationId ||
        guilds.length !== 1 ||
        guilds[0]?.id !== guildId ||
        channel.guild_id !== guildId
      ) {
        return yield* Effect.die(
          "Dedicated dev application, guild and channel must match",
        );
      }
      stage = "resolve approved account";
      const adapters = yield* GameAdapters;
      const adapter = adapters.all.find((candidate) => candidate.game === game);
      if (!adapter || adapter.requiresOptIn)
        return yield* Effect.die(
          "Use a public-data adapter; Riot consent flows need the manual UI checklist",
        );
      const account = yield* adapter.resolveAccount(riotName, riotTag);
      // Bound reads at the real adapter boundary, including the engine's
      // startup catch-up. API responses, decoding and enrichment remain real.
      const bounded = {
        ...adapter,
        getRecentMatchIds: () =>
          adapter.getRecentMatchIds(account.puuid, account.region, 1),
      };
      const db = yield* Database;
      yield* db.addAccount({
        discordUserId: "live-verification",
        discordName: "Live verification",
        riotName,
        riotTag,
        guildIds: [guildId],
        games: {
          [game]: { ...account, rankSnapshots: {}, reportedMatches: [] },
        },
      });
      yield* db.updateGuild(guildId, { channelId });
      const rest = yield* DiscordREST;
      const card = yield* MatchCard;
      const engine = MatchEngineLive.pipe(
        Layer.provideMerge(DeliveryQueueLive),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Database, db),
            Layer.succeed(GameAdapters, { all: [bounded] }),
            Layer.succeed(Discord, {
              application: { name: "Live verification", inviteUrl: "" },
              notifyMatch: (target, report) =>
                Effect.gen(function* () {
                  if (
                    target.guildId !== guildId ||
                    target.channelId !== channelId ||
                    messageIds.length > 0
                  )
                    return yield* Effect.die(
                      "Live post budget/destination mismatch",
                    );
                  const png = yield* card.render(report);
                  yield* fs.writeFile(`${artifactDir}/report.png`, png);
                  const message = yield* postMatchReport(
                    { rest, channelId, card, rankEmojis: {} },
                    report,
                  );
                  messageIds.push(message.id);
                  const received = yield* rest.getMessage(
                    channelId,
                    message.id,
                  );
                  if (!received.attachments.length)
                    return yield* Effect.die(
                      "Discord report has no PNG attachment",
                    );
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new DiscordError({
                        operation: "live verification",
                        cause,
                      }),
                  ),
                ),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const matchEngine = yield* MatchEngine;
        stage = "real match discovery, enrichment and Discord delivery";
        const first = yield* matchEngine.pollOnce();
        if (first.deliveriesSucceeded !== 1 || messageIds.length !== 1)
          return yield* Effect.die(
            "Expected one real report; choose an account with a completed recent match",
          );
        stage = "repeat poll deduplication";
        const second = yield* matchEngine.pollOnce();
        if (
          second.deliveryAttempts !== 0 ||
          (yield* (yield* DeliveryQueue).pending()).length !== 0
        )
          return yield* Effect.die("Repeat poll was not clean");
        stage = "subscription cleanup";
        yield* db.leaveGuild({ guildId, discordUserId: "live-verification" });
        if (yield* db.hasAccount("live-verification"))
          return yield* Effect.die("Temporary account was not removed");
        passed = true;
        stage = "complete";
      }).pipe(Effect.provide(engine));
    }).pipe(
      Effect.provide(MatchCardLive.pipe(Layer.provideMerge(adaptersLive))),
      Effect.provide(restLive),
      Effect.provide(DatabaseLive),
      Effect.provide(http),
      Effect.provide(
        ConfigProvider.layerAdd(
          ConfigProvider.fromUnknown({
            DB_PATH: `${temp}/test.sqlite`,
            LEGACY_DB_PATH: "",
          }),
          { asPrimary: true },
        ),
      ),
    );
    yield* run;
  }).pipe(Effect.scoped, Effect.timeout("3 minutes"));
  yield* verify.pipe(
    Effect.catchCause(() =>
      Console.error(`Live check failed during: ${stage}`).pipe(
        Effect.andThen(
          Effect.sync(() => {
            passed = false;
            process.exitCode = 1;
          }),
        ),
      ),
    ),
    Effect.ensuring(
      Effect.gen(function* () {
        yield* fs.writeFileString(
          `${artifactDir}/results.json`,
          JSON.stringify(
            { passed, stage, requests: yield* budget.counts, messageIds },
            null,
            2,
          ),
        );
      }).pipe(Effect.orDie),
    ),
  );
  if (passed) yield* Console.log(`Live check passed; evidence: ${artifactDir}`);
});

BunRuntime.runMain(
  main.pipe(
    Effect.provide(LiveHttpLive),
    Effect.provide(BunHttpClient.layer),
    Effect.provide(BunServices.layer),
    Effect.provide(Logger.layer([])),
  ),
);
