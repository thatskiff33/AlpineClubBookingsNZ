import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isXeroConnected, updateXeroContact } from "@/lib/xero";
import {
  createStructuredAuditLog,
  getAuditEmailDomain,
  getAuditRequestContext,
} from "@/lib/audit";
import { buildXeroContactUpdatePayload } from "@/lib/xero-contact-sync";
import logger from "@/lib/logger";
import { hashActionToken } from "@/lib/action-tokens";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

const confirmEmailChangeQuerySchema = z.object({
  token: z.string().min(1),
});

export async function GET(request: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.verificationToken, request);
  if (rateLimited) {
    return rateLimited;
  }

  const baseUrl = process.env.NEXTAUTH_URL || request.url;
  const parsed = confirmEmailChangeQuerySchema.safeParse({
    token: request.nextUrl.searchParams.get("token"),
  });

  if (!parsed.success) {
    return NextResponse.redirect(new URL("/profile?emailChangeError=missing", baseUrl));
  }
  const { token } = parsed.data;

  try {
    const record = await prisma.emailChangeToken.findUnique({
      where: { tokenHash: hashActionToken(token) },
      include: {
        member: {
          select: {
            id: true, email: true, firstName: true, lastName: true, xeroContactId: true,
            dateOfBirth: true,
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
        const inheritedMembers = await tx.member.updateMany({
          where: { inheritEmailFromId: record.memberId },
          data: { email: record.newEmail },
        });
        await tx.emailChangeToken.delete({ where: { id: record.id } });
        await createStructuredAuditLog(
          {
            action: "EMAIL_CHANGED",
            actor: { memberId: record.memberId },
            subject: { memberId: record.memberId },
            entity: { type: "Member", id: record.memberId },
            category: "security",
            severity: "critical",
            outcome: "success",
            summary: "Email change confirmed",
            metadata: {
              emailChange: {
                confirmed: true,
                oldDomain: getAuditEmailDomain(oldEmail),
                newDomain: getAuditEmailDomain(record.newEmail),
              },
              inheritedMemberUpdateCount: inheritedMembers.count,
            },
            request: getAuditRequestContext(request),
          },
          tx
        );
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
            await updateXeroContact(
              record.member.xeroContactId!,
              buildXeroContactUpdatePayload({
                ...record.member,
                email: record.newEmail,
              }),
              {
                localModel: "Member",
                localId: record.member.id,
                createdByMemberId: record.member.id,
              }
            );
          }
        })
        .catch((err) => {
          logger.error({ err, memberId: record.memberId }, "Failed to update Xero contact email");
        });
    }

    return NextResponse.redirect(new URL("/profile?emailChanged=true", baseUrl));
  } catch (err) {
    logger.error({ err }, "Error confirming email change");
    return NextResponse.redirect(new URL("/profile?emailChangeError=error", baseUrl));
  }
}
