import { randomBytes } from "crypto";
import { hash } from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { isHostingCoverageParticipantRetry } from "@/lib/adult-member-hosting-queue-participants";
import logger from "@/lib/logger";
import { ensureMemberAccessRolesFromCompatibilityFields } from "@/lib/member-access-role-writes";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { parseXeroContactDateOfBirth } from "@/lib/xero-contact-date-of-birth";
import { buildXeroContactUrl } from "@/lib/xero-links";
import { isXeroSandboxContactEmail } from "@/lib/xero-sandbox-contact-email";
import { getXeroOrgShortCode } from "@/lib/xero-link-short-code";
import { upsertXeroObjectLink } from "@/lib/xero-sync";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
  refreshXeroContactCachesFromContact,
  syncMemberSubscriptionHistoryForLinkedContact,
} from "@/lib/xero";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import {
  importedMemberRecovery,
  xeroPartialSuccessBody,
} from "@/lib/xero-partial-success";

const importMemberContactSchema = z.object({
  xeroContactId: z.string().trim().min(1),
});

function getContactNameParts(contact: {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}) {
  let firstName = contact.firstName?.trim() ?? "";
  let lastName = contact.lastName?.trim() ?? "";

  if (!firstName && !lastName && contact.name?.trim()) {
    const parts = contact.name.trim().split(/\s+/);
    firstName = parts[0] ?? "";
    lastName = parts.slice(1).join(" ");
  }

  return {
    firstName: firstName || "Unknown",
    lastName: lastName || "Unknown",
  };
}

