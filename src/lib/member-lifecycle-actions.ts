import {
  MemberLifecycleAction,
  MemberLifecycleActionRequestStatus,
  Role,
  type Prisma,
} from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import {
  sendAdminMemberArchiveRequestedAlert,
  sendAdminMemberDeleteApprovedEmail,
  sendAdminMemberDeleteRejectedEmail,
  sendAdminMemberDeleteRequestedAlert,
  sendMemberArchiveApprovedEmail,
  sendMemberArchiveRejectedEmail,
} from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  cleanText,
  memberDisplayName,
  serializeDate,
  serializeMember,
} from "@/lib/member-serialization";

type LifecycleActionClient = Prisma.TransactionClient | typeof prisma;

const memberSummarySelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
} satisfies Prisma.MemberSelect;

const archiveTargetMemberSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  active: true,
  canLogin: true,
  cancelledAt: true,
  cancelledReason: true,
  archivedAt: true,
  archivedReason: true,
} satisfies Prisma.MemberSelect;

const lifecycleActionRequestInclude = {
  requestedBy: { select: memberSummarySelect },
  reviewedBy: { select: memberSummarySelect },
} satisfies Prisma.MemberLifecycleActionRequestInclude;

type LifecycleActionRequestRecord =
  Prisma.MemberLifecycleActionRequestGetPayload<{
    include: typeof lifecycleActionRequestInclude;
  }>;

export type MemberDeleteEligibilityBlocker = {
  code: string;
  label: string;
  count?: number;
};

export type MemberDeleteEligibility = {
  eligible: boolean;
  blockers: MemberDeleteEligibilityBlocker[];
  checkedAt: string;
};

type LifecycleReviewInput = {
  requestId: string;
  reviewedByMemberId: string;
  action: "approve" | "reject";
  reviewNote?: string | null;
  ipAddress?: string | null;
};

export type SerializedMemberLifecycleActionRequest = {
  id: string;
  memberId: string;
  action: string;
  status: string;
  reason: string;
  reviewNote: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  processedAt: string | null;
  requestedBy: { id: string; name: string; email: string } | null;
  reviewedBy: { id: string; name: string; email: string } | null;
  memberSnapshot: Prisma.JsonValue | null;
};

export class MemberLifecycleActionError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "MemberLifecycleActionError";
  }
}

function requireCleanText(value: string | null | undefined, message: string) {
  const cleaned = cleanText(value);
  if (!cleaned) {
    throw new MemberLifecycleActionError(message, 422);
  }
  return cleaned;
}

function jsonSnapshot(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function snapshotMember(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }
  const member = (snapshot as { member?: unknown }).member;
  if (!member || typeof member !== "object" || Array.isArray(member)) {
    return null;
  }
  return member as {
    firstName?: unknown;
    lastName?: unknown;
    email?: unknown;
  };
}

function memberNameFromSnapshot(snapshot: unknown, fallback: string) {
  const member = snapshotMember(snapshot);
  if (!member) return fallback;

  const firstName = typeof member.firstName === "string" ? member.firstName : "";
  const lastName = typeof member.lastName === "string" ? member.lastName : "";
  const email = typeof member.email === "string" ? member.email : "";
  return memberDisplayName({ firstName, lastName, email }) || fallback;
}

async function sendLifecycleEmailSafely(
  description: string,
  context: Record<string, unknown>,
  send: () => Promise<void>,
) {
  try {
    await send();
  } catch (err) {
    logger.error({ err, ...context }, description);
  }
}

export function serializeMemberLifecycleActionRequest(
  request: LifecycleActionRequestRecord,
): SerializedMemberLifecycleActionRequest {
  return {
    id: request.id,
    memberId: request.memberId,
    action: request.action,
    status: request.status,
    reason: request.reason,
    reviewNote: request.reviewNote,
    requestedAt: request.requestedAt.toISOString(),
    reviewedAt: serializeDate(request.reviewedAt),
    processedAt: serializeDate(request.processedAt),
    requestedBy: serializeMember(request.requestedBy),
    reviewedBy: serializeMember(request.reviewedBy),
    memberSnapshot: request.memberSnapshot,
  };
}

function pushCountBlocker(
  blockers: MemberDeleteEligibilityBlocker[],
  code: string,
  label: string,
  count: number,
) {
  if (count > 0) {
    blockers.push({ code, label, count });
  }
}

