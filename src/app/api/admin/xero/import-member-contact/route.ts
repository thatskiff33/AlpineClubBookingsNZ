import { randomBytes } from "crypto";
import { hash } from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { buildXeroContactUrl } from "@/lib/xero-links";
import { upsertXeroObjectLink } from "@/lib/xero-sync";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
  refreshXeroContactCachesFromContact,
  syncMemberSubscriptionHistoryForLinkedContact,
} from "@/lib/xero";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";

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

function parseXeroCompanyNumberDate(companyNumber?: string | null): Date | null {
  if (!companyNumber) {
    return null;
  }

  const match = companyNumber.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) {
    return null;
  }

  const [, dd, mm, yyyy] = match;
  const parsed = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * POST /api/admin/xero/import-member-contact
 * Import one unlinked Xero contact as a TACBookings member.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

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
          error: `A TACBookings member named ${existingNameMatch.firstName} ${existingNameMatch.lastName} already exists.`,
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

    const member = await prisma.member.create({
      data: {
        email,
        firstName,
        lastName,
        passwordHash: placeholderHash,
        ageTier: "ADULT",
        dateOfBirth: parseXeroCompanyNumberDate(cachedContact.companyNumber),
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

    const xeroLink = buildXeroContactUrl(cachedContact.contactId);
    await upsertXeroObjectLink({
      localModel: "Member",
      localId: member.id,
      xeroObjectType: "CONTACT",
      xeroObjectId: cachedContact.contactId,
      xeroObjectUrl: xeroLink,
      role: "CONTACT",
      metadata: {
        contactName: cachedContact.name ?? `${firstName} ${lastName}`,
        importedFromXeroContactSearch: true,
      },
    });

    let warning: string | undefined;
    try {
      const subscriptionSync = await syncMemberSubscriptionHistoryForLinkedContact(member.id, {
        forceRefreshOnlineInvoiceUrl: true,
      });
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
      warning =
        "Member imported, but subscription history refresh did not complete. Run the Member Status Repair Backfill to retry.";
      logger.warn(
        { err: historyError, memberId: member.id, xeroContactId: cachedContact.contactId },
        "Failed to refresh member subscription history after Xero contact import"
      );
    }

    await logAudit({
      action: "XERO_IMPORT_MEMBER_CONTACT",
      memberId: session.user.id,
      targetId: member.id,
      details: `Imported Xero contact ${cachedContact.contactId} as ${member.firstName} ${member.lastName}`,
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
    const xeroError = getXeroApiErrorInfo(err, "Failed to import Xero contact as member");
    if (!xeroError.handled) {
      logger.error({ err, xeroContactId }, "Error importing Xero contact as member");
    }
    return NextResponse.json({ error: xeroError.message }, { status: xeroError.status });
  }
}
