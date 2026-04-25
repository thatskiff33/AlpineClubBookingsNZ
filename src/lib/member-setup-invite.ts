export const MEMBER_SETUP_INVITE_TTL_DAYS = 7;
export const MEMBER_SETUP_INVITE_TTL_MS =
  MEMBER_SETUP_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

export function getMemberSetupInviteExpiryDate(now = Date.now()): Date {
  return new Date(now + MEMBER_SETUP_INVITE_TTL_MS);
}
