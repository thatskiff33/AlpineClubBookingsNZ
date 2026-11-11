import { MEMBER_PRIVILEGE_CHECK_SELECT } from "@/lib/access-role-definitions";
import { isDeletedAccountRecord } from "@/lib/deleted-account";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { readTokenSessionIssuedAtMs } from "@/lib/session-max-age";

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
  // #4617: a passkey enrols without flipping twoFactorEnabled. The id only;
  // the public key never enters the session.
  webAuthnCredentials: { select: { id: true }, take: 1 },
  // Post-login landing preference (#2090), refreshed per request alongside the
  // security fields so a profile toggle change takes effect on the next request.
  postLoginLanding: true,
  // #4612: with `role` and the access-role rows, the record's classification,
  // which decides whether this is the lodge kiosk account and so its idle
  // window (`isKioskSessionMember` in `session-idle-expiry.ts`).
  financeAccessLevel: true,
  // `canLogin` with the joined definitions (#1367, #3603): the refresh computes
  // the merged admin-permission matrix over custom and club-edited
  // definition-backed roles, and clears it once login is off. The shared
  // select, so the refresh reads exactly what every privilege gate does.
  ...MEMBER_PRIVILEGE_CHECK_SELECT,
} as const;

export async function loadSessionMemberSecurity(userId: string) {
  const row = await prisma.member.findUnique({
    where: { id: userId },
    select: SESSION_MEMBER_SECURITY_SELECT,
  });
  if (!row) return null;
  const { webAuthnCredentials, ...member } = row;
  return {
    ...member,
    hasPasskey: Array.isArray(webAuthnCredentials) && webAuthnCredentials.length > 0,
  };
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

/**
 * When the session a token carries began, in epoch milliseconds: the stamped
 * `sessionIssuedAt`, else the JWT's `iat`, else now. The revocation rules below
 * compare their stored times against it. The maximum session age (#4611) does
 * NOT use this reader: it takes the stamp alone (`readTokenSessionIssuedAtMs`),
 * because `iat` is renewed on every refresh and a missing stamp must end the
 * session rather than start its clock again.
 */
export function getTokenSessionIssuedAtMs(token: {
  sessionIssuedAt?: unknown;
  iat?: unknown;
}): number {
  const stamped = readTokenSessionIssuedAtMs(token);
  if (stamped !== null) {
    return stamped;
  }

  if (typeof token.iat === "number" && Number.isFinite(token.iat)) {
    return token.iat * 1000;
  }

  return Date.now();
}

/**
 * Whether the member row ends a session that began at `sessionIssuedAt`: the
 * account was deleted (#2620), its login is off or was switched off after the
 * session began (#3603, `isLoginRevokedSession`), or its password changed after
 * the session began. The one rule the `jwt` callback in `auth.ts` invalidates a
 * token by, and the one the kiosk idle window re-checks (#4612,
 * `session-idle-expiry.ts`).
 */
export function isRevokedMemberSession(
  member: NonNullable<Awaited<ReturnType<typeof loadSessionMemberSecurity>>>,
  sessionIssuedAt: number,
  memberId: string,
): boolean {
  // #2620: an account an approved deletion request has anonymised holds no
  // session, whatever `active` says: a session minted before the deletion, or
  // after someone flipped `active` back directly in the database.
  if (isDeletedAccountRecord(member)) {
    logger.warn(
      { memberId },
      "Invalidating session for a deleted account (#2620)",
    );
    return true;
  }
  return (
    isLoginRevokedSession(member, sessionIssuedAt, memberId) ||
    (member.passwordChangedAt instanceof Date &&
      member.passwordChangedAt.getTime() > sessionIssuedAt)
  );
}
