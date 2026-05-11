import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  callXeroApi,
  flushMemberSubscriptionHistory,
  getAuthenticatedXeroClient,
  refreshXeroContactCachesFromContact,
  syncMemberSubscriptionHistoryForLinkedContact,
} from "@/lib/xero";
import { logAudit } from "@/lib/audit";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import logger from "@/lib/logger";
import { z } from "zod";
import { buildXeroContactUrl } from "@/lib/xero-links";
import { upsertXeroObjectLink } from "@/lib/xero-sync";
import { getSeasonYear } from "@/lib/utils";

const linkSchema = z.object({
  xeroContactId: z.string().min(1),
});

/**
 * POST /api/admin/members/[id]/xero-link
 * Link a member to an existing Xero contact.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;

  const member = await prisma.member.findUnique({
    where: { id },
    select: { id: true, firstName: true, lastName: true, xeroContactId: true },
  });
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = linkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "xeroContactId is required" }, { status: 400 });
  }

  try {
    // Verify the Xero contact exists
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const contactRes = await callXeroApi(
      () => xero.accountingApi.getContact(tenantId, parsed.data.xeroContactId),
      {
        operation: "getContact",
        resourceType: "CONTACT",
        workflow: "adminLinkMemberToXeroContact",
        context: `verifyContact(${parsed.data.xeroContactId})`,
      }
    );
    const contact = contactRes.body.contacts?.[0];
    if (!contact) {
      return NextResponse.json({ error: "Xero contact not found" }, { status: 404 });
    }

    // Check if contact is already linked to another member
    const existingLink = await prisma.member.findFirst({
      where: { xeroContactId: parsed.data.xeroContactId, id: { not: id } },
      select: { firstName: true, lastName: true },
    });
    if (existingLink) {
      return NextResponse.json(
        { error: `This Xero contact is already linked to ${existingLink.firstName} ${existingLink.lastName}` },
        { status: 409 }
      );
    }

    await refreshXeroContactCachesFromContact(contact);

    await prisma.member.update({
      where: { id },
      data: { xeroContactId: parsed.data.xeroContactId },
    });
    await upsertXeroObjectLink({
      localModel: "Member",
      localId: id,
      xeroObjectType: "CONTACT",
      xeroObjectId: parsed.data.xeroContactId,
      xeroObjectUrl: buildXeroContactUrl(parsed.data.xeroContactId),
      role: "CONTACT",
      metadata: {
        contactName: contact.name ?? null,
        linkedManually: true,
      },
    });

    const flushedSubscriptionHistory = await flushMemberSubscriptionHistory(id);
    let warning: string | undefined;
    try {
      const seasonYearsToRefresh =
        flushedSubscriptionHistory.seasonYears.length > 0
          ? [
              getSeasonYear(new Date()),
              ...flushedSubscriptionHistory.seasonYears,
            ]
          : undefined;
      const subscriptionSync =
        await syncMemberSubscriptionHistoryForLinkedContact(id, {
          seasonYears: seasonYearsToRefresh,
          forceRefreshOnlineInvoiceUrl: true,
        });

      if (subscriptionSync.errors.length > 0) {
        warning =
          "Member linked, but subscription history refresh did not complete for every season. Run the Member Status Repair Backfill to retry.";
        logger.warn(
          {
            memberId: id,
            xeroContactId: parsed.data.xeroContactId,
            seasonYears: subscriptionSync.seasonYears,
            errors: subscriptionSync.errors,
          },
          "Subscription history refresh completed with errors after member relink"
        );
      }
    } catch (historyError) {
      warning =
        "Member linked, but subscription history refresh did not complete. Run the Member Status Repair Backfill to retry.";
      logger.warn(
        {
          err: historyError,
          memberId: id,
          xeroContactId: parsed.data.xeroContactId,
          flushedSubscriptionHistory,
        },
        "Failed to refresh member subscription history after relink"
      );
    }

    await logAudit({
      action: "XERO_LINK",
      memberId: session.user.id,
      targetId: id,
      subjectMemberId: id,
      entityType: "Member",
      entityId: id,
      category: "xero",
      outcome: "success",
      summary: "Member linked to Xero contact",
      details: `Linked to Xero contact ${parsed.data.xeroContactId} (${contact.name})`,
      metadata: {
        xeroContactId: parsed.data.xeroContactId,
        contactName: contact.name ?? null,
        flushedSubscriptionHistoryCount:
          flushedSubscriptionHistory.deletedCount,
      },
    });

    logger.info({ memberId: id, xeroContactId: parsed.data.xeroContactId }, "Manually linked member to Xero contact");

    return NextResponse.json({
      xeroContactId: parsed.data.xeroContactId,
      contactName: contact.name,
      xeroLink: buildXeroContactUrl(parsed.data.xeroContactId),
      ...(warning ? { warning } : {}),
    });
  } catch (err) {
    const xeroError = getXeroApiErrorInfo(err, "Failed to link to Xero contact");
    if (!xeroError.handled) {
      logger.error({ err, memberId: id }, "Error linking member to Xero contact");
    }
    return NextResponse.json({ error: xeroError.message }, { status: xeroError.status });
  }
}
