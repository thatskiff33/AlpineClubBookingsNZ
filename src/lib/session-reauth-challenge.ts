import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { hashTwoFactorCode, twoFactorCodeHashCandidates } from "@/lib/two-factor";

/**
 * The step-up challenge (#4616, `INV-AUTH-008`): a single-use, server-minted
 * proof that a signed-in member has just proved themselves again. Modelled on
 * the two-factor session challenge in `two-factor.ts`.
 *
 * The step-up route mints one only after the app code or password checks out,
 * and hands the raw token to `updateSession()` in the same request; the `jwt`
 * callback in `auth.ts` consumes it and only then refreshes the session's
 * `lastAuthenticatedAt`. The update trigger is reachable by any signed-in
 * client (`POST /api/auth/session`), so this token is the only thing that can
 * move the stamp after sign-in. The raw token never leaves the server.
 *
 * Stored as the keyed HMAC every two-factor code uses (`docs/TOKEN_HASHING.md`),
 * bound to one member, and alive for two minutes. Not refused while a data-key
 * ring is missing, for the reason given above `createTwoFactorEmailCode`: it is
 * short-lived and never outlives the request that mints it.
 */
const SESSION_REAUTH_CHALLENGE_TTL_MS = 2 * 60 * 1000;

/** Mints a challenge for `memberId` and returns the raw token. */
export async function createSessionReauthChallenge(memberId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();

  await prisma.$transaction([
    // Housekeeping only: expired challenges are already unusable. Live ones
    // are left alone, so two step-ups in flight cannot spoil each other.
    prisma.sessionReauthChallenge.deleteMany({
      where: { memberId, expiresAt: { lte: new Date(now) } },
    }),
    prisma.sessionReauthChallenge.create({
      data: {
        memberId,
        tokenHash: hashTwoFactorCode(token),
        expiresAt: new Date(now + SESSION_REAUTH_CHALLENGE_TTL_MS),
      },
    }),
  ]);

  return token;
}

/**
 * Consumes `token` for `memberId`: true only when a live challenge minted for
 * this member under that token existed and THIS call removed it. One guarded
 * single-row delete, no lock: of two concurrent consumers of one token,
 * PostgreSQL lets exactly one delete the row, and the other's count is 0. A
 * replayed, expired, other-member or made-up token deletes nothing.
 */
export async function consumeSessionReauthChallenge(
  memberId: string,
  token: string,
): Promise<boolean> {
  if (token === "") return false;
  const deleted = await prisma.sessionReauthChallenge.deleteMany({
    where: {
      tokenHash: { in: twoFactorCodeHashCandidates(token) },
      memberId,
      expiresAt: { gt: new Date() },
    },
  });
  return deleted.count === 1;
}
