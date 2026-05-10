import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { z } from "zod";

const xeroContactSearchQuerySchema = z.object({
  q: z.string().trim().min(2),
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
    firstName,
    lastName,
  };
}

function getNameKey(firstName: string | null | undefined, lastName: string | null | undefined) {
  return `${firstName?.trim() ?? ""}\u0000${lastName?.trim() ?? ""}`.toLowerCase();
}

/**
 * GET /api/admin/xero/search-contacts?q=searchterm
 * Search Xero contacts by name or email.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const parsed = xeroContactSearchQuerySchema.safeParse({
    q: request.nextUrl.searchParams.get("q"),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { q } = parsed.data;

  try {
    const { xero, tenantId } = await getAuthenticatedXeroClient();

    const response = await callXeroApi(
      () =>
        xero.accountingApi.getContacts(
          tenantId,
          undefined, // ifModifiedSince
          undefined, // where
          undefined, // order
          undefined, // iDs
          1, // page
          false, // includeArchived
          true, // summaryOnly
          q.replace(/"/g, ""),
          20 // pageSize
        ),
      {
        operation: "getContacts",
        resourceType: "CONTACT",
        workflow: "adminSearchXeroContacts",
        context: `searchContacts(${q})`,
      }
    );

    const contacts = response.body.contacts ?? [];

    // Check which contacts are already linked to members
    const contactIds = contacts.map((c) => c.contactID).filter(Boolean) as string[];
    const linkedMembers = contactIds.length > 0
      ? await prisma.member.findMany({
          where: { xeroContactId: { in: contactIds } },
          select: { id: true, xeroContactId: true, firstName: true, lastName: true },
        })
      : [];
    const linkedMap = new Map(
      linkedMembers.map((m) => [
        m.xeroContactId,
        { id: m.id, name: `${m.firstName} ${m.lastName}` },
      ])
    );

    const namePairs = contacts
      .map((contact) => getContactNameParts(contact))
      .filter(({ firstName, lastName }) => firstName && lastName);
    const uniqueNamePairs = Array.from(
      new Map(
        namePairs.map((pair) => [getNameKey(pair.firstName, pair.lastName), pair])
      ).values()
    );
    const existingMembersByName = uniqueNamePairs.length > 0
      ? await prisma.member.findMany({
          where: {
            OR: uniqueNamePairs.map((pair) => ({
              firstName: { equals: pair.firstName, mode: "insensitive" },
              lastName: { equals: pair.lastName, mode: "insensitive" },
            })),
          },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const existingNameMap = new Map(
      existingMembersByName.map((member) => [
        getNameKey(member.firstName, member.lastName),
        { id: member.id, name: `${member.firstName} ${member.lastName}` },
      ])
    );

    const results = contacts.slice(0, 20).map((c) => {
      const contactId = c.contactID ?? "";
      const nameParts = getContactNameParts(c);
      const name = c.name || [c.firstName, c.lastName].filter(Boolean).join(" ");
      const linkedMember = linkedMap.get(contactId) ?? null;
      const existingMember = nameParts.firstName && nameParts.lastName
        ? existingNameMap.get(getNameKey(nameParts.firstName, nameParts.lastName)) ?? null
        : null;
      const importBlockReason = !contactId
        ? "Xero contact has no contact ID"
        : linkedMember
          ? `Already linked to ${linkedMember.name}`
          : existingMember
            ? `A TACBookings member named ${existingMember.name} already exists`
            : c.emailAddress
              ? null
              : "Xero contact has no email address";

      return {
        contactId,
        name,
        firstName: nameParts.firstName || null,
        lastName: nameParts.lastName || null,
        email: c.emailAddress || null,
        isLinked: Boolean(linkedMember),
        linkedMemberId: linkedMember?.id ?? null,
        linkedMemberName: linkedMember?.name ?? null,
        existingMemberId: existingMember?.id ?? null,
        existingMemberName: existingMember?.name ?? null,
        canImportAsMember: importBlockReason === null,
        importBlockReason,
      };
    });

    return NextResponse.json({ contacts: results });
  } catch (err) {
    const xeroError = getXeroApiErrorInfo(err, "Failed to search Xero contacts");
    if (!xeroError.handled) {
      logger.error({ err }, "Error searching Xero contacts");
    }
    return NextResponse.json({ error: xeroError.message }, { status: xeroError.status });
  }
}
