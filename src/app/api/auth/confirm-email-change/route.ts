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

    const oldEmail = record.member.email;

    // Atomic: check uniqueness + update email in one transaction
    try {
      await prisma.$transaction(async (tx) => {
        const existingMember = await tx.member.findFirst({
          where: { email: record.newEmail, canLogin: true },
        });
        if (existingMember) {
          throw new Error("EMAIL_TAKEN");
        }
        await tx.member.update({
          where: { id: record.memberId },
          data: { email: record.newEmail },
        });
        await tx.member.updateMany({
          where: { parentMemberId: record.memberId },
          data: { email: record.newEmail },
        });
        await tx.emailChangeToken.delete({ where: { id: record.id } });
      });
    } catch (err) {
      if (err instanceof Error && err.message === "EMAIL_TAKEN") {
        return NextResponse.redirect(new URL("/profile?emailChangeError=taken", request.url));
      }
      // Handle Prisma unique constraint violation (P2002) as backup
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
        return NextResponse.redirect(new URL("/profile?emailChangeError=taken", request.url));
      }
      throw err;
    }

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
