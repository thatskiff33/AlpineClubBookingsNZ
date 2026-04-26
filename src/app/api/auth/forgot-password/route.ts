import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { sendPasswordResetEmail } from "@/lib/email";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { SELF_SERVICE_PASSWORD_RESET_TTL_MS } from "@/lib/password-reset";

const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
});

export async function POST(req: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.forgotPassword, req);
  if (rateLimited) return rateLimited;

  try {
    const body = await req.json();
    const parsed = forgotPasswordSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { email } = parsed.data;

    // Always return success to avoid leaking which emails are registered
    const member = await prisma.member.findFirst({
      where: { email: email.toLowerCase(), canLogin: true },
    });

    if (member && member.active) {
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + SELF_SERVICE_PASSWORD_RESET_TTL_MS);

      // Invalidate any existing reset tokens for this member
      await prisma.passwordResetToken.deleteMany({
        where: { memberId: member.id },
      });

      await prisma.passwordResetToken.create({
        data: {
          token,
          memberId: member.id,
          expiresAt,
        },
      });

      // Fire-and-forget — don't reveal failure to the client
      sendPasswordResetEmail(member.email, token).catch((err) => {
        logger.error({ err }, "Failed to send password reset email");
      });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Unexpected error in forgot-password");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
