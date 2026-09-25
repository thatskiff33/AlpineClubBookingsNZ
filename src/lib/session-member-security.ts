import { MEMBER_PRIVILEGE_CHECK_SELECT } from "@/lib/access-role-definitions";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * The member fields the per-request token refresh in `src/lib/auth.ts` reads,
 * and the login-revocation rule it applies to them (#3603, INV-LIFE-092).
 * Moved out of `auth.ts` so the rule sits beside the fields it depends on.
 */
const SESSION_MEMBER_SECURITY_SELECT = {
  role: true,
  forcePasswordChange: true,
  emailVerified: true,
  passwordChangedAt: true,
  // #3603 (D1): when this member's login last went from on to off; see
  // `isLoginRevokedSession` below.
  sessionsRevokedAt: true,
  // #2620/#3542: refresh both canonical deletion signals so a session
  // minted before erasure dies on its next request. Neither enters the token.
  email: true,
  deletedAt: true,
  passwordHash: true,
  twoFactorEnabled: true,
  twoFactorMethod: true,
  // Post-login landing preference (#2090), refreshed per request alongside the
  // security fields so a profile toggle change takes effect on the next request.
  postLoginLanding: true,
  // `canLogin` with the joined definitions (#1367, #3603): the refresh computes
  // the merged admin-permission matrix over custom and club-edited
  // definition-backed roles, and clears it once login is off. The shared
  // select, so the refresh reads exactly what every privilege gate does.
  ...MEMBER_PRIVILEGE_CHECK_SELECT,
} as const;

export async function loadSessionMemberSecurity(userId: string) {
  return prisma.member.findUnique({
    where: { id: userId },
    select: SESSION_MEMBER_SECURITY_SELECT,
  });
}

/**
 * Whether a session must end because of the member's login (#3603). Every
 * sign-in provider requires `canLogin: true`, so a member whose login is
 * switched off holds no session either. Two checks, both read from the
 * database on every refresh:
 *
 *  - `sessionsRevokedAt` (owner decision D1): the database trigger stamps it
 *    whenever login goes from on to off, and a session issued before it is
 *    refused for good, exactly like one issued before a newer password.
 *    Re-enabling login therefore never revives a session that started before
 *    the switch-off, however the client replays its cookie; signing in again
 *    mints a new one.
 *  - `canLogin === false`: refused while login is off, whatever the revocation
 *    time says. Belt and braces; it needs no column and no clock.
 *
 * The caller also keeps a token it has invalidated invalidated. That covers
 * the narrow window the stored time cannot: a sign-in that races the switch-off
 * statement, or app/database clock skew, can mint a session whose issue time is
 * not before the stamp. Refreshed while login is off, it carries the flag from
 * then on and does not come back when login is re-enabled. Signing in mints a
 * fresh token with the flag cleared.
 */
export function isLoginRevokedSession(
  member: { canLogin: boolean; sessionsRevokedAt: Date | null },
  sessionIssuedAt: number,
  memberId: string,
): boolean {
  const revoked =
    member.canLogin === false ||
    (member.sessionsRevokedAt instanceof Date &&
      member.sessionsRevokedAt.getTime() > sessionIssuedAt);
  if (revoked) {
    logger.warn(
      { memberId },
      "Invalidating a session that started before the member's login was switched off (#3603)",
    );
  }
  return revoked;
}
