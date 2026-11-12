import { randomBytes } from "crypto";

import bcrypt from "bcryptjs";

import { prisma } from "@/lib/prisma";
import { memberHasStoredPasskey, verifyPasskeyAssertion } from "@/lib/webauthn";
import {
  isReauthFactor,
  type ReauthFactor,
} from "@/lib/recent-auth";
import { claimPasswordAttempt, clearPasswordAttempts } from "@/lib/login-throttle";
import { LOGIN_THROTTLED_CODE } from "@/lib/login-throttle-policy";
import {
  clearTwoFactorLockout,
  getActiveTwoFactorLockout,
  hashTwoFactorCode,
  recordTwoFactorFailure,
  twoFactorCodeHashCandidates,
  verifyStoredTotpCode,
} from "@/lib/two-factor";

/** Same short life as the sign-in session challenge: long enough to consume, not to reuse. */
export const SESSION_REAUTH_CHALLENGE_TTL_MS = 2 * 60 * 1000;

const REFUSED_FACTOR_ERROR = "That can't be used to confirm it's you.";
const INVALID_PROOF_ERROR = "That didn't match. Try again.";
const PASSWORD_WAIT_ERROR =
  "Too many password attempts. Please wait a few minutes and try again.";

export type ReauthMember = {
  id: string;
  email: string;
  passwordHash: string;
  active: boolean;
  twoFactorEnabled: boolean;
  twoFactorMethod: "TOTP" | "EMAIL" | null;
  totpSecret: string | null;
  twoFactorFailedAttempts: number;
  twoFactorLockedUntil: Date | null;
};

export type ReauthProofResult =
  | { ok: true; challengeToken: string }
  | {
      ok: false;
      status: 400 | 429;
      error: string;
      code?: string;
      lockedUntil?: string;
    };

/**
 * Whether this member has a passkey (#4617). A client flag is not possession:
 * the answer is a credential row.
 */
export async function memberHasPasskey(memberId: string): Promise<boolean> {
  return memberHasStoredPasskey(memberId);
}

/**
 * Verify a passkey assertion for step-up (#4617). The same check as sign-in.
 * A failed assertion returns false; the caller counts the lockout.
 */
export async function verifyReauthPasskey(
  memberId: string,
  assertion: unknown,
): Promise<boolean> {
  const result = await verifyPasskeyAssertion(memberId, assertion, {
    kind: "member",
    memberId,
  });
  return result.ok;
}

export function memberHasAuthenticatorApp(member: {
  twoFactorEnabled: boolean;
  twoFactorMethod: string | null;
  totpSecret: string | null;
}): boolean {
  return (
    member.twoFactorEnabled &&
    member.twoFactorMethod === "TOTP" &&
    Boolean(member.totpSecret)
  );
}

/**
 * What may refresh this person's proof.
 *
 * An authenticator app when they have one, a passkey when they have one, and
 * the password only when they have neither. An emailed code is never a factor.
 */
export async function reauthFactorsFor(member: {
  id: string;
  twoFactorEnabled: boolean;
  twoFactorMethod: string | null;
  totpSecret: string | null;
}): Promise<ReauthFactor[]> {
  const factors: ReauthFactor[] = [];
  if (memberHasAuthenticatorApp(member)) factors.push("TOTP");
  if (await memberHasPasskey(member.id)) factors.push("PASSKEY");
  if (factors.length === 0) factors.push("PASSWORD");
  return factors;
}

/**
 * Mint a single-use proof that this member just passed step-up.
 *
 * Only the keyed hash is stored. The raw token is consumed by the jwt
 * callback inside the same server-side session update, so a client POST to
 * `/api/auth/session` cannot set `lastAuthenticatedAt`.
 */
export async function createSessionReauthChallenge(memberId: string) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_REAUTH_CHALLENGE_TTL_MS);

  await prisma.$transaction([
    prisma.sessionReauthChallenge.deleteMany({
      where: { memberId, expiresAt: { lte: new Date() } },
    }),
    prisma.sessionReauthChallenge.create({
      data: {
        memberId,
        tokenHash: hashTwoFactorCode(token),
        expiresAt,
      },
    }),
  ]);

  return token;
}

