import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { sendPasswordResetEmail } from "@/lib/email";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { checkAccountRequestLimit } from "@/lib/account-request-limit";
import { normaliseSignInEmail } from "@/lib/login-throttle";
import logger from "@/lib/logger";
import { issueActionToken } from "@/lib/action-tokens";
import { SELF_SERVICE_PASSWORD_RESET_TTL_MS } from "@/lib/password-reset";

const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
});

/**
 * The one answer for every valid request: a sent reset, an unknown or
 * ineligible account, and an account over its per-account limit (INV-AUTH-005).
 */
function accepted() {
  return NextResponse.json({ success: true });
}

export async function POST(req: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.forgotPassword, req);
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  try {
    const parsed = forgotPasswordSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { email } = parsed.data;

    // Per-account limit (#4613): decided from the email alone, before any
    // Member read, so real and unknown accounts are counted and answered alike.
    const account = await checkAccountRequestLimit(rateLimiters.forgotPasswordAccount, email);
    if (!account.success) {
      logger.info(
        { limiterId: rateLimiters.forgotPasswordAccount.id },
        "Per-account request limit reached; no password reset email sent"
      );
      return accepted();
    }

    // Always return success to avoid leaking which emails are registered
    const member = await prisma.member.findFirst({
      where: { email: normaliseSignInEmail(email), canLogin: true },
    });

    if (member && member.active) {
      const { token, tokenHash } = issueActionToken();
      const expiresAt = new Date(Date.now() + SELF_SERVICE_PASSWORD_RESET_TTL_MS);

      // Invalidate any existing reset tokens for this member
      await prisma.passwordResetToken.deleteMany({
        where: { memberId: member.id },
      });

      await prisma.passwordResetToken.create({
        data: {
          tokenHash,
          memberId: member.id,
          expiresAt,
        },
      });

      // Fire-and-forget — don't reveal failure to the client
      sendPasswordResetEmail(member.email, token).catch((err) => {
        logger.error({ err }, "Failed to send password reset email");
      });
    }

    return accepted();
  } catch (err) {
    logger.error({ err }, "Unexpected error in forgot-password");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
