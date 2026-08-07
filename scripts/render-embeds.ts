// Renders match-report embeds through the dev pipeline (staged matches ->
// dev game adapters -> matchEmbed) and writes the payloads to scripts/out/.
// Optionally posts them to the configured notification channel.
//
// Usage: tsx --env-file=.env.dev scripts/render-embeds.ts <label> [--post]
import { mkdirSync, writeFileSync } from "node:fs";
import { Effect, Layer, Redacted } from "effect";
import { AppConfig, AppConfigLive } from "../src/services/config.ts";
import { matchEmbed, type RankEmojis } from "../src/services/discord/embed.ts";
import {
  DevGameAdaptersLive,
  DevSimulator,
  DevSimulatorLive,
  MOCK_ACCOUNTS,
} from "../src/services/game/dev-simulator.ts";
import { GameAdapters } from "../src/services/game/game-adapters/index.ts";
import { EpochMillis, type GameId } from "../src/services/game/index.ts";

const label = process.argv[2] ?? "preview";
const post = process.argv.includes("--post");

const discordApi = (
  token: string,
  path: string,
  init?: { readonly method?: string; readonly body?: unknown },
) =>
  Effect.promise(async () => {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bot ${token}`,
        "content-type": "application/json",
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!response.ok) {
      throw new Error(`${path} -> ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as never;
  });

const fetchRankEmojis = (token: string) =>
  Effect.gen(function* () {
    const application = yield* discordApi(token, "/applications/@me");
    const { items } = yield* discordApi(
      token,
      `/applications/${(application as { id: string }).id}/emojis`,
    );
    const resolved: Record<string, string> = {};
    for (const emoji of items as ReadonlyArray<{ name: string; id: string }>) {
      const lol = emoji.name.match(/^rank_lol_v2_(.+)$/);
      const val = emoji.name.match(/^rank_valorant_(.+)$/);
      const key = lol ? `lol.${lol[1]}` : val ? `valorant.${val[1]}` : null;
      if (key) resolved[key] = `<:${emoji.name}:${emoji.id}>`;
    }
    return resolved satisfies RankEmojis;
  });

const program = Effect.gen(function* () {
  const config = yield* AppConfig;
  const simulator = yield* DevSimulator;
  const adapters = yield* GameAdapters;
  const alpha = MOCK_ACCOUNTS[0]!;
  const token = Redacted.value(config.discordBotToken);
  const emojis = yield* fetchRankEmojis(token).pipe(
    Effect.catch((error) =>
      Effect.logWarning("emoji fetch failed; rendering without icons", {
        error,
      }).pipe(Effect.as({} as RankEmojis)),
    ),
  );

  const staged: ReadonlyArray<{
    readonly game: GameId;
    readonly result: "victory" | "defeat";
    readonly account: { readonly puuid: string; readonly route: string };
  }> = [
    { game: "lol", result: "victory", account: alpha.lol! },
    { game: "valorant", result: "defeat", account: alpha.valorant! },
  ];

  const embeds: Record<string, unknown> = {};
  for (const stage of staged) {
    yield* simulator.stageMatch({
      game: stage.game,
      result: stage.result,
      mode: "ranked",
      surrendered: false,
      duplicate: false,
      players: [
        {
          riotName: alpha.riotName,
          riotTag: alpha.riotTag,
          puuid: stage.account.puuid,
          route: stage.account.route,
        },
      ],
    });
    const adapter = adapters.all.find((entry) => entry.game === stage.game)!;
    const tracked = {
      puuid: stage.account.puuid as never,
      route: stage.account.route,
      trackingStartedAt: EpochMillis.make(0),
    };
    const matches = yield* adapter.getRecentMatches(tracked);
    const enriched = yield* adapter.enrichMatch(matches[0]!);
    embeds[stage.game] = matchEmbed(
      {
        discordNames: ["syanx_"],
        trackedPuuids: [stage.account.puuid],
        match: enriched,
      },
      emojis,
    );
  }

  mkdirSync("scripts/out", { recursive: true });
  const outPath = `scripts/out/embeds-${label}.json`;
  writeFileSync(outPath, JSON.stringify({ label, emojis, embeds }, null, 2));
  yield* Effect.log(`wrote ${outPath}`);

  if (post) {
    for (const [game, embed] of Object.entries(embeds)) {
      yield* discordApi(
        token,
        `/channels/${config.notificationChannelId}/messages`,
        {
          method: "POST",
          body: {
            content: `\`${label}\` — ${game === "lol" ? "League of Legends" : "Valorant"}`,
            embeds: [embed],
          },
        },
      );
      yield* Effect.log(`posted ${label} ${game} embed`);
    }
  }
});

const MainLive = DevGameAdaptersLive.pipe(
  Layer.provideMerge(DevSimulatorLive),
  Layer.provideMerge(AppConfigLive),
);

Effect.runPromise(program.pipe(Effect.provide(MainLive))).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
