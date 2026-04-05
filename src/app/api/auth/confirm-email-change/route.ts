import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isXeroConnected, updateXeroContact } from "@/lib/xero";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.redirect(new URL("/profile?emailChangeError=missing", request.url));
  }

  try {
    const record = await prisma.emailChangeToken.findUnique({
      where: { token },
      include: {
        member: {
          select: { id: true, email: true, firstName: true, lastName: true, phone: true, xeroContactId: true },
        },
      },
    });

    if (!record) {
      return NextResponse.redirect(new URL("/profile?emailChangeError=invalid", request.url));
    }

    if (record.expiresAt < new Date()) {
      await prisma.emailChangeToken.delete({ where: { id: record.id } });
      return NextResponse.redirect(new URL("/profile?emailChangeError=expired", request.url));
    }

    // Check new email isn't taken (race condition check)
    const existing = await prisma.member.findUnique({
      where: { email: record.newEmail },
      select: { id: true },
    });

    if (existing) {
      await prisma.emailChangeToken.delete({ where: { id: record.id } });
      return NextResponse.redirect(new URL("/profile?emailChangeError=taken", request.url));
    }

    const oldEmail = record.member.email;

    // Update email and delete token atomically
    await prisma.$transaction([
      prisma.member.update({
        where: { id: record.memberId },
        data: { email: record.newEmail },
      }),
      prisma.emailChangeToken.delete({ where: { id: record.id } }),
    ]);

    // Update Xero contact if connected (fire-and-forget)
    if (record.member.xeroContactId) {
      isXeroConnected()
        .then(async (connected) => {
          if (connected) {
            await updateXeroContact(record.member.xeroContactId!, {
              firstName: record.member.firstName,
              lastName: record.member.lastName,
              email: record.newEmail,
              phone: record.member.phone,
            });
          }
        })
        .catch((err) => {
          logger.error({ err, memberId: record.memberId }, "Failed to update Xero contact email");
        });
    }

    logAudit({
      action: "EMAIL_CHANGED",
      memberId: record.memberId,
      details: JSON.stringify({ oldEmail, newEmail: record.newEmail }),
    });

    return NextResponse.redirect(new URL("/profile?emailChanged=true", request.url));
  } catch (err) {
    logger.error({ err }, "Error confirming email change");
    return NextResponse.redirect(new URL("/profile?emailChangeError=error", request.url));
  }
}
