import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { getAuditRequestContext } from "@/lib/audit";
import {
  enrollTwoFactor,
  recordTwoFactorFailure,
  verifyTotpCode,
} from "@/lib/two-factor";
import {
  markTwoFactorSessionVerified,
  passwordChangeRequiredResponse,
  requireTwoFactorApiSession,
  twoFactorLockoutResponse,
} from "@/lib/two-factor-api";

const enrollTotpSchema = z
  .object({
    secret: z.string().trim().min(16).max(128),
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

  const parsed = enrollTotpSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (!verifyTotpCode(parsed.data.secret, parsed.data.code)) {
    await recordTwoFactorFailure(guard.member.id);
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  const recoveryCodes = await enrollTwoFactor({
    memberId: guard.member.id,
    method: "TOTP",
    totpSecret: parsed.data.secret,
    // The member is enrolling their own second factor (#3454).
    actor: { kind: "member", memberId: guard.member.id },
    request: getAuditRequestContext(request),
  });
  await markTwoFactorSessionVerified();

  return NextResponse.json({ ok: true, recoveryCodes });
}
