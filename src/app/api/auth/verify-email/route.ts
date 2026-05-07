import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { hashActionToken } from "@/lib/action-tokens";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

const verifyEmailQuerySchema = z.object({
  token: z.string().min(1),
});

export async function GET(request: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.verificationToken, request);
  if (rateLimited) {
    return rateLimited;
  }

  const baseUrl = process.env.NEXTAUTH_URL || request.url;
  const parsed = verifyEmailQuerySchema.safeParse({
    token: request.nextUrl.searchParams.get("token"),
  });

  if (!parsed.success) {
    return NextResponse.redirect(new URL("/login?verifyError=missing", baseUrl));
  }
  const { token } = parsed.data;

  try {
    const record = await prisma.emailVerificationToken.findUnique({
      where: { tokenHash: hashActionToken(token) },
      include: { member: { select: { id: true, emailVerified: true } } },
    });

    if (!record) {
      return NextResponse.redirect(new URL("/login?verifyError=invalid", baseUrl));
    }

    if (record.expiresAt < new Date()) {
      // Clean up expired token
      await prisma.emailVerificationToken.delete({ where: { id: record.id } });
      return NextResponse.redirect(new URL("/login?verifyError=expired", baseUrl));
    }

    if (record.member.emailVerified) {
      // Already verified - clean up token and redirect to login
      await prisma.emailVerificationToken.delete({ where: { id: record.id } });
      return NextResponse.redirect(new URL("/login?verified=true", baseUrl));
    }

    // Verify the email and delete the token
    await prisma.$transaction([
      prisma.member.update({
        where: { id: record.memberId },
        data: { emailVerified: true },
      }),
      prisma.emailVerificationToken.delete({ where: { id: record.id } }),
    ]);

    return NextResponse.redirect(new URL("/login?verified=true", baseUrl));
  } catch (err) {
    logger.error({ err }, "Error verifying email");
    return NextResponse.redirect(new URL("/login?verifyError=error", baseUrl));
  }
}
