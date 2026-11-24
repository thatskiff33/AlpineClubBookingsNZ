import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { sendVerificationEmail } from "@/lib/email";
import { createEmailVerificationToken } from "@/lib/verification-tokens";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { parseJsonRequestBody } from "@/lib/api-json";

const resendSchema = z.object({
  email: z.string().email(),
});

export async function POST(request: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.resendVerification, request);
  if (rateLimited) return rateLimited;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON payload",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  try {
    const parsed = resendSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }

    const member = await prisma.member.findFirst({
      where: { email: parsed.data.email.toLowerCase(), canLogin: true },
      select: { id: true, email: true, firstName: true, emailVerified: true },
    });

    // Always return 200 to avoid email enumeration
    if (!member || member.emailVerified) {
      return NextResponse.json({ success: true });
    }

    const { token, expiresAt } = await createEmailVerificationToken(member.id);
    await sendVerificationEmail(member.email, member.firstName, token, expiresAt);

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Error resending verification email");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