function pendingDeleteWhere(memberId: string, ignoreRequestId?: string) {
  return {
    memberId,
    action: MemberLifecycleAction.DELETE,
    status: MemberLifecycleActionRequestStatus.REQUESTED,
    ...(ignoreRequestId ? { id: { not: ignoreRequestId } } : {}),
  } satisfies Prisma.MemberLifecycleActionRequestWhereInput;
}

export async function getMemberDeleteEligibility({
  memberId,
  currentAdminMemberId,
  ignoreRequestId,
  db = prisma,
}: {
  memberId: string;
  currentAdminMemberId?: string | null;
  ignoreRequestId?: string;
  db?: LifecycleActionClient;
}): Promise<MemberDeleteEligibility> {
  const member = await db.member.findUnique({
    where: { id: memberId },
    select: {
      id: true,
      role: true,
      parentMemberId: true,
      secondaryParentId: true,
      inheritEmailFromId: true,
    },
  });

  if (!member) {
    throw new MemberLifecycleActionError("Member not found.", 404);
  }

  const [
    pendingDeleteRequests,
    ownedBookings,
    guestAppearances,
    payments,
    paymentRefunds,
    paymentRecoveryOperations,
    memberCredits,
    creditAdjustmentRequests,
    refundRequests,
    subscriptions,
    promoRedemptions,
    promoAssignments,
    nominationTokens,
    nominationApplications,
    membershipCancellationRequests,
    membershipCancellationParticipants,
    unresolvedFamilyRequests,
    familyGroupMemberships,
    dependants,
    emailInheritanceReferences,
    hutLeaderAssignments,
    issueReports,
    bookingModifications,
    accountDeletionRequests,
  ] = await Promise.all([
    db.memberLifecycleActionRequest.count({
      where: pendingDeleteWhere(memberId, ignoreRequestId),
    }),
    db.booking.count({ where: { memberId } }),
    db.bookingGuest.count({ where: { memberId } }),
    db.payment.count({ where: { booking: { memberId } } }),
    db.paymentRefund.count({
      where: { payment: { booking: { memberId } } },
    }),
    db.paymentRecoveryOperation.count({ where: { booking: { memberId } } }),
    db.memberCredit.count({
      where: {
        OR: [
          { memberId },
          { requestedById: memberId },
          { approvedById: memberId },
        ],
      },
    }),
    db.adminCreditAdjustmentRequest.count({
      where: {
        OR: [
          { memberId },
          { requestedById: memberId },
          { reviewedById: memberId },
        ],
      },
    }),
    db.refundRequest.count({
      where: { OR: [{ memberId }, { booking: { memberId } }] },
    }),
    db.memberSubscription.count({ where: { memberId } }),
    db.promoRedemption.count({ where: { memberId } }),
    db.promoCodeAssignment.count({ where: { memberId } }),
    db.nominationToken.count({ where: { nominatorMemberId: memberId } }),
    db.memberApplication.count({
      where: {
        OR: [
          { nominator1Id: memberId },
          { nominator2Id: memberId },
          { reviewedBy: memberId },
        ],
      },
    }),
    db.membershipCancellationRequest.count({
      where: {
        OR: [
          { requestedByMemberId: memberId },
          { reviewedByMemberId: memberId },
        ],
      },
    }),
    db.membershipCancellationRequestParticipant.count({
      where: {
        OR: [{ memberId }, { reviewedByMemberId: memberId }],
      },
    }),
    db.familyGroupJoinRequest.count({
      where: {
        status: "PENDING",
        OR: [
          { requesterId: memberId },
          { invitedMemberId: memberId },
          { linkedMemberId: memberId },
          { subjectMemberId: memberId },
          { reviewedBy: memberId },
        ],
      },
    }),
    db.familyGroupMember.count({ where: { memberId } }),
    db.member.count({
      where: {
        OR: [{ parentMemberId: memberId }, { secondaryParentId: memberId }],
      },
    }),
    db.member.count({ where: { inheritEmailFromId: memberId } }),
    db.hutLeaderAssignment.count({ where: { memberId } }),
    db.issueReport.count({ where: { memberId } }),
    db.bookingModification.count({
      where: { OR: [{ memberId }, { booking: { memberId } }] },
    }),
    db.deletionRequest.count({ where: { memberId } }),
  ]);

  const blockers: MemberDeleteEligibilityBlocker[] = [];

  if (currentAdminMemberId && currentAdminMemberId === memberId) {
    blockers.push({
      code: "self_delete",
      label: "The current admin cannot request or approve deletion of their own member record.",
    });
  }

  if (member.role === Role.ADMIN) {
    blockers.push({
      code: "admin_account",
      label: "Admin accounts cannot be hard deleted.",
    });
  }

  if (member.parentMemberId || member.secondaryParentId) {
    blockers.push({
      code: "parent_link",
      label: "This member is still linked to a parent member.",
    });
  }

  if (member.inheritEmailFromId) {
    blockers.push({
      code: "email_inheritance",
      label: "This member inherits email from another member.",
    });
  }

  pushCountBlocker(
    blockers,
    "pending_delete_request",
    "A delete request is already pending for this member.",
    pendingDeleteRequests,
  );
  pushCountBlocker(blockers, "owned_bookings", "Owned bookings exist.", ownedBookings);
  pushCountBlocker(
    blockers,
    "guest_appearances",
    "Booking guest appearances exist.",
    guestAppearances,
  );
  pushCountBlocker(blockers, "payments", "Payments exist through owned bookings.", payments);
  pushCountBlocker(
    blockers,
    "payment_refunds",
    "Payment refunds exist through owned bookings.",
    paymentRefunds,
  );
  pushCountBlocker(
    blockers,
    "payment_recovery_operations",
    "Payment recovery operations exist through owned bookings.",
    paymentRecoveryOperations,
  );
  pushCountBlocker(blockers, "credits", "Member credit history exists.", memberCredits);
  pushCountBlocker(
    blockers,
    "credit_adjustment_requests",
    "Credit adjustment requests reference this member.",
    creditAdjustmentRequests,
  );
  pushCountBlocker(blockers, "refund_requests", "Refund requests exist.", refundRequests);
  pushCountBlocker(blockers, "subscriptions", "Membership subscriptions exist.", subscriptions);
  pushCountBlocker(blockers, "promo_redemptions", "Promo redemptions exist.", promoRedemptions);
  pushCountBlocker(blockers, "promo_assignments", "Promo assignments exist.", promoAssignments);
  pushCountBlocker(blockers, "nomination_tokens", "Nomination tokens reference this member.", nominationTokens);
  pushCountBlocker(
    blockers,
    "member_applications",
    "Member applications reference this member.",
    nominationApplications,
  );
  pushCountBlocker(
    blockers,
    "membership_cancellation_requests",
    "Membership cancellation requests reference this member.",
    membershipCancellationRequests + membershipCancellationParticipants,
  );
  pushCountBlocker(
    blockers,
    "unresolved_family_requests",
    "Unresolved family requests reference this member.",
    unresolvedFamilyRequests,
  );
  pushCountBlocker(
    blockers,
    "family_group_memberships",
    "Family group memberships reference this member.",
    familyGroupMemberships,
  );
  pushCountBlocker(blockers, "dependants", "Dependants are linked to this member.", dependants);
  pushCountBlocker(
    blockers,
    "email_inheritance_references",
    "Other members inherit email from this member.",
    emailInheritanceReferences,
  );
  pushCountBlocker(
    blockers,
    "hut_leader_assignments",
    "Hut leader assignments reference this member.",
    hutLeaderAssignments,
  );
  pushCountBlocker(blockers, "issue_reports", "Issue reports reference this member.", issueReports);
  pushCountBlocker(
    blockers,
    "booking_modifications",
    "Booking modification history references this member.",
    bookingModifications,
  );
  pushCountBlocker(
    blockers,
    "account_deletion_requests",
    "Self-service account deletion requests reference this member.",
    accountDeletionRequests,
  );

  return {
    eligible: blockers.length === 0,
    blockers,
    checkedAt: new Date().toISOString(),
  };
}

