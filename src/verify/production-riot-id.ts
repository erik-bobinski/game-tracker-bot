// Verification uses an explicit test account so Cursor Cloud never needs
// Railway credentials or a production database.
export const resolveVerifyRiotId = () => {
  const riotId = process.env.VERIFY_RIOT_ID?.trim();
  if (riotId) return riotId;
  throw new Error("Set VERIFY_RIOT_ID to a real non-production test account");
};
