import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAuthenticatedXeroClient, withXeroRetry } from "@/lib/xero";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";

/**
 * GET /api/admin/xero/search-contacts?q=searchterm
 * Search Xero contacts by name or email.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const q = request.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 2) {
    return NextResponse.json({ error: "Search query must be at least 2 characters" }, { status: 400 });
  }

  try {
    const { xero, tenantId } = await getAuthenticatedXeroClient();

    const response = await withXeroRetry(
      () => xero.accountingApi.getContacts(
        tenantId,
        undefined, // ifModifiedSince
        `Name.Contains("${q.replace(/"/g, "")}") || EmailAddress.Contains("${q.replace(/"/g, "")}")`,
        undefined, // order
        undefined, // iDs
        1, // page
        false // includeArchived
      ),
      { context: `searchContacts(${q})` }
    );

    const contacts = response.body.contacts ?? [];

    // Check which contacts are already linked to members
    const contactIds = contacts.map((c) => c.contactID).filter(Boolean) as string[];
    const linkedMembers = contactIds.length > 0
      ? await prisma.member.findMany({
          where: { xeroContactId: { in: contactIds } },
          select: { xeroContactId: true, firstName: true, lastName: true },
        })
      : [];
    const linkedMap = new Map(linkedMembers.map((m) => [m.xeroContactId, `${m.firstName} ${m.lastName}`]));

    const results = contacts.slice(0, 20).map((c) => ({
      contactId: c.contactID,
      name: c.name || [c.firstName, c.lastName].filter(Boolean).join(" "),
      email: c.emailAddress || null,
      isLinked: linkedMap.has(c.contactID ?? ""),
      linkedMemberName: linkedMap.get(c.contactID ?? "") ?? null,
    }));

    return NextResponse.json({ contacts: results });
  } catch (err) {
    logger.error({ err }, "Error searching Xero contacts");
    return NextResponse.json({ error: "Failed to search Xero contacts" }, { status: 500 });
  }
}
