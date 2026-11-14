import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { getAuditRequestContext } from "@/lib/audit";
import {
  enrollTwoFactor,
  recordTwoFactorFailure,
  verifyTwoFactorEmailCode,
} from "@/lib/two-factor";
import {
  enrolmentSessionIssuedAt,
  factorResetEnrolmentResponse,
  markTwoFactorSessionVerified,
  passwordChangeRequiredResponse,
  requireTwoFactorApiSession,
  twoFactorLockoutResponse,
} from "@/lib/two-factor-api";

const enrollEmailSchema = z
  .object({
    code: z.string().trim().min(6).max(16),
  })
  .strict();

export async function POST(request: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.twoFactorVerify, request);
  if (rateLimited) return rateLimited;

  const guard = await requireTwoFactorApiSession();
  if (!guard.ok) return guard.response;

  if (guard.member.forcePasswordChange) {
    return passwordChangeRequiredResponse();
  }

  const locked = twoFactorLockoutResponse(guard.member);
  if (locked) return locked;

  if (!guard.session.user.twoFactorRequired) {
    return NextResponse.json(
      { error: "Two-factor authentication is not required" },
      { status: 400 },
    );
  }

  if (guard.member.twoFactorEnabled) {
    return NextResponse.json(
      { error: "Two-factor authentication is already enrolled" },
      { status: 409 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = enrollEmailSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const valid = await verifyTwoFactorEmailCode(
    guard.member.id,
    parsed.data.code,
  );
  if (!valid) {
    await recordTwoFactorFailure(guard.member.id);
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  let recoveryCodes: string[];
  try {
    recoveryCodes = await enrollTwoFactor({
      memberId: guard.member.id,
      method: "EMAIL",
      // The member is enrolling their own second factor (#3454).
      actor: { kind: "member", memberId: guard.member.id },
      request: getAuditRequestContext(request),
      sessionIssuedAt: enrolmentSessionIssuedAt(guard.session),
    });
  } catch (error) {
    const reset = factorResetEnrolmentResponse(error);
    if (reset) return reset;
    throw error;
  }
  await markTwoFactorSessionVerified("EMAIL");

  return NextResponse.json({ ok: true, recoveryCodes });
}
