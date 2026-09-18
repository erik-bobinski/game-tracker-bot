// Wise Fellas production. verify, DEV_MODE, and mock reports must never post here.
export const PRODUCTION_NOTIFICATION_CHANNEL_IDS = new Set([
  "1525711779865432135",
]);

// riot-tracker-testing. Development and verification may post only here.
export const TESTING_NOTIFICATION_CHANNEL_IDS = new Set([
  "1523432733785722940",
]);

export const TESTING_DISCORD_GUILD_IDS = new Set(["1523432684691525802"]);

export const isTestingDiscordChannel = (channelId: string) =>
  TESTING_NOTIFICATION_CHANNEL_IDS.has(channelId);

export const isTestingDiscordGuild = (guildId: string) =>
  TESTING_DISCORD_GUILD_IDS.has(guildId);

export const isTestingDiscordDestination = (
  channelId: string,
  guildId?: string,
) =>
  isTestingDiscordChannel(channelId) &&
  (guildId === undefined || isTestingDiscordGuild(guildId));

export const testingDiscordRefusal = (channelId: string) =>
  `Refusing testing Discord destination ${channelId}. Mock reports, DEV_MODE, and verify may post only to riot-tracker-testing channel 1523432733785722940.`;

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
  return isTestingDiscordDestination(channelId, guildId)
    ? channelId
    : undefined;
};

// Testing-only destination. Ambient NOTIFICATION_CHANNEL_ID is ignored.
export const testingNotificationChannelId = (
  env: Record<string, string | undefined>,
) => {
  for (const value of [
    env.VERIFY_NOTIFICATION_CHANNEL_ID,
    env.TESTING_NOTIFICATION_CHANNEL_ID,
  ]) {
    const channelId = value?.trim();
    if (channelId && isTestingDiscordChannel(channelId)) {
      return channelId;
    }
  }
  return env.DISCORD_TEST_CHANNEL_URL
    ? channelFromTestUrl(env.DISCORD_TEST_CHANNEL_URL)
    : undefined;
};
