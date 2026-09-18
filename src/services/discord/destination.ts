// Wise Fellas production. verify, DEV_MODE, and mock reports must never post here.
export const PRODUCTION_NOTIFICATION_CHANNEL_IDS = new Set([
  "1525711779865432135",
]);

export const PRODUCTION_DISCORD_GUILD_IDS = new Set(["858439993756614656"]);

const snowflake = /^\d{17,20}$/;

export const isProductionDiscordChannel = (channelId: string) =>
  PRODUCTION_NOTIFICATION_CHANNEL_IDS.has(channelId);

export const isProductionDiscordGuild = (guildId: string) =>
  PRODUCTION_DISCORD_GUILD_IDS.has(guildId);

export const isProductionDiscordDestination = (
  channelId: string,
  guildId?: string,
) =>
  isProductionDiscordChannel(channelId) ||
  (guildId !== undefined && isProductionDiscordGuild(guildId));

export const productionDiscordRefusal = (channelId: string) =>
  `Refusing to post to production Discord (Wise Fellas) channel ${channelId}. Mock reports and verify must use riot-tracker-testing via VERIFY_NOTIFICATION_CHANNEL_ID, TESTING_NOTIFICATION_CHANNEL_ID, or DISCORD_TEST_CHANNEL_URL. Isolated sqlite is not enough.`;

const channelFromTestUrl = (url: string) => {
  const match = url
    .trim()
    .match(
      /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)/,
    );
  if (!match) return undefined;
  const guildId = match[1];
  const channelId = match[2];
  if (!guildId || !channelId) return undefined;
  if (isProductionDiscordDestination(channelId, guildId)) return undefined;
  return channelId;
};

// Testing-only destination. Ambient / Railway NOTIFICATION_CHANNEL_ID is ignored
// because Cursor Cloud and production printenv often point at Wise Fellas.
export const testingNotificationChannelId = (
  env: Record<string, string | undefined>,
) => {
  for (const value of [
    env.VERIFY_NOTIFICATION_CHANNEL_ID,
    env.TESTING_NOTIFICATION_CHANNEL_ID,
  ]) {
    const channelId = value?.trim();
    if (
      channelId &&
      snowflake.test(channelId) &&
      !isProductionDiscordChannel(channelId)
    ) {
      return channelId;
    }
  }
  return env.DISCORD_TEST_CHANNEL_URL
    ? channelFromTestUrl(env.DISCORD_TEST_CHANNEL_URL)
    : undefined;
};
