import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { flushMemberSubscriptionHistory } from "@/lib/xero";
import { deactivateXeroObjectLinks } from "@/lib/xero-sync";

/**
 * POST /api/admin/members/[id]/xero-unlink
 * Unlink a member from their Xero contact (sets xeroContactId to null).
 */
export async function POST(
  _req: NextRequest,
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

  if (!member.xeroContactId) {
    return NextResponse.json({ error: "Member is not linked to a Xero contact" }, { status: 400 });
  }

  const previousXeroContactId = member.xeroContactId;

  try {
    await prisma.member.update({
      where: { id },
      data: { xeroContactId: null },
    });
    const flushedSubscriptionHistory = await flushMemberSubscriptionHistory(id);
    try {
      await deactivateXeroObjectLinks({
        localModel: "Member",
        localId: id,
        role: "CONTACT",
      });
    } catch (linkErr) {
      logger.warn({ err: linkErr, memberId: id }, "Failed to deactivate Xero object links during unlink");
    }

    await logAudit({
      action: "XERO_UNLINK",
      memberId: session.user.id,
      targetId: id,
      subjectMemberId: id,
      entityType: "Member",
      entityId: id,
      category: "xero",
      outcome: "success",
      summary: "Member unlinked from Xero contact",
      details: `Unlinked from Xero contact ${previousXeroContactId}`,
      metadata: {
        previousXeroContactId,
        clearedSubscriptionHistoryCount:
          flushedSubscriptionHistory.deletedCount,
      },
    });

    logger.info(
      {
        memberId: id,
        previousXeroContactId,
        deletedSubscriptionHistoryCount:
          flushedSubscriptionHistory.deletedCount,
      },
      "Unlinked member from Xero contact"
    );

    return NextResponse.json({
      success: true,
      clearedSubscriptionHistoryCount:
        flushedSubscriptionHistory.deletedCount,
    });
  } catch (err) {
    logger.error({ err, memberId: id }, "Error unlinking member from Xero contact");
    return NextResponse.json({ error: "Failed to unlink from Xero contact" }, { status: 500 });
  }
}
