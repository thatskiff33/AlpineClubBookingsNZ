/**
 * Unarchive a member (#5540, INV-LIFE-013).
 *
 * The one reverse edge of the archive: a Full Admin clears it in one step,
 * giving a reason. Only the archive is undone. The member stays cancelled,
 * inactive and unable to sign in; `cancelledAt` and `leavingDate` are left as
 * they are, and the family links the archive removed are not restored. No
 * email is sent and no Xero call is made: archive approval never touches Xero
 * (the contact is archived at cancellation approval, if at all).
 *
 * History survives the clear. The ARCHIVE request row stays as the record of
 * the archive, and this writes an APPROVED UNARCHIVE row (the admin as both
 * requester and reviewer) and an audit row, so every cycle stays on the page.
 *
 * Locking (INV-LOCK-001..003): the per-member lifecycle key archive and delete
 * approval already take, through the canonical helper, then a re-read and a
 * guarded claim on `archivedAt`. No new key or order.
 */
import {
  MemberLifecycleAction,
  MemberLifecycleActionRequestStatus,
} from "@prisma/client";
import { actorIsFullAdmin } from "@/lib/admin-account-guards";
import { createAuditLog } from "@/lib/audit";
import { isDeletedAccountRecord } from "@/lib/deleted-account";
import {
  buildMemberSnapshot,
  lifecycleActionRequestInclude,
  MemberLifecycleActionError,
  requireCleanText,
  serializeMemberLifecycleActionRequest,
} from "@/lib/member-lifecycle-actions";
import { acquireMemberLifecycleLocks } from "@/lib/member-lifecycle-lock";
import { prisma } from "@/lib/prisma";

export const UNARCHIVE_FULL_ADMIN_ONLY_MESSAGE =
  "Only a Full Admin can unarchive a member.";

type UnarchiveMemberInput = {
  memberId: string;
  actorMemberId: string;
  reason: string;
  ipAddress?: string | null;
};

export async function unarchiveMember({
  memberId,
  actorMemberId,
  reason,
  ipAddress,
}: UnarchiveMemberInput) {
  const cleanedReason = requireCleanText(reason, "Unarchive reason is required.");

  const request = await prisma.$transaction(async (tx) => {
    if (!(await actorIsFullAdmin(tx, actorMemberId))) {
      throw new MemberLifecycleActionError(UNARCHIVE_FULL_ADMIN_ONLY_MESSAGE, 403);
    }

    await acquireMemberLifecycleLocks(tx, [memberId]);

    // Re-read after the lock: an archive approval may have committed while we waited.
    const member = await tx.member.findUnique({
      where: { id: memberId },
      select: {
        email: true,
        deletedAt: true,
        archivedAt: true,
        archivedReason: true,
        archivedViaLifecycleActionRequestId: true,
      },
    });
    if (!member) {
      throw new MemberLifecycleActionError("Member not found.", 404);
    }
    // INV-LIFE-015: an erased account is never brought back, archived or not.
    if (isDeletedAccountRecord(member)) {
      throw new MemberLifecycleActionError(
        "A deleted member cannot be unarchived.",
        409,
      );
    }
    if (!member.archivedAt) {
      throw new MemberLifecycleActionError("This member is not archived.", 409);
    }
    // A pending archive or delete request is decided first: unarchiving under
    // it would let a stale archive request re-archive the member, or a delete
    // run on a record whose state changed after it was asked for.
    const pending = await tx.memberLifecycleActionRequest.findFirst({
      where: { memberId, status: MemberLifecycleActionRequestStatus.REQUESTED },
      select: { action: true },
    });
    if (pending) {
      throw new MemberLifecycleActionError(
        `This member has a pending ${pending.action.toLowerCase()} request. Approve or reject it first.`,
        409,
      );
    }

    // Captured before the clear, so the row records the archive it undid.
    const snapshot = await buildMemberSnapshot(memberId, tx);

    // The claim is the first write. Losing it means another writer changed
    // the archive under us; the throw rolls back, so nothing else is written.
    const claim = await tx.member.updateMany({
      where: { id: memberId, archivedAt: { not: null } },
      data: {
        archivedAt: null,
        archivedReason: null,
        archivedViaLifecycleActionRequestId: null,
      },
    });
    if (claim.count !== 1) {
      throw new MemberLifecycleActionError("This member is not archived.", 409);
    }

    const now = new Date();
    const created = await tx.memberLifecycleActionRequest.create({
      data: {
        memberId,
        action: MemberLifecycleAction.UNARCHIVE,
        status: MemberLifecycleActionRequestStatus.APPROVED,
        reason: cleanedReason,
        memberSnapshot: snapshot,
        requestedByMemberId: actorMemberId,
        requestedAt: now,
        reviewedByMemberId: actorMemberId,
        reviewedAt: now,
        processedAt: now,
      },
      include: lifecycleActionRequestInclude,
    });

    await createAuditLog(
      {
        action: "member_lifecycle.unarchived",
        memberId: actorMemberId,
        actorMemberId,
        subjectMemberId: memberId,
        targetId: created.id,
        entityType: "MemberLifecycleActionRequest",
        entityId: created.id,
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Member unarchived",
        details: cleanedReason,
        metadata: {
          action: MemberLifecycleAction.UNARCHIVE,
          archivedAt: member.archivedAt.toISOString(),
          archivedReason: member.archivedReason,
          archivedViaLifecycleActionRequestId:
            member.archivedViaLifecycleActionRequestId,
        },
        ipAddress,
      },
      tx,
    );

    return created;
  });

  return { request: serializeMemberLifecycleActionRequest(request) };
}
