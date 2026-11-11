import { NextRequest, NextResponse } from "next/server";

import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import {
  passwordChangeRequiredResponse,
  requireTwoFactorApiSession,
  twoFactorLockoutResponse,
  type TwoFactorApiMember,
  type TwoFactorApiSession,
} from "@/lib/two-factor-api";

export type PasskeyGuard =
  | {
      ok: true;
      request: NextRequest;
      session: NonNullable<TwoFactorApiSession>;
      member: TwoFactorApiMember;
    }
  | { ok: false; response: Response };

/** Same limiter and session load as the authenticator-code verify route. */
export async function guardPasskeyRequest(request: NextRequest): Promise<PasskeyGuard> {
  const rateLimited = await applyRateLimit(rateLimiters.twoFactorVerify, request);
  if (rateLimited) return { ok: false, response: rateLimited };

  const guard = await requireTwoFactorApiSession();
  if (!guard.ok) return { ok: false, response: guard.response };

  return { ok: true, request, session: guard.session, member: guard.member };
}

export function passkeyJsonError(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export function registrationAllowed(guard: Extract<PasskeyGuard, { ok: true }>) {
  if (guard.member.forcePasswordChange) return passwordChangeRequiredResponse();
  const required = guard.session.user.twoFactorRequired === true;
  const verified = guard.session.user.twoFactorVerified === true;
  if (required && !verified) {
    return passkeyJsonError(403, "Finish signing in before adding a passkey.");
  }
  return null;
}

export function authenticationAllowed(guard: Extract<PasskeyGuard, { ok: true }>) {
  if (guard.member.forcePasswordChange) return passwordChangeRequiredResponse();
  const locked = twoFactorLockoutResponse(guard.member);
  if (locked) return locked;
  if (!guard.session.user.twoFactorRequired || guard.session.user.twoFactorVerified) {
    return passkeyJsonError(400, "Two-factor authentication is not required");
  }
  return null;
}
