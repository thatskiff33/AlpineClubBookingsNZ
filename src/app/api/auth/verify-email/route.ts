import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.redirect(new URL("/login?verifyError=missing", request.url));
  }

  try {
    const record = await prisma.emailVerificationToken.findUnique({
      where: { token },
      include: { member: { select: { id: true, emailVerified: true } } },
    });

    if (!record) {
      return NextResponse.redirect(new URL("/login?verifyError=invalid", request.url));
    }

    if (record.expiresAt < new Date()) {
      // Clean up expired token
      await prisma.emailVerificationToken.delete({ where: { id: record.id } });
      return NextResponse.redirect(new URL("/login?verifyError=expired", request.url));
    }

    if (record.member.emailVerified) {
      // Already verified - clean up token and redirect to login
      await prisma.emailVerificationToken.delete({ where: { id: record.id } });
      return NextResponse.redirect(new URL("/login?verified=true", request.url));
    }

    // Verify the email and delete the token
    await prisma.$transaction([
      prisma.member.update({
        where: { id: record.memberId },
        data: { emailVerified: true },
      }),
      prisma.emailVerificationToken.delete({ where: { id: record.id } }),
    ]);

    return NextResponse.redirect(new URL("/login?verified=true", request.url));
  } catch (err) {
    logger.error({ err }, "Error verifying email");
    return NextResponse.redirect(new URL("/login?verifyError=error", request.url));
  }
}