/**
 * POST /api/admin/xero/import-member-contact
 * Import one unlinked Xero contact as a local member.
 */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = importMemberContactSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { xeroContactId } = parsed.data;
  let importedMemberId: string | null = null;
  let importedXeroContactId: string | null = null;
  let contactLinked = false;
  let subscriptionRefreshPending = false;

  try {
    const existingLink = await prisma.member.findFirst({
      where: { xeroContactId },
      select: { id: true, firstName: true, lastName: true },
    });
    if (existingLink) {
      return NextResponse.json(
        {
          error: `This Xero contact is already linked to ${existingLink.firstName} ${existingLink.lastName}`,
          existingMemberId: existingLink.id,
        },
        { status: 409 }
      );
    }

    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const contactRes = await callXeroApi(
      () => xero.accountingApi.getContact(tenantId, xeroContactId),
      {
        operation: "getContact",
        resourceType: "CONTACT",
        workflow: "adminImportXeroContactAsMember",
        context: `importMemberContact(${xeroContactId})`,
      }
    );
    const contact = contactRes.body.contacts?.[0];
    if (!contact?.contactID) {
      return NextResponse.json({ error: "Xero contact not found" }, { status: 404 });
    }

    const { cachedContact } = await refreshXeroContactCachesFromContact(contact);
    if (!cachedContact) {
      return NextResponse.json(
        { error: "Xero contact could not be cached for import" },
        { status: 422 }
      );
    }

    const email = cachedContact.emailAddress?.toLowerCase().trim();
    if (!email) {
      return NextResponse.json(
        { error: "This Xero contact has no email address and cannot be imported as a member." },
        { status: 422 }
      );
    }
    // INV-CONFIG-005 (#3036): a contained address must never become a
    // `Member.email`. It is a hash of somebody's real address on a reserved
    // domain, so importing it would create a member who LOOKS reachable
    // (`isPlaceholderContactEmail` says nothing about this domain, deliberately)
    // and can never receive anything — the silent-unreachability defect #2716
    // exists to prevent, arriving from a new direction.
    if (isXeroSandboxContactEmail(email)) {
      return NextResponse.json(
        {
          error:
            "This Xero contact's email address has been replaced with a non-deliverable one because this installation is a copy, so it cannot be imported as a member. Import it on the club's live site instead.",
        },
        { status: 422 }
      );
    }

    const { firstName, lastName } = getContactNameParts(cachedContact);
    const existingNameMatch = await prisma.member.findFirst({
      where: {
        firstName: { equals: firstName, mode: "insensitive" },
        lastName: { equals: lastName, mode: "insensitive" },
      },
      select: { id: true, firstName: true, lastName: true, email: true, xeroContactId: true },
    });
    if (existingNameMatch) {
      return NextResponse.json(
        {
          error: `A local member named ${existingNameMatch.firstName} ${existingNameMatch.lastName} already exists.`,
          existingMemberId: existingNameMatch.id,
          existingMemberEmail: existingNameMatch.email,
          existingMemberXeroContactId: existingNameMatch.xeroContactId,
        },
        { status: 409 }
      );
    }

    const existingLoginForEmail = await prisma.member.findFirst({
      where: { email, canLogin: true },
      select: { id: true },
    });
    const canLogin = !existingLoginForEmail;
    const placeholderHash = await hash(randomBytes(32).toString("hex"), 13);

    const storedXeroLink = buildXeroContactUrl(cachedContact.contactId);
    const member = await prisma.$transaction(async (tx) => {
      const created = await tx.member.create({
        data: {
        email,
        firstName,
        lastName,
        passwordHash: placeholderHash,
        ageTier: "ADULT",
        dateOfBirth: parseXeroContactDateOfBirth(cachedContact.companyNumber),
        xeroContactId: cachedContact.contactId,
        phoneCountryCode: cachedContact.phoneCountryCode,
        phoneAreaCode: cachedContact.phoneAreaCode,
        phoneNumber: cachedContact.phoneNumber,
        streetAddressLine1: cachedContact.streetAddressLine1,
        streetAddressLine2: cachedContact.streetAddressLine2,
        streetCity: cachedContact.streetCity,
        streetRegion: cachedContact.streetRegion,
        streetPostalCode: cachedContact.streetPostalCode,
        streetCountry: cachedContact.streetCountry,
        postalAddressLine1: cachedContact.postalAddressLine1,
        postalAddressLine2: cachedContact.postalAddressLine2,
        postalCity: cachedContact.postalCity,
        postalRegion: cachedContact.postalRegion,
        postalPostalCode: cachedContact.postalPostalCode,
        postalCountry: cachedContact.postalCountry,
        active: true,
        canLogin,
        emailVerified: !canLogin,
        inheritEmailFromId: existingLoginForEmail?.id ?? null,
        // #2716: pointer and CHOICE together. This is a HAND-PICKED shape, not a
        // derived one — the source is whoever already holds this address as a
        // login, and no parent link is involved — so one hop has nothing to
        // constrain here; what the choice buys is that the pointer restores
        // itself if that login holder's address is removed and put back.
        inheritEmailChoiceId: existingLoginForEmail?.id ?? null,
      },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          active: true,
          xeroContactId: true,
        },
      });
      await ensureMemberAccessRolesFromCompatibilityFields(tx, {
        memberId: created.id,
        role: "USER",
        canLogin,
        assignedByMemberId: session.user.id,
      });
      await upsertXeroObjectLink(
        {
          localModel: "Member",
          localId: created.id,
          xeroObjectType: "CONTACT",
          xeroObjectId: cachedContact.contactId,
          xeroObjectUrl: storedXeroLink,
          role: "CONTACT",
          metadata: {
            contactName: cachedContact.name ?? `${firstName} ${lastName}`,
            importedFromXeroContactSearch: true,
          },
        },
        { store: tx },
      );
      return created;
    });
    importedMemberId = member.id;
    importedXeroContactId = member.xeroContactId;
    contactLinked = Boolean(member.xeroContactId);
    subscriptionRefreshPending = true;
    // #2314: two links, deliberately different. The STORED one is
    // organisation-agnostic — a short code baked into a XeroObjectLink row is
    // wrong the moment the club reconnects to a different Xero organisation, so
    // the short code is applied when the row is rendered instead. The one
    // RETURNED to the admin who just imported is scoped now, so their click
    // lands in this club's books.
    const xeroLink = buildXeroContactUrl(cachedContact.contactId, {
      shortCode: await getXeroOrgShortCode(),
    });
    contactLinked = true;

    let warning: string | undefined;
    try {
      const subscriptionSync = await syncMemberSubscriptionHistoryForLinkedContact(member.id, {
        forceRefreshOnlineInvoiceUrl: true,
      });
      subscriptionRefreshPending = subscriptionSync.errors.length > 0;
      if (subscriptionSync.errors.length > 0) {
        warning =
          "Member imported, but subscription history refresh did not complete for every season. Run the Member Status Repair Backfill to retry.";
        logger.warn(
          {
            memberId: member.id,
            xeroContactId: cachedContact.contactId,
            errors: subscriptionSync.errors,
          },
          "Subscription history refresh completed with errors after Xero contact import"
        );
      }
    } catch (historyError) {
      if (isHostingCoverageParticipantRetry(historyError)) throw historyError;
      warning =
        "Member imported, but subscription history refresh did not complete. Run the Member Status Repair Backfill to retry.";
      subscriptionRefreshPending = true;
      logger.warn(
        { err: historyError, memberId: member.id, xeroContactId: cachedContact.contactId },
        "Failed to refresh member subscription history after Xero contact import"
      );
    }

    await logAudit({
      action: "XERO_IMPORT_MEMBER_CONTACT",
      memberId: session.user.id,
      targetId: member.id,
      subjectMemberId: member.id,
      entityType: "Member",
      entityId: member.id,
      category: "xero",
      outcome: "success",
      summary: "Member imported from Xero contact",
      details: `Imported Xero contact ${cachedContact.contactId} as ${member.firstName} ${member.lastName}`,
      metadata: {
        xeroContactId: cachedContact.contactId,
        contactName: cachedContact.name ?? null,
      },
    });

    return NextResponse.json(
      {
        ok: true,
        message: `Imported ${member.firstName} ${member.lastName} from Xero and linked the contact.`,
        memberId: member.id,
        memberFirstName: member.firstName,
        memberLastName: member.lastName,
        memberName: `${member.firstName} ${member.lastName}`,
        memberEmail: member.email,
        active: member.active,
        xeroContactId: member.xeroContactId,
        xeroLink,
        canLogin,
        ...(warning ? { warning } : {}),
      },
      { status: 201 }
    );
  } catch (err) {
    const recovery =
      importedMemberId && importedXeroContactId && contactLinked
        ? importedMemberRecovery(
            importedMemberId,
            importedXeroContactId,
            subscriptionRefreshPending,
          )
        : null;
    const hostingRetry = hostingCoverageParticipantRetryResponse(
      err,
      recovery ? { ...recovery } : undefined,
    );
    if (hostingRetry) return hostingRetry;
    if (recovery) {
      logger.error(
        {
          err,
          memberId: importedMemberId,
          recoveryKind: recovery.recoveryKind,
        },
        "Xero contact import completed only in part",
      );
      return NextResponse.json(xeroPartialSuccessBody(recovery), {
        status: 409,
      });
    }
    const xeroError = getXeroApiErrorInfo(err, "Failed to import Xero contact as member");
    if (!xeroError.handled) {
      logger.error(
        { err, xeroContactId, xeroDiagnosticMessage: xeroError.diagnosticMessage },
        "Error importing Xero contact as member"
      );
    }
    return NextResponse.json({ error: xeroError.clientMessage }, { status: xeroError.status });
  }
}
