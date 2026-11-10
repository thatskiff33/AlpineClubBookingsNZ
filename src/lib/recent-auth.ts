import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { auth, updateSession } from "@/lib/auth";
import { claimPasswordAttempt, clearPasswordAttempts } from "@/lib/login-throttle";
import { prisma } from "@/lib/prisma";
import {
  RECENT_AUTH_REQUIRED_STATUS,
  isRecentlyAuthenticated,
  recentAuthRequiredBody,
  resolveStepUpMethods,
  type StepUpMethod,
} from "@/lib/recent-auth-policy";
import { createSessionReauthChallenge } from "@/lib/session-reauth-challenge";
import {
  clearTwoFactorLockout,
  getActiveTwoFactorLockout,
  recordTwoFactorFailure,
  verifyStoredTotpCode,
} from "@/lib/two-factor";

/**
 * Recent authentication and step-up, server side (#4616, `INV-AUTH-008`).
 * The pure rules are in `recent-auth-policy.ts`; the challenge in
 * `session-reauth-challenge.ts`; the route is `/api/auth/reauth`.
 */

export type RequireRecentAuthResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

/**
 * THE recent-authentication check (`INV-SSOT`): refuses a request whose
 * session last proved who it is more than five minutes ago, with the typed
 * refusal the "confirm it's you" dialog recognises (HTTP 403,
 * `code: RECENT_AUTH_REQUIRED`). A request with no session answers 401.
 *
 * It adds only the recency check, read from the session token the server
 * signed; call it after the route's own guard (`requireAdmin`), which decides
 * who may act at all. No route calls it yet (#4619 adds them).
 */
export async function requireRecentAuth(): Promise<RequireRecentAuthResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    };
  }
  if (!isRecentlyAuthenticated(session.user.lastAuthenticatedAt, Date.now())) {
    return {
      ok: false,
      response: NextResponse.json(recentAuthRequiredBody(), {
        status: RECENT_AUTH_REQUIRED_STATUS,
      }),
    };
  }
  return { ok: true };
}

/**
 * What the person sends to prove themselves again, one shape per method.
 * #4617 adds the passkey assertion as a third member.
 */
export type StepUpProof =
  | { method: "TOTP"; code: string }
  | { method: "PASSWORD"; password: string };

const STEP_UP_MEMBER_SELECT = {
  id: true,
  email: true,
  passwordHash: true,
  twoFactorEnabled: true,
  twoFactorMethod: true,
  totpSecret: true,
  twoFactorLockedUntil: true,
} as const;

export type StepUpMember = {
  id: string;
  email: string;
  passwordHash: string;
  twoFactorEnabled: boolean;
  twoFactorMethod: "TOTP" | "EMAIL" | null;
  totpSecret: string | null;
  twoFactorLockedUntil: Date | null;
};

export async function loadStepUpMember(memberId: string): Promise<StepUpMember | null> {
  return prisma.member.findUnique({
    where: { id: memberId },
    select: STEP_UP_MEMBER_SELECT,
  });
}

export type StepUpOutcome =
  | { kind: "verified" }
  /** The proof is not one this person may use: the password while they have an app. */
  | { kind: "method-not-allowed"; methods: StepUpMethod[] }
  /** A wrong code or password; it counted. `lockedUntil` is set when it locked the app code. */
  | { kind: "invalid"; lockedUntil: Date | null }
  /** The app code is locked after five failures; nothing was checked or counted. */
  | { kind: "locked"; lockedUntil: Date }
  /** The account's password budget is waiting (`INV-AUTH-004`); nothing was compared. */
  | { kind: "throttled" };

/**
 * An app code counts towards the two-factor lockout every two-factor code
 * shares: a locked member is refused before the code is read, a wrong code is
 * a failure, and a right one clears the count, as at sign-in.
 */
async function verifyTotpStepUp(member: StepUpMember, code: string): Promise<StepUpOutcome> {
  const lockedUntil = getActiveTwoFactorLockout(member);
  if (lockedUntil) return { kind: "locked", lockedUntil };
  if (await verifyStoredTotpCode(member.id, code)) {
    await clearTwoFactorLockout(member.id);
    return { kind: "verified" };
  }
  return { kind: "invalid", lockedUntil: await recordTwoFactorFailure(member.id) };
}

/**
 * A password is claimed against the account's password budget before it is
 * compared, the budget password sign-in and change-password share
 * (`INV-AUTH-003`, `INV-AUTH-004`), keyed on the member's stored email. A
 * valid one clears it.
 */
async function verifyPasswordStepUp(
  member: StepUpMember,
  password: string,
): Promise<StepUpOutcome> {
  if (!(await claimPasswordAttempt(member.email)).allowed) return { kind: "throttled" };
  if (!(await bcrypt.compare(password, member.passwordHash))) {
    return { kind: "invalid", lockedUntil: null };
  }
  await clearPasswordAttempts(member.email);
  return { kind: "verified" };
}

/**
 * Checks a step-up proof. Only a method `resolveStepUpMethods` offers this
 * person is checked at all: the password is refused, unchecked and uncounted,
 * while they have an authenticator app.
 */
export async function verifyStepUpProof(
  member: StepUpMember,
  proof: StepUpProof,
): Promise<StepUpOutcome> {
  const methods = resolveStepUpMethods(member);
  if (!methods.includes(proof.method)) return { kind: "method-not-allowed", methods };
  switch (proof.method) {
    case "TOTP":
      return verifyTotpStepUp(member, proof.code);
    case "PASSWORD":
      return verifyPasswordStepUp(member, proof.password);
    default: {
      const unhandled: never = proof;
      throw new Error(`Unhandled step-up method: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Refreshes this request's session as just re-authenticated: mints a step-up
 * challenge and passes it through `updateSession()`, whose `jwt` callback
 * consumes it and moves `lastAuthenticatedAt` to now. The raw token never
 * leaves the server. True only when the session that comes back is this
 * member's, live, and now recent.
 */
export async function markSessionReauthenticated(memberId: string): Promise<boolean> {
  const reauthChallengeToken = await createSessionReauthChallenge(memberId);
  const session = await updateSession({
    user: { reauthChallengeToken },
    // The token field is not part of the public Session shape, so the literal
    // needs an assertion to pass through unstable_update's typing.
  } as unknown as Parameters<typeof updateSession>[0]);
  return (
    session?.user?.id === memberId &&
    session.user.sessionInvalidated !== true &&
    isRecentlyAuthenticated(session.user.lastAuthenticatedAt, Date.now())
  );
}
