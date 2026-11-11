import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { auth, updateSession } from "@/lib/auth";
import { claimPasswordAttempt, clearPasswordAttempts } from "@/lib/login-throttle";
import { prisma } from "@/lib/prisma";
import {
  RECENT_AUTH_REQUIRED_CODE,
  RECENT_AUTH_REQUIRED_STATUS,
  isRecentlyAuthenticated,
  resolveStepUpMethods,
  type StepUpMethod,
} from "@/lib/recent-auth-policy";
import { createSessionReauthChallenge } from "@/lib/session-reauth-challenge";
import { twoFactorRequiredResponse } from "@/lib/session-guards";
import { isTwoFactorSessionBlocked } from "@/lib/two-factor-gate";
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
 * The typed refusal, built here and nowhere else: the dialog replays any
 * response carrying this code, which is safe only because the one function
 * below that sends it runs before anything happens.
 */
function recentAuthRequiredResponse(): NextResponse {
  return NextResponse.json(
    { error: "Please confirm it's you to continue.", code: RECENT_AUTH_REQUIRED_CODE },
    { status: RECENT_AUTH_REQUIRED_STATUS },
  );
}

/**
 * THE recent-authentication check (`INV-SSOT`): refuses a request whose
 * session last proved who it is more than five minutes ago, with the typed
 * refusal the "confirm it's you" dialog recognises (HTTP 403,
 * `code: RECENT_AUTH_REQUIRED`). A request with no session answers 401.
 *
 * **It runs before any side effect or body read; a refusal means nothing
 * happened.** The dialog replays a refused request once, body unchanged, so a
 * caller that wrote, sent or consumed anything before this check would act
 * twice. Call it straight after the route's own guard (`requireAdmin`), which
 * decides who may act at all, and before reading the request body.
 *
 * It does not lean on that guard for the sign-in itself: a session whose
 * required two-factor step is not done answers the two-factor refusal, never
 * the step-up one, whatever its stamp. No route calls it yet (#4619 adds them).
 */
export async function requireRecentAuth(): Promise<RequireRecentAuthResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    };
  }
  if (isTwoFactorSessionBlocked({ sessionUser: session.user })) {
    return { ok: false, response: twoFactorRequiredResponse() };
  }
  if (!isRecentlyAuthenticated(session.user.lastAuthenticatedAt, Date.now())) {
    return { ok: false, response: recentAuthRequiredResponse() };
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
  /** The person has no usable method (an app enrolment with no stored secret); nothing was checked. */
  | { kind: "unavailable" }
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
 * while they are enrolled with an authenticator app, and an app enrolment
 * missing its secret is refused outright rather than falling back to it.
 */
export async function verifyStepUpProof(
  member: StepUpMember,
  proof: StepUpProof,
): Promise<StepUpOutcome> {
  const methods = resolveStepUpMethods(member);
  if (methods.length === 0) return { kind: "unavailable" };
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
 * member's, live, and stamped no earlier than this mint — proof that THIS
 * challenge was consumed, not merely that an earlier proof is still recent.
 */
export async function markSessionReauthenticated(memberId: string): Promise<boolean> {
  const mintedAt = Date.now();
  const reauthChallengeToken = await createSessionReauthChallenge(memberId);
  const session = await updateSession({
    user: { reauthChallengeToken },
    // The token field is not part of the public Session shape, so the literal
    // needs an assertion to pass through unstable_update's typing.
  } as unknown as Parameters<typeof updateSession>[0]);
  const stamp = session?.user?.lastAuthenticatedAt;
  return (
    session?.user?.id === memberId &&
    session.user.sessionInvalidated !== true &&
    typeof stamp === "number" &&
    stamp >= mintedAt &&
    isRecentlyAuthenticated(stamp, Date.now())
  );
}
