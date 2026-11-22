import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import {
  consumeRecoveryCode,
  recordTwoFactorFailure,
  verifyStoredTotpCode,
  verifyTwoFactorEmailCode,
} from "@/lib/two-factor";
import {
  markTwoFactorSessionVerified,
  passwordChangeRequiredResponse,
  requireTwoFactorApiSession,
  twoFactorLockoutResponse,
} from "@/lib/two-factor-api";
import { parseJsonRequestBody } from "@/lib/api-json";

const verifySchema = z
  .object({
    method: z.enum(["TOTP", "EMAIL", "RECOVERY"]),
    code: z.string().trim().min(4).max(32),
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

  if (!guard.member.twoFactorEnabled || !guard.member.twoFactorMethod) {
    return NextResponse.json(
      { error: "Two-factor authentication is not enrolled" },
      { status: 409 },
    );
  }

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON payload",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { method, code } = parsed.data;
  let valid = false;

  if (method === "RECOVERY") {
    valid = await consumeRecoveryCode(guard.member.id, code);
  } else if (method === "TOTP" && guard.member.twoFactorMethod === "TOTP") {
    valid = await verifyStoredTotpCode(guard.member.id, code);
  } else if (method === "EMAIL" && guard.member.twoFactorMethod === "EMAIL") {
    valid = await verifyTwoFactorEmailCode(guard.member.id, code);
  }

  if (!valid) {
    await recordTwoFactorFailure(guard.member.id);
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  await markTwoFactorSessionVerified(method);
  return NextResponse.json({ ok: true });
}
