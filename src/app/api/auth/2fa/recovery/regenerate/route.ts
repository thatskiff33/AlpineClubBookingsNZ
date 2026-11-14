import { NextRequest, NextResponse } from "next/server";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { getAuditRequestContext } from "@/lib/audit";
import { replaceRecoveryCodes } from "@/lib/two-factor";
import {
  enrolmentSessionIssuedAt,
  factorResetEnrolmentResponse,
  passwordChangeRequiredResponse,
  requireTwoFactorApiSession,
} from "@/lib/two-factor-api";

export async function POST(request: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.twoFactorVerify, request);
  if (rateLimited) return rateLimited;

  const guard = await requireTwoFactorApiSession();
  if (!guard.ok) return guard.response;

  if (guard.member.forcePasswordChange) {
    return passwordChangeRequiredResponse();
  }

  if (
    guard.session.user.twoFactorRequired &&
    !guard.session.user.twoFactorVerified
  ) {
    return NextResponse.json(
      { error: "Two-factor verification required" },
      { status: 403 },
    );
  }

  if (!guard.member.twoFactorEnabled) {
    return NextResponse.json(
      { error: "Two-factor authentication is not enrolled" },
      { status: 409 },
    );
  }

  let recoveryCodes: string[];
  try {
    recoveryCodes = await replaceRecoveryCodes({
      memberId: guard.member.id,
      // The member is replacing their own codes (#3454).
      actor: { kind: "member", memberId: guard.member.id },
      request: getAuditRequestContext(request),
      sessionIssuedAt: enrolmentSessionIssuedAt(guard.session),
    });
  } catch (error) {
    const reset = factorResetEnrolmentResponse(error);
    if (reset) return reset;
    throw error;
  }
  return NextResponse.json({ ok: true, recoveryCodes });
}
