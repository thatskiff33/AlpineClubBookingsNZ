import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isXeroConnected } from "@/lib/xero-token-store";
import { updateXeroContact } from "@/lib/xero-contacts";
import {
  createStructuredAuditLog,
  getAuditEmailDomain,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  buildXeroContactUpdatePayload,
  shouldRepairXeroContactNameOrder,
} from "@/lib/xero-contact-sync";
import logger from "@/lib/logger";
import { hashActionToken, isActionTokenFormat } from "@/lib/action-tokens";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { isLoginEmailUniqueConflict } from "@/lib/member-email";
import { reconcileEmailInheritanceForMemberChange } from "@/lib/member-email-inheritance";
import {
  describeUniqueConstraintTarget,
  isPrismaUniqueConstraintError,
} from "@/lib/prisma-errors";

const confirmEmailChangeQuerySchema = z.object({
  token: z.string().trim().refine(isActionTokenFormat),
});

const XERO_CONTACT_SYNC_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  xeroContactId: true,
  dateOfBirth: true,
  phoneCountryCode: true,
  phoneAreaCode: true,
  phoneNumber: true,
  streetAddressLine1: true,
  streetAddressLine2: true,
  streetCity: true,
  streetRegion: true,
  streetPostalCode: true,
  streetCountry: true,
  postalAddressLine1: true,
  postalAddressLine2: true,
  postalCity: true,
  postalRegion: true,
  postalPostalCode: true,
  postalCountry: true,
} as const;

export async function GET(request: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.verificationToken, request);
  if (rateLimited) {
    return rateLimited;
  }

  const baseUrl = process.env.NEXTAUTH_URL || request.url;
  const tokenParam = request.nextUrl.searchParams.get("token");
  if (!tokenParam) {
    return NextResponse.redirect(new URL("/profile?emailChangeError=missing", baseUrl));
  }

  const parsed = confirmEmailChangeQuerySchema.safeParse({
    token: tokenParam,
  });

  if (!parsed.success) {
    return NextResponse.redirect(new URL("/profile?emailChangeError=invalid", baseUrl));
  }
  const { token } = parsed.data;

  try {
    const record = await prisma.emailChangeToken.findUnique({
      where: { tokenHash: hashActionToken(token) },
      include: {
        member: { select: XERO_CONTACT_SYNC_SELECT },
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
        // #2716: re-resolve BEFORE the denormalised copy below, and in this same
        // transaction. A member confirming a new address may be somebody's
        // recorded email source who currently resolves to nobody — their
        // previous address was anonymised or replaced by a placeholder — and
        // this is the "address ADDED" event that must bring those pointers back.
        // Running it first means the copy below reaches the dependants this
        // restores, not just the ones that were already pointing here.
        const reconciliation = await reconcileEmailInheritanceForMemberChange(
          tx,
          [record.memberId],
          { trigger: "source-member-change", actorMemberId: record.memberId },
        );
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
              emailInheritanceReconciliation: {
                examined: reconciliation.examined,
                repointed: reconciliation.repointed,
                cleared: reconciliation.cleared,
                unresolved: reconciliation.unresolved.length,
              },
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
      // Backstop for the race the EMAIL_TAKEN pre-check above cannot close: the
      // uniqueness query and the update run in one transaction, but a concurrent
      // write can still claim the address between them and the partial unique
      // index `Member_email_login_unique` rejects this update.
      //
      // Narrowed from "any P2002 here means the address is taken" (#2455,
      // matching what #2412 did for the member create): a collision the database
      // names as some OTHER constraint is a genuine failure, and telling the
      // member their new address is taken would send them off to change an
      // address that is perfectly fine. It falls through to the outer handler
      // and the honest `emailChangeError=error`.
      //
      // A P2002 that names NOTHING is still read as the address clash, because
      // the email writes are the only unique-bearing statements this transaction
      // makes: deleting the token cannot violate a unique constraint, and
      // `AuditLog` carries none at all. Staying silent would leave the member an
      // unexplained failure for what is almost certainly the clash.
      //
      // The constraint is logged beside the error because the pino `err`
      // serializer keeps only name/message/stack and would drop `meta` entirely
      // — including the adapter detail that names the column.
      if (isPrismaUniqueConstraintError(err)) {
        if (isLoginEmailUniqueConflict(err)) {
          return NextResponse.redirect(new URL("/profile?emailChangeError=taken", baseUrl));
        }
        logger.error(
          {
            err,
            memberId: record.memberId,
            constraint: describeUniqueConstraintTarget(err),
          },
          "Email change confirmation hit an unexpected unique constraint"
        );
      }
      throw err;
    }

    const inheritedLinkedMembers = await prisma.member.findMany({
      where: {
        inheritEmailFromId: record.memberId,
        xeroContactId: { not: null },
      },
      select: XERO_CONTACT_SYNC_SELECT,
    });
    const xeroContactMembers = [
      ...(record.member.xeroContactId
        ? [{ ...record.member, email: record.newEmail }]
        : []),
      ...inheritedLinkedMembers,
    ];

    // Update linked Xero contacts if connected (fire-and-forget)
    if (xeroContactMembers.length > 0) {
      isXeroConnected()
        .then(async (connected) => {
          if (connected) {
            for (const member of xeroContactMembers) {
              const shouldRepairContactNameOrder =
                await shouldRepairXeroContactNameOrder(member);
              await updateXeroContact(
                member.xeroContactId!,
                buildXeroContactUpdatePayload(member),
                {
                  localModel: "Member",
                  localId: member.id,
                  createdByMemberId: record.member.id,
                  preserveXeroName: !shouldRepairContactNameOrder,
                }
              );
            }
          }
        })
        .catch((err) => {
          logger.error(
            { err, memberId: record.memberId, inheritedMemberCount: inheritedLinkedMembers.length },
            "Failed to update Xero contact email"
          );
        });
    }

    return NextResponse.redirect(new URL("/profile?emailChanged=true", baseUrl));
  } catch (err) {
    logger.error({ err }, "Error confirming email change");
    return NextResponse.redirect(new URL("/profile?emailChangeError=error", baseUrl));
  }
}
