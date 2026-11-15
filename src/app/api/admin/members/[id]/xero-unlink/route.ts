import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { flushMemberSubscriptionHistory } from "@/lib/xero-membership-sync";
import { deactivateXeroObjectLinks } from "@/lib/xero-sync";
import {
  unlinkedContactRecovery,
  xeroPartialSuccessBody,
} from "@/lib/xero-partial-success";

/**
 * POST /api/admin/members/[id]/xero-unlink
 * Unlink a member from their Xero contact (sets xeroContactId to null).
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
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
  let memberUnlinkCommitted = false;
  let subscriptionRefreshPending = false;
  // #2623 T3: the recovery body already said the unlink "completed only in
  // part", but not WHICH parts survived. These track the two the operator has to
  // go and check for themselves — the CONTACT ledger rows and the audit entry —
  // so the disclosure names exactly what is still outstanding rather than
  // leaving them to infer it.
  let contactLinkRowsPending = false;
  let unlinkAuditEntryPending = false;

  try {
    await prisma.member.update({
      where: { id },
      data: { xeroContactId: null },
    });
    memberUnlinkCommitted = true;
    subscriptionRefreshPending = true;
    contactLinkRowsPending = true;
    unlinkAuditEntryPending = true;
    const flushedSubscriptionHistory = await flushMemberSubscriptionHistory(id);
    subscriptionRefreshPending = false;
    await deactivateXeroObjectLinks({
      localModel: "Member",
      localId: id,
      role: "CONTACT",
    });
    contactLinkRowsPending = false;

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
    unlinkAuditEntryPending = false;

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
    const recovery = memberUnlinkCommitted
      ? unlinkedContactRecovery({
          subscriptionCleanupPending: subscriptionRefreshPending,
          contactLinkRowsPending,
          auditEntryPending: unlinkAuditEntryPending,
        })
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
          memberId: id,
          recoveryKind: recovery.recoveryKind,
          contactLinkRowsPending,
          unlinkAuditEntryPending,
        },
        "Xero contact unlink completed only in part",
      );
      return NextResponse.json(xeroPartialSuccessBody(recovery), {
        status: 409,
      });
    }
    logger.error({ err, memberId: id }, "Error unlinking member from Xero contact");
    return NextResponse.json({ error: "Failed to unlink from Xero contact" }, { status: 500 });
  }
}