/**
 * Claim one unconsumed challenge for this member.
 *
 * One `updateMany` guarded on `consumedAt` null. Of two concurrent consumers
 * of the same token, PostgreSQL lets one update the row; the other matches
 * nothing. No advisory lock.
 */
export async function consumeSessionReauthChallenge(
  memberId: string,
  token: string,
) {
  const claimed = await prisma.sessionReauthChallenge.updateMany({
    where: {
      tokenHash: { in: twoFactorCodeHashCandidates(token) },
      memberId,
      expiresAt: { gt: new Date() },
      consumedAt: null,
    },
    data: { consumedAt: new Date() },
  });
  return claimed.count === 1;
}

function lockoutResult(lockedUntil: Date): ReauthProofResult {
  return {
    ok: false,
    status: 429,
    error: "Too many invalid two-factor attempts",
    lockedUntil: lockedUntil.toISOString(),
  };
}

function throttleResult(): ReauthProofResult {
  return {
    ok: false,
    status: 429,
    error: PASSWORD_WAIT_ERROR,
    code: LOGIN_THROTTLED_CODE,
  };
}

/**
 * A proof that is not this person's factor still counts, so the endpoint is
 * not a free guessing oracle. App and passkey holders use the two-factor
 * lockout; everyone else uses the password throttle.
 */
async function countDisallowedAttempt(
  member: ReauthMember,
  factors: readonly ReauthFactor[],
): Promise<ReauthProofResult | null> {
  if (factors.includes("TOTP") || factors.includes("PASSKEY")) {
    const lockedUntil = await recordTwoFactorFailure(member.id);
    return lockedUntil ? lockoutResult(lockedUntil) : null;
  }
  if (!(await claimPasswordAttempt(member.email)).allowed) {
    return throttleResult();
  }
  return null;
}

/**
 * Check a step-up proof and, on success, mint the challenge token.
 *
 * The caller puts that token into the session update. This function never
 * writes `lastAuthenticatedAt` itself.
 */
export async function proveSessionReauth(input: {
  member: ReauthMember;
  factor: string;
  code?: string;
  password?: string;
  assertion?: unknown;
}): Promise<ReauthProofResult> {
  const { member } = input;
  const factors = await reauthFactorsFor(member);

  if (factors.includes("TOTP") || factors.includes("PASSKEY")) {
    const locked = getActiveTwoFactorLockout(member);
    if (locked) return lockoutResult(locked);
  }

  // An emailed code and a recovery code are never a step-up proof, even when
  // the stored code would verify and even when email is the sign-in factor.
  if (input.factor === "EMAIL" || input.factor === "RECOVERY") {
    const counted = await countDisallowedAttempt(member, factors);
    return counted ?? { ok: false, status: 400, error: REFUSED_FACTOR_ERROR };
  }

  if (!isReauthFactor(input.factor) || !factors.includes(input.factor)) {
    const counted = await countDisallowedAttempt(member, factors);
    return counted ?? { ok: false, status: 400, error: REFUSED_FACTOR_ERROR };
  }

  if (input.factor === "TOTP") {
    const valid = await verifyStoredTotpCode(member.id, input.code ?? "");
    if (!valid) {
      const lockedUntil = await recordTwoFactorFailure(member.id);
      if (lockedUntil) return lockoutResult(lockedUntil);
      return { ok: false, status: 400, error: INVALID_PROOF_ERROR };
    }
    await clearTwoFactorLockout(member.id);
  } else if (input.factor === "PASSKEY") {
    const valid = await verifyReauthPasskey(member.id, input.assertion);
    if (!valid) {
      const lockedUntil = await recordTwoFactorFailure(member.id);
      if (lockedUntil) return lockoutResult(lockedUntil);
      return { ok: false, status: 400, error: INVALID_PROOF_ERROR };
    }
    await clearTwoFactorLockout(member.id);
  } else {
    if (!(await claimPasswordAttempt(member.email)).allowed) {
      return throttleResult();
    }
    const valid = await bcrypt.compare(input.password ?? "", member.passwordHash);
    if (!valid) {
      return { ok: false, status: 400, error: INVALID_PROOF_ERROR };
    }
    await clearPasswordAttempts(member.email);
  }

  return {
    ok: true,
    challengeToken: await createSessionReauthChallenge(member.id),
  };
}
