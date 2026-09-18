export interface DiscordDestination {
  readonly guildId: string;
  readonly channelId: string;
}

const snowflake = /^\d{17,20}$/;

const discordId = (value: string | undefined) => {
  const id = value?.trim();
  return id && snowflake.test(id) ? id : undefined;
};

const destinationFromUrl = (
  url: string | undefined,
): DiscordDestination | undefined => {
  const match = url
    ?.trim()
    .match(
      /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)/,
    );
  const guildId = discordId(match?.[1]);
  const channelId = discordId(match?.[2]);
  return guildId && channelId ? { guildId, channelId } : undefined;
};

// Verification accepts only an explicitly configured testing destination.
// Ambient NOTIFICATION_CHANNEL_ID is intentionally ignored.
export const testingDiscordDestination = (
  env: Record<string, string | undefined>,
): DiscordDestination | undefined => {
  const fromUrl = destinationFromUrl(env.DISCORD_TEST_CHANNEL_URL);
  const configuredGuildId = discordId(env.TESTING_DISCORD_GUILD_ID);
  const configuredChannelId = discordId(env.TESTING_NOTIFICATION_CHANNEL_ID);

  if (
    fromUrl &&
    ((configuredGuildId && configuredGuildId !== fromUrl.guildId) ||
      (configuredChannelId && configuredChannelId !== fromUrl.channelId))
  ) {
    return undefined;
  }

  const guildId = configuredGuildId ?? fromUrl?.guildId;
  const allowlistedChannelId = configuredChannelId ?? fromUrl?.channelId;
  const requestedChannelId =
    discordId(env.VERIFY_NOTIFICATION_CHANNEL_ID) ?? allowlistedChannelId;

  if (
    !guildId ||
    !allowlistedChannelId ||
    requestedChannelId !== allowlistedChannelId
  ) {
    return undefined;
  }

  return { guildId, channelId: requestedChannelId };
};

export const matchesDiscordDestination = (
  channelId: string,
  guildId: string | undefined,
  expected: DiscordDestination,
) => channelId === expected.channelId && guildId === expected.guildId;

export const testingDiscordRefusal = (channelId: string) =>
  `Refusing Discord destination ${channelId}. Mock reports, DEV_MODE, and verify require an explicitly configured testing guild and channel.`;
