import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { sendPasswordResetEmail } from "@/lib/email";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import logger from "@/lib/logger";

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
      where: { email: email.toLowerCase(), parentMemberId: null },
    });

    if (member && member.active) {
      const token = randomBytes(32).toString("hex");
      // Password reset: 2h expiry (allows time for email delivery delays)
      const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours

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