async function buildMemberSnapshot(
  memberId: string,
  db: LifecycleActionClient,
  eligibility: MemberDeleteEligibility,
) {
  const [member, xeroObjectLinks] = await Promise.all([
    db.member.findUnique({ where: { id: memberId } }),
    db.xeroObjectLink.findMany({
      where: { localModel: "Member", localId: memberId },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  if (!member) {
    throw new MemberLifecycleActionError("Member not found.", 404);
  }

  return jsonSnapshot({
    capturedAt: new Date().toISOString(),
    member,
    xeroObjectLinks,
    deleteEligibility: eligibility,
  });
}

export async function getMemberDeleteLifecycleRequests(memberId: string) {
  const requests = await prisma.memberLifecycleActionRequest.findMany({
    where: {
      memberId,
      action: MemberLifecycleAction.DELETE,
    },
    include: lifecycleActionRequestInclude,
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    take: 10,
  });

  return requests.map(serializeMemberLifecycleActionRequest);
}

export async function getMemberArchiveLifecycleRequests(memberId: string) {
  const requests = await prisma.memberLifecycleActionRequest.findMany({
    where: {
      memberId,
      action: MemberLifecycleAction.ARCHIVE,
    },
    include: lifecycleActionRequestInclude,
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    take: 10,
  });

  return requests.map(serializeMemberLifecycleActionRequest);
}

function assertEligibleForDelete(eligibility: MemberDeleteEligibility) {
  if (!eligibility.eligible) {
    throw new MemberLifecycleActionError(
      "This member cannot be deleted while blockers exist.",
      409,
      { blockers: eligibility.blockers },
    );
  }
}

async function loadDeleteRequestById(
  requestId: string,
  db: LifecycleActionClient = prisma,
) {
  const request = await db.memberLifecycleActionRequest.findUnique({
    where: { id: requestId },
    include: lifecycleActionRequestInclude,
  });

  if (!request || request.action !== MemberLifecycleAction.DELETE) {
    throw new MemberLifecycleActionError("Delete request not found.", 404);
  }

  return request;
}

async function loadArchiveRequestById(
  requestId: string,
  db: LifecycleActionClient = prisma,
) {
  const request = await db.memberLifecycleActionRequest.findUnique({
    where: { id: requestId },
    include: lifecycleActionRequestInclude,
  });

  if (!request || request.action !== MemberLifecycleAction.ARCHIVE) {
    throw new MemberLifecycleActionError("Archive request not found.", 404);
  }

  return request;
}

function assertArchiveEligible(member: {
  cancelledAt: Date | null;
  archivedAt: Date | null;
}) {
  if (member.archivedAt) {
    throw new MemberLifecycleActionError(
      "This member has already been archived.",
      409,
    );
  }

  if (!member.cancelledAt) {
    throw new MemberLifecycleActionError(
      "Only cancelled members can be archived.",
      409,
    );
  }
}

type ArchivedMemberLinkCleanupCounts = {
  cleanedFamilyGroupMembers: number;
  nulledChildren: number;
  nulledSecondaryParents: number;
  nulledInheritance: number;
};

async function cleanupArchivedMemberLinks(
  tx: Prisma.TransactionClient,
  memberId: string,
): Promise<ArchivedMemberLinkCleanupCounts> {
  const familyGroupMembers = await tx.familyGroupMember.deleteMany({
    where: { memberId },
  });
  const children = await tx.member.updateMany({
    where: { parentMemberId: memberId },
    data: { parentMemberId: null },
  });
  const secondaryParents = await tx.member.updateMany({
    where: { secondaryParentId: memberId },
    data: { secondaryParentId: null },
  });
  const inheritance = await tx.member.updateMany({
    where: { inheritEmailFromId: memberId },
    data: { inheritEmailFromId: null },
  });

  return {
    cleanedFamilyGroupMembers: familyGroupMembers.count,
    nulledChildren: children.count,
    nulledSecondaryParents: secondaryParents.count,
    nulledInheritance: inheritance.count,
  };
}

export async function createMemberDeleteRequest({
  memberId,
  requestedByMemberId,
  reason,
  ipAddress,
}: {
  memberId: string;
  requestedByMemberId: string;
  reason: string;
  ipAddress?: string | null;
}) {
  const cleanedReason = requireCleanText(reason, "Delete reason is required.");
  const eligibility = await getMemberDeleteEligibility({
    memberId,
    currentAdminMemberId: requestedByMemberId,
  });
  assertEligibleForDelete(eligibility);

  const snapshot = await buildMemberSnapshot(memberId, prisma, eligibility);
  const targetMemberName = memberNameFromSnapshot(snapshot, memberId);

  const request = await prisma.$transaction(async (tx) => {
    const created = await tx.memberLifecycleActionRequest.create({
      data: {
        memberId,
        action: MemberLifecycleAction.DELETE,
        reason: cleanedReason,
        requestedByMemberId,
        memberSnapshot: snapshot,
      },
      include: lifecycleActionRequestInclude,
    });

    await createAuditLog(
      {
        action: "member_lifecycle.delete_requested",
        memberId: requestedByMemberId,
        actorMemberId: requestedByMemberId,
        subjectMemberId: memberId,
        targetId: created.id,
        entityType: "MemberLifecycleActionRequest",
        entityId: created.id,
        category: "admin",
        severity: "critical",
        outcome: "success",
        summary: "Member delete requested",
        details: cleanedReason,
        metadata: { action: MemberLifecycleAction.DELETE },
        ipAddress,
      },
      tx,
    );

    return created;
  });

  const requesterName = request.requestedBy
    ? memberDisplayName(request.requestedBy)
    : "Unknown admin";
  await sendLifecycleEmailSafely(
    "Failed to send member delete request admin alert",
    { memberId, requestId: request.id },
    () =>
      sendAdminMemberDeleteRequestedAlert({
        requesterName,
        memberId,
        memberName: targetMemberName,
        reason: cleanedReason,
      }),
  );

  return { request: serializeMemberLifecycleActionRequest(request) };
}

export async function createMemberArchiveRequest({
  memberId,
  requestedByMemberId,
  reason,
  ipAddress,
}: {
  memberId: string;
  requestedByMemberId: string;
  reason: string;
  ipAddress?: string | null;
}) {
  const cleanedReason = requireCleanText(reason, "Archive reason is required.");

  const [member, existingPendingRequest] = await Promise.all([
    prisma.member.findUnique({
      where: { id: memberId },
      select: archiveTargetMemberSelect,
    }),
    prisma.memberLifecycleActionRequest.findFirst({
      where: {
        memberId,
        action: MemberLifecycleAction.ARCHIVE,
        status: MemberLifecycleActionRequestStatus.REQUESTED,
      },
      select: { id: true },
    }),
  ]);

  if (!member) {
    throw new MemberLifecycleActionError("Member not found.", 404);
  }

  assertArchiveEligible(member);

  if (existingPendingRequest) {
    throw new MemberLifecycleActionError(
      "This member already has a pending archive request.",
      409,
    );
  }

  const request = await prisma.$transaction(async (tx) => {
    const created = await tx.memberLifecycleActionRequest.create({
      data: {
        memberId,
        action: MemberLifecycleAction.ARCHIVE,
        reason: cleanedReason,
        requestedByMemberId,
      },
      include: lifecycleActionRequestInclude,
    });

    await createAuditLog(
      {
        action: "member_lifecycle.archive_requested",
        memberId: requestedByMemberId,
        actorMemberId: requestedByMemberId,
        subjectMemberId: memberId,
        targetId: created.id,
        entityType: "MemberLifecycleActionRequest",
        entityId: created.id,
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Member archive requested",
        details: cleanedReason,
        metadata: { action: MemberLifecycleAction.ARCHIVE },
        ipAddress,
      },
      tx,
    );

    return created;
  });

  const requesterName = request.requestedBy
    ? memberDisplayName(request.requestedBy)
    : "Unknown admin";
  await sendLifecycleEmailSafely(
    "Failed to send member archive request admin alert",
    { memberId, requestId: request.id },
    () =>
      sendAdminMemberArchiveRequestedAlert({
        requesterName,
        memberId,
        memberName: memberDisplayName(member),
        reason: cleanedReason,
      }),
  );

  return { request: serializeMemberLifecycleActionRequest(request) };
}

export async function reviewMemberDeleteRequest({
  requestId,
  reviewedByMemberId,
  action,
  reviewNote,
  ipAddress,
}: LifecycleReviewInput) {
  const note = cleanText(reviewNote);
  const request = await loadDeleteRequestById(requestId);

  if (request.status !== MemberLifecycleActionRequestStatus.REQUESTED) {
    throw new MemberLifecycleActionError(
      "This delete request has already been reviewed.",
      409,
    );
  }

  if (request.requestedByMemberId === reviewedByMemberId) {
    throw new MemberLifecycleActionError(
      "Delete requests must be approved or rejected by a different admin.",
      403,
    );
  }

  const targetMemberName = memberNameFromSnapshot(
    request.memberSnapshot,
    request.memberId,
  );
  const deleteRequester = request.requestedBy;

  if (action === "reject") {
    const rejected = await prisma.$transaction(async (tx) => {
      const reviewed = await tx.memberLifecycleActionRequest.update({
        where: { id: request.id },
        data: {
          status: MemberLifecycleActionRequestStatus.REJECTED,
          reviewNote: note,
          reviewedByMemberId,
          reviewedAt: new Date(),
        },
        include: lifecycleActionRequestInclude,
      });

      await createAuditLog(
        {
          action: "member_lifecycle.delete_rejected",
          memberId: reviewedByMemberId,
          actorMemberId: reviewedByMemberId,
          subjectMemberId: request.memberId,
          targetId: request.id,
          entityType: "MemberLifecycleActionRequest",
          entityId: request.id,
          category: "admin",
          severity: "important",
          outcome: "success",
          summary: "Member delete rejected",
          details: note,
          metadata: {
            action: MemberLifecycleAction.DELETE,
            requestReason: request.reason,
          },
          ipAddress,
        },
        tx,
      );

      return reviewed;
    });

    if (deleteRequester) {
      await sendLifecycleEmailSafely(
        "Failed to send member delete rejection email",
        { requestId: request.id, memberId: request.memberId },
        () =>
          sendAdminMemberDeleteRejectedEmail({
            email: deleteRequester.email,
            requesterName: memberDisplayName(deleteRequester),
            memberId: request.memberId,
            memberName: targetMemberName,
            reason: request.reason,
            reviewNote: note,
          }),
      );
    }

    return { request: serializeMemberLifecycleActionRequest(rejected) };
  }

  const approved = await prisma.$transaction(async (tx) => {
    const eligibility = await getMemberDeleteEligibility({
      memberId: request.memberId,
      currentAdminMemberId: reviewedByMemberId,
      ignoreRequestId: request.id,
      db: tx,
    });
    assertEligibleForDelete(eligibility);

    const snapshot = await buildMemberSnapshot(request.memberId, tx, eligibility);
    const now = new Date();

    await tx.xeroObjectLink.updateMany({
      where: {
        localModel: "Member",
        localId: request.memberId,
        active: true,
      },
      data: { active: false },
    });

    await tx.member.update({
      where: { id: request.memberId },
      data: { xeroContactId: null },
    });

    const reviewed = await tx.memberLifecycleActionRequest.update({
      where: { id: request.id },
      data: {
        status: MemberLifecycleActionRequestStatus.APPROVED,
        reviewNote: note,
        reviewedByMemberId,
        reviewedAt: now,
        processedAt: now,
        memberSnapshot: snapshot,
      },
      include: lifecycleActionRequestInclude,
    });

    await tx.member.delete({ where: { id: request.memberId } });

    await createAuditLog(
      {
        action: "member_lifecycle.delete_approved",
        memberId: reviewedByMemberId,
        actorMemberId: reviewedByMemberId,
        subjectMemberId: request.memberId,
        targetId: request.id,
        entityType: "MemberLifecycleActionRequest",
        entityId: request.id,
        category: "admin",
        severity: "critical",
        outcome: "success",
        summary: "Member hard delete approved",
        details: note,
        metadata: {
          action: MemberLifecycleAction.DELETE,
          requestReason: request.reason,
          snapshotStored: true,
        },
        ipAddress,
      },
      tx,
    );

    return reviewed;
  });

  if (deleteRequester) {
    await sendLifecycleEmailSafely(
      "Failed to send member delete approval email",
      { requestId: request.id, memberId: request.memberId },
      () =>
        sendAdminMemberDeleteApprovedEmail({
          email: deleteRequester.email,
          requesterName: memberDisplayName(deleteRequester),
          memberName: targetMemberName,
          reason: request.reason,
          reviewNote: note,
        }),
    );
  }

  return { request: serializeMemberLifecycleActionRequest(approved) };
}

export async function reviewMemberArchiveRequest({
  requestId,
  reviewedByMemberId,
  action,
  reviewNote,
  ipAddress,
}: LifecycleReviewInput) {
  const note = cleanText(reviewNote);
  const request = await loadArchiveRequestById(requestId);

  if (request.status !== MemberLifecycleActionRequestStatus.REQUESTED) {
    throw new MemberLifecycleActionError(
      "This archive request has already been reviewed.",
      409,
    );
  }

  if (request.requestedByMemberId === reviewedByMemberId) {
    throw new MemberLifecycleActionError(
      "Archive requests must be approved or rejected by a different admin.",
      403,
    );
  }

  const targetMember = await prisma.member.findUnique({
    where: { id: request.memberId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  });

  if (action === "reject") {
    const rejected = await prisma.$transaction(async (tx) => {
      const reviewed = await tx.memberLifecycleActionRequest.update({
        where: { id: request.id },
        data: {
          status: MemberLifecycleActionRequestStatus.REJECTED,
          reviewNote: note,
          reviewedByMemberId,
          reviewedAt: new Date(),
        },
        include: lifecycleActionRequestInclude,
      });

      await createAuditLog(
        {
          action: "member_lifecycle.archive_rejected",
          memberId: reviewedByMemberId,
          actorMemberId: reviewedByMemberId,
          subjectMemberId: request.memberId,
          targetId: request.id,
          entityType: "MemberLifecycleActionRequest",
          entityId: request.id,
          category: "admin",
          severity: "important",
          outcome: "success",
          summary: "Member archive rejected",
          details: note,
          metadata: {
            action: MemberLifecycleAction.ARCHIVE,
            requestReason: request.reason,
          },
          ipAddress,
        },
        tx,
      );

      return reviewed;
    });

    if (targetMember) {
      await sendLifecycleEmailSafely(
        "Failed to send member archive rejection email",
        { requestId: request.id, memberId: request.memberId },
        () =>
          sendMemberArchiveRejectedEmail({
            email: targetMember.email,
            firstName: targetMember.firstName,
            reason: request.reason,
            reviewNote: note,
          }),
      );
    }

    return { request: serializeMemberLifecycleActionRequest(rejected) };
  }

  const approved = await prisma.$transaction(async (tx) => {
    const member = await tx.member.findUnique({
      where: { id: request.memberId },
      select: archiveTargetMemberSelect,
    });

    if (!member) {
      throw new MemberLifecycleActionError("Member not found.", 404);
    }

    assertArchiveEligible(member);

    const now = new Date();

    const linkCleanupCounts = await cleanupArchivedMemberLinks(
      tx,
      request.memberId,
    );

    await tx.member.update({
      where: { id: request.memberId },
      data: {
        archivedAt: now,
        archivedReason: request.reason,
        archivedViaLifecycleActionRequestId: request.id,
        active: false,
        canLogin: false,
      },
    });

    const reviewed = await tx.memberLifecycleActionRequest.update({
      where: { id: request.id },
      data: {
        status: MemberLifecycleActionRequestStatus.APPROVED,
        reviewNote: note,
        reviewedByMemberId,
        reviewedAt: now,
        processedAt: now,
      },
      include: lifecycleActionRequestInclude,
    });

    await createAuditLog(
      {
        action: "member_lifecycle.archive_approved",
        memberId: reviewedByMemberId,
        actorMemberId: reviewedByMemberId,
        subjectMemberId: request.memberId,
        targetId: request.id,
        entityType: "MemberLifecycleActionRequest",
        entityId: request.id,
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Member archive approved",
        details: note,
        metadata: {
          action: MemberLifecycleAction.ARCHIVE,
          requestReason: request.reason,
          ...linkCleanupCounts,
        },
        ipAddress,
      },
      tx,
    );

    return reviewed;
  });

  if (targetMember) {
    await sendLifecycleEmailSafely(
      "Failed to send member archive approval email",
      { requestId: request.id, memberId: request.memberId },
      () =>
        sendMemberArchiveApprovedEmail({
          email: targetMember.email,
          firstName: targetMember.firstName,
          reason: request.reason,
          reviewNote: note,
        }),
    );
  }

  return { request: serializeMemberLifecycleActionRequest(approved) };
}

export async function reviewMemberLifecycleActionRequest(
  input: LifecycleReviewInput,
) {
  const request = await prisma.memberLifecycleActionRequest.findUnique({
    where: { id: input.requestId },
    select: { action: true },
  });

  if (!request) {
    throw new MemberLifecycleActionError(
      "Lifecycle action request not found.",
      404,
    );
  }

  if (request.action === MemberLifecycleAction.DELETE) {
    return reviewMemberDeleteRequest(input);
  }

  if (request.action === MemberLifecycleAction.ARCHIVE) {
    return reviewMemberArchiveRequest(input);
  }

  throw new MemberLifecycleActionError(
    "Unsupported lifecycle action request.",
    400,
  );
}
