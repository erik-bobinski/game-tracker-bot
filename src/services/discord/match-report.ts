import type { DiscordREST } from "dfx";
import { Effect } from "effect";
import { gameNames } from "../game/index.ts";
import { matchEmbed, type MatchReport, type RankEmojis } from "./embed.ts";
import { renderMatchImage } from "./match-image.ts";

const IMAGE_FILENAME = "match-report.png";

export const postMatchReport = Effect.fn("Discord.postMatchReport")(function* (
  rest: typeof DiscordREST.Service,
  channelId: string,
  report: MatchReport,
  rankEmojis: RankEmojis,
) {
  const image = yield* renderMatchImage(report).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        "match image rendering failed; falling back to text leaderboard",
        error,
      ).pipe(Effect.as(undefined)),
    ),
  );
  if (!image) {
    return yield* rest.createMessage(channelId, {
      embeds: [matchEmbed(report, rankEmojis)],
    });
  }

  const description = `${gameNames[report.match.game]} match leaderboard for ${report.discordNames.join(", ")}`;
  const file = new File([new Uint8Array(image)], IMAGE_FILENAME, {
    type: "image/png",
  });
  return yield* rest.withFiles([file])(
    rest.createMessage(channelId, {
      embeds: [
        matchEmbed(report, rankEmojis, `attachment://${IMAGE_FILENAME}`),
      ],
      attachments: [{ id: "0", filename: IMAGE_FILENAME, description }],
    }),
  );
});
