import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { sendVerificationEmail } from "@/lib/email";
import { createEmailVerificationToken } from "@/lib/verification-tokens";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import logger from "@/lib/logger";

const resendSchema = z.object({
  email: z.string().email(),
});

export async function POST(request: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.resendVerification, request);
  if (rateLimited) return rateLimited;

  try {
    const body = await request.json();
    const parsed = resendSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }

    const member = await prisma.member.findFirst({
      where: { email: parsed.data.email.toLowerCase(), parentMemberId: null },
      select: { id: true, email: true, firstName: true, emailVerified: true },
    });

    // Always return 200 to avoid email enumeration
    if (!member || member.emailVerified) {
      return NextResponse.json({ success: true });
    }

    const token = await createEmailVerificationToken(member.id);
    await sendVerificationEmail(member.email, member.firstName, token);

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Error resending verification email");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
