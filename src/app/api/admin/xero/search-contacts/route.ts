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
    const xeroError = getXeroApiErrorInfo(err, "Failed to search Xero contacts");
    if (!xeroError.handled) {
      logger.error({ err }, "Error searching Xero contacts");
    }
    return NextResponse.json({ error: xeroError.message }, { status: xeroError.status });
  }
}
