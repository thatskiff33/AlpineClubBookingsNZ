import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isXeroConnected, updateXeroContact } from "@/lib/xero";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";

export async function GET(request: NextRequest) {
  const baseUrl = process.env.NEXTAUTH_URL || request.url;
  const token = request.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.redirect(new URL("/profile?emailChangeError=missing", baseUrl));
  }

  try {
    const record = await prisma.emailChangeToken.findUnique({
      where: { token },
      include: {
        member: {
          select: {
            id: true, email: true, firstName: true, lastName: true, xeroContactId: true,
            phoneCountryCode: true, phoneAreaCode: true, phoneNumber: true,
            streetAddressLine1: true, streetAddressLine2: true, streetCity: true,
            streetRegion: true, streetPostalCode: true, streetCountry: true,
            postalAddressLine1: true, postalAddressLine2: true, postalCity: true,
            postalRegion: true, postalPostalCode: true, postalCountry: true,
          },
        },
      },
    });

    if (!record) {
      return NextResponse.redirect(new URL("/profile?emailChangeError=invalid", baseUrl));
    }

    if (record.expiresAt < new Date()) {
      await prisma.emailChangeToken.delete({ where: { id: record.id } });
      return NextResponse.redirect(new URL("/profile?emailChangeError=expired", baseUrl));
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
        // Update email for members who inherit email from this member
        await tx.member.updateMany({
          where: { inheritEmailFromId: record.memberId },
          data: { email: record.newEmail },
        });
        await tx.emailChangeToken.delete({ where: { id: record.id } });
      });
    } catch (err) {
      if (err instanceof Error && err.message === "EMAIL_TAKEN") {
        return NextResponse.redirect(new URL("/profile?emailChangeError=taken", baseUrl));
      }
      // Handle Prisma unique constraint violation (P2002) as backup
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
        return NextResponse.redirect(new URL("/profile?emailChangeError=taken", baseUrl));
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
              phoneCountryCode: record.member.phoneCountryCode,
              phoneAreaCode: record.member.phoneAreaCode,
              phoneNumber: record.member.phoneNumber,
              streetAddressLine1: record.member.streetAddressLine1,
              streetAddressLine2: record.member.streetAddressLine2,
              streetCity: record.member.streetCity,
              streetRegion: record.member.streetRegion,
              streetPostalCode: record.member.streetPostalCode,
              streetCountry: record.member.streetCountry,
              postalAddressLine1: record.member.postalAddressLine1,
              postalAddressLine2: record.member.postalAddressLine2,
              postalCity: record.member.postalCity,
              postalRegion: record.member.postalRegion,
              postalPostalCode: record.member.postalPostalCode,
              postalCountry: record.member.postalCountry,
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

    return NextResponse.redirect(new URL("/profile?emailChanged=true", baseUrl));
  } catch (err) {
    logger.error({ err }, "Error confirming email change");
    return NextResponse.redirect(new URL("/profile?emailChangeError=error", baseUrl));
  }
}
