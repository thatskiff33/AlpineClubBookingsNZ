import {
  MembershipCancellationParticipantStatus,
  MembershipCancellationRequestStatus,
  type Prisma,
} from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking-status";
import { getTodayDateOnly } from "@/lib/date-only";
import {
  sendMembershipCancellationApprovedEmail,
  sendMembershipCancellationRejectedEmail,
} from "@/lib/email";
import logger from "@/lib/logger";
import { loadMembershipCancellationSettings } from "@/lib/membership-cancellation-settings";
import {
  cleanText,
  memberName,
  serializeDate,
  serializeMember,
} from "@/lib/member-serialization";
import { prisma } from "@/lib/prisma";
import { queueApprovedMembershipCancellationXeroOperations } from "@/lib/xero-operation-outbox";

const REVIEWABLE_REQUEST_STATUSES: readonly MembershipCancellationRequestStatus[] = [
  MembershipCancellationRequestStatus.REQUESTED,
] as const;

const REVIEWABLE_REJECTION_STATUSES: readonly MembershipCancellationParticipantStatus[] = [
  MembershipCancellationParticipantStatus.REQUESTED,
  MembershipCancellationParticipantStatus.PENDING_CONFIRMATION,
] as const;

type CancellationReviewClient = Prisma.TransactionClient | typeof prisma;

type AdminCancellationRequestRecord =
  Prisma.MembershipCancellationRequestGetPayload<{
    include: {
      requestedBy: { select: typeof memberSummarySelect };
      reviewedBy: { select: typeof memberSummarySelect };
      participants: {
        include: {
          reviewedBy: { select: typeof memberSummarySelect };
          member: {
            select: typeof cancellationParticipantMemberSelect;
          };
        };
      };
    };
  }>;

export type AdminCancellationStatusFilter =
  | MembershipCancellationRequestStatus
  | "ALL";

export type MembershipCancellationBlocker = {
  type: "owned_booking" | "guest_appearance";
  bookingId: string;
  bookingStatus: string;
  checkIn: string;
  checkOut: string;
  guestAppearanceId?: string;
};

export type AdminSerializedMembershipCancellationParticipant = {
  id: string;
  memberId: string;
  name: string;
  email: string;
  ageTier: string;
  active: boolean;
  canLogin: boolean;
  cancelledAt: string | null;
  status: string;
  reason: string | null;
  adminNote: string | null;
  confirmationTokenExpiresAt: string | null;
  confirmedAt: string | null;
  declinedAt: string | null;
  reviewedAt: string | null;
  cancelledAtParticipant: string | null;
  reviewedBy: { id: string; name: string; email: string } | null;
  blockers: MembershipCancellationBlocker[];
};

export type AdminSerializedMembershipCancellationRequest = {
  id: string;
  status: string;
  reason: string | null;
  adminNote: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  completedAt: string | null;
  requestedBy: { id: string; name: string; email: string } | null;
  reviewedBy: { id: string; name: string; email: string } | null;
  participants: AdminSerializedMembershipCancellationParticipant[];
};

export class MembershipCancellationAdminError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MembershipCancellationAdminError";
  }
}

const memberSummarySelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
} satisfies Prisma.MemberSelect;

const cancellationParticipantMemberSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  ageTier: true,
  active: true,
  canLogin: true,
  cancelledAt: true,
  cancelledReason: true,
  cancelledViaRequestId: true,
} satisfies Prisma.MemberSelect;

const adminCancellationRequestInclude = {
  requestedBy: { select: memberSummarySelect },
  reviewedBy: { select: memberSummarySelect },
  participants: {
    include: {
      reviewedBy: { select: memberSummarySelect },
      member: { select: cancellationParticipantMemberSelect },
    },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.MembershipCancellationRequestInclude;

function emptyBlockerMap(memberIds: string[]) {
  return new Map(
    memberIds.map((memberId) => [
      memberId,
      [] as MembershipCancellationBlocker[],
    ]),
  );
}

async function loadBlockersByMemberId(
  memberIds: string[],
  db: CancellationReviewClient = prisma,
) {
  const uniqueMemberIds = [...new Set(memberIds)].filter(Boolean);
  const blockersByMemberId = emptyBlockerMap(uniqueMemberIds);
  if (uniqueMemberIds.length === 0) return blockersByMemberId;

  const today = getTodayDateOnly();
  const [ownedBookings, guestAppearances] = await Promise.all([
    db.booking.findMany({
      where: {
        memberId: { in: uniqueMemberIds },
        status: { in: [...ACTIVE_BOOKING_STATUSES] },
        checkOut: { gt: today },
      },
      select: {
        id: true,
        memberId: true,
        checkIn: true,
        checkOut: true,
        status: true,
      },
      orderBy: [{ checkIn: "asc" }, { id: "asc" }],
    }),
    db.bookingGuest.findMany({
      where: {
        memberId: { in: uniqueMemberIds },
        stayEnd: { gt: today },
        booking: {
          status: { in: [...ACTIVE_BOOKING_STATUSES] },
        },
      },
      select: {
        id: true,
        memberId: true,
        stayStart: true,
        stayEnd: true,
        booking: {
          select: {
            id: true,
            status: true,
            checkIn: true,
            checkOut: true,
          },
        },
      },
      orderBy: [{ stayStart: "asc" }, { id: "asc" }],
    }),
  ]);

  for (const booking of ownedBookings) {
    blockersByMemberId.get(booking.memberId)?.push({
      type: "owned_booking",
      bookingId: booking.id,
      bookingStatus: booking.status,
      checkIn: booking.checkIn.toISOString(),
      checkOut: booking.checkOut.toISOString(),
    });
  }

  for (const guest of guestAppearances) {
    if (!guest.memberId) continue;
    blockersByMemberId.get(guest.memberId)?.push({
      type: "guest_appearance",
      bookingId: guest.booking.id,
      bookingStatus: guest.booking.status,
      checkIn: guest.stayStart.toISOString(),
      checkOut: guest.stayEnd.toISOString(),
      guestAppearanceId: guest.id,
    });
  }

  return blockersByMemberId;
}

function serializeRequest(
  request: AdminCancellationRequestRecord,
  blockersByMemberId = emptyBlockerMap(
    request.participants.map((participant) => participant.memberId),
  ),
): AdminSerializedMembershipCancellationRequest {
  return {
    id: request.id,
    status: request.status,
    reason: request.reason,
    adminNote: request.adminNote,
    submittedAt: request.submittedAt.toISOString(),
    reviewedAt: serializeDate(request.reviewedAt),
    completedAt: serializeDate(request.completedAt),
    requestedBy: serializeMember(request.requestedBy),
    reviewedBy: serializeMember(request.reviewedBy),
    participants: request.participants.map((participant) => ({
      id: participant.id,
      memberId: participant.memberId,
      name: memberName(participant.member),
      email: participant.member.email,
      ageTier: participant.member.ageTier,
      active: participant.member.active,
      canLogin: participant.member.canLogin,
      cancelledAt: serializeDate(participant.member.cancelledAt),
      status: participant.status,
      reason: participant.reason,
      adminNote: participant.adminNote,
      confirmationTokenExpiresAt: serializeDate(
        participant.confirmationTokenExpiresAt,
      ),
      confirmedAt: serializeDate(participant.confirmedAt),
      declinedAt: serializeDate(participant.declinedAt),
      reviewedAt: serializeDate(participant.reviewedAt),
      cancelledAtParticipant: serializeDate(participant.cancelledAt),
      reviewedBy: serializeMember(participant.reviewedBy),
      blockers: blockersByMemberId.get(participant.memberId) ?? [],
    })),
  };
}

function deriveRequestStatus(
  participants: Array<{ status: MembershipCancellationParticipantStatus }>,
) {
  if (
    participants.some((participant) =>
      REVIEWABLE_REJECTION_STATUSES.includes(participant.status),
    )
  ) {
    return MembershipCancellationRequestStatus.REQUESTED;
  }

  if (
    participants.some(
      (participant) =>
        participant.status ===
        MembershipCancellationParticipantStatus.CANCELLED,
    )
  ) {
    return MembershipCancellationRequestStatus.COMPLETED;
  }

  if (participants.length > 0) {
    return MembershipCancellationRequestStatus.REJECTED;
  }

  return MembershipCancellationRequestStatus.REQUESTED;
}

async function getAdminRequestById(requestId: string) {
  return prisma.membershipCancellationRequest.findUnique({
    where: { id: requestId },
    include: adminCancellationRequestInclude,
  });
}

async function updateRequestLifecycle(
  tx: Prisma.TransactionClient,
  requestId: string,
  adminMemberId: string,
  now: Date,
  adminNote: string | null,
) {
  const participants =
    await tx.membershipCancellationRequestParticipant.findMany({
      where: { requestId },
      select: { status: true },
    });
  const nextStatus = deriveRequestStatus(participants);

  await tx.membershipCancellationRequest.update({
    where: { id: requestId },
    data: {
      status: nextStatus,
      ...(nextStatus !== MembershipCancellationRequestStatus.REQUESTED
        ? {
            reviewedByMemberId: adminMemberId,
            reviewedAt: now,
            completedAt:
              nextStatus === MembershipCancellationRequestStatus.COMPLETED
                ? now
                : null,
            adminNote,
          }
        : {}),
    },
  });

  return nextStatus;
}

function assertRequestCanBeReviewed(
  request: { status: MembershipCancellationRequestStatus },
) {
  if (!REVIEWABLE_REQUEST_STATUSES.includes(request.status)) {
    throw new MembershipCancellationAdminError(
      "This cancellation request has already been reviewed.",
      409,
    );
  }
}

function assertParticipantCanBeApproved(participant: {
  status: MembershipCancellationParticipantStatus;
  confirmedAt: Date | null;
  member: { active: boolean; cancelledAt: Date | null };
}) {
  if (participant.status !== MembershipCancellationParticipantStatus.REQUESTED) {
    throw new MembershipCancellationAdminError(
      "Only confirmed cancellation participants can be approved.",
      409,
    );
  }

  if (!participant.confirmedAt) {
    throw new MembershipCancellationAdminError(
      "This participant has not confirmed their cancellation request.",
      409,
    );
  }

  if (!participant.member.active || participant.member.cancelledAt) {
    throw new MembershipCancellationAdminError(
      "This membership is already inactive or cancelled.",
      409,
    );
  }
}

function assertParticipantCanBeRejected(participant: {
  status: MembershipCancellationParticipantStatus;
}) {
  if (!REVIEWABLE_REJECTION_STATUSES.includes(participant.status)) {
    throw new MembershipCancellationAdminError(
      "This participant has already been reviewed.",
      409,
    );
  }
}

async function loadParticipantForReview(
  requestId: string,
  participantId: string,
) {
  const participant =
    await prisma.membershipCancellationRequestParticipant.findUnique({
      where: { id: participantId },
      include: {
        member: { select: cancellationParticipantMemberSelect },
        request: {
          select: {
            id: true,
            status: true,
            reason: true,
            requestedByMemberId: true,
          },
        },
      },
    });

  if (!participant || participant.requestId !== requestId) {
    throw new MembershipCancellationAdminError(
      "Cancellation participant not found.",
      404,
    );
  }

  return participant;
}

async function sendCancellationOutcomeEmail(params: {
  action: "approve" | "reject";
  member: {
    email: string;
    firstName: string;
    lastName: string;
  };
  requestReason: string | null;
  adminNote: string | null;
}) {
  try {
    if (params.action === "approve") {
      const settings = await loadMembershipCancellationSettings();
      await sendMembershipCancellationApprovedEmail({
        email: params.member.email,
        firstName: params.member.firstName,
        participantName: memberName(params.member),
        reason: params.requestReason,
        adminNote: params.adminNote,
        rejoinProcessText: settings.rejoinProcessText,
      });
      return;
    }

    await sendMembershipCancellationRejectedEmail({
      email: params.member.email,
      firstName: params.member.firstName,
      participantName: memberName(params.member),
      reason: params.requestReason,
      adminNote: params.adminNote,
    });
  } catch (err) {
    logger.error(
      { err, email: params.member.email },
      "Failed to send membership cancellation outcome email",
    );
  }
}

export async function getPendingMembershipCancellationReviewCount() {
  return prisma.membershipCancellationRequest.count({
    where: {
      status: MembershipCancellationRequestStatus.REQUESTED,
      participants: {
        some: {
          status: MembershipCancellationParticipantStatus.REQUESTED,
          confirmedAt: { not: null },
        },
      },
    },
  });
}

export async function getAdminMembershipCancellationRequests({
  status = MembershipCancellationRequestStatus.REQUESTED,
  page = 1,
  pageSize = 25,
}: {
  status?: AdminCancellationStatusFilter;
  page?: number;
  pageSize?: number;
}) {
  const where =
    status === "ALL"
      ? {}
      : {
          status,
        };

  const [requests, total, pendingCount] = await Promise.all([
    prisma.membershipCancellationRequest.findMany({
      where,
      include: adminCancellationRequestInclude,
      orderBy: { submittedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.membershipCancellationRequest.count({ where }),
    getPendingMembershipCancellationReviewCount(),
  ]);

  const participantMemberIds = requests.flatMap((request) =>
    request.participants
      .filter(
        (participant) =>
          participant.status ===
          MembershipCancellationParticipantStatus.REQUESTED,
      )
      .map((participant) => participant.memberId),
  );
  const blockersByMemberId = await loadBlockersByMemberId(participantMemberIds);

  return {
    requests: requests.map((request) =>
      serializeRequest(request, blockersByMemberId),
    ),
    pendingCount,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

export async function reviewMembershipCancellationParticipant({
  requestId,
  participantId,
  action,
  adminMemberId,
  adminNote,
  ipAddress,
}: {
  requestId: string;
  participantId: string;
  action: "approve" | "reject";
  adminMemberId: string;
  adminNote?: string | null;
  ipAddress?: string | null;
}) {
  const note = cleanText(adminNote);
  const participant = await loadParticipantForReview(requestId, participantId);
  assertRequestCanBeReviewed(participant.request);

  if (action === "approve") {
    assertParticipantCanBeApproved(participant);
    const blockersByMemberId = await loadBlockersByMemberId([
      participant.memberId,
    ]);
    const blockers = blockersByMemberId.get(participant.memberId) ?? [];
    if (blockers.length > 0) {
      await createAuditLog({
        action: "membership_cancellation.approval_blocked",
        memberId: adminMemberId,
        actorMemberId: adminMemberId,
        subjectMemberId: participant.memberId,
        targetId: participant.requestId,
        entityType: "MembershipCancellationRequest",
        entityId: participant.requestId,
        category: "account",
        severity: "important",
        outcome: "blocked",
        summary: "Membership cancellation approval blocked",
        details:
          "Future owned bookings or member guest appearances must be resolved before cancellation.",
        metadata: { blockers },
        ipAddress,
      });

      throw new MembershipCancellationAdminError(
        "Approval is blocked while this member has future bookings or guest appearances.",
        409,
        { blockers },
      );
    }
  } else {
    assertParticipantCanBeRejected(participant);
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    if (action === "approve") {
      await tx.member.update({
        where: { id: participant.memberId },
        data: {
          active: false,
          canLogin: false,
          cancelledAt: now,
          cancelledReason: participant.request.reason,
          cancelledViaRequestId: participant.requestId,
          familyGroupId: null,
          parentMemberId: null,
          secondaryParentId: null,
          inheritEmailFromId: null,
        },
      });

      await Promise.all([
        tx.familyGroupMember.deleteMany({
          where: { memberId: participant.memberId },
        }),
        tx.member.updateMany({
          where: { parentMemberId: participant.memberId },
          data: { parentMemberId: null },
        }),
        tx.member.updateMany({
          where: { secondaryParentId: participant.memberId },
          data: { secondaryParentId: null },
        }),
        tx.member.updateMany({
          where: { inheritEmailFromId: participant.memberId },
          data: { inheritEmailFromId: null },
        }),
      ]);

      await tx.membershipCancellationRequestParticipant.update({
        where: { id: participant.id },
        data: {
          status: MembershipCancellationParticipantStatus.CANCELLED,
          adminNote: note,
          reviewedByMemberId: adminMemberId,
          reviewedAt: now,
          cancelledAt: now,
          confirmationTokenHash: null,
          confirmationTokenExpiresAt: null,
        },
      });

      await createAuditLog(
        {
          action: "membership_cancellation.participant_cancelled",
          memberId: adminMemberId,
          actorMemberId: adminMemberId,
          subjectMemberId: participant.memberId,
          targetId: participant.requestId,
          entityType: "MembershipCancellationRequest",
          entityId: participant.requestId,
          category: "account",
          severity: "important",
          outcome: "success",
          summary: "Membership cancellation participant approved",
          details: note,
          metadata: {
            participantId: participant.id,
            xeroCancellationDeferred: true,
          },
          ipAddress,
        },
        tx,
      );
    } else {
      await tx.membershipCancellationRequestParticipant.update({
        where: { id: participant.id },
        data: {
          status: MembershipCancellationParticipantStatus.REJECTED,
          adminNote: note,
          reviewedByMemberId: adminMemberId,
          reviewedAt: now,
          confirmationTokenHash: null,
          confirmationTokenExpiresAt: null,
        },
      });

      await createAuditLog(
        {
          action: "membership_cancellation.participant_rejected",
          memberId: adminMemberId,
          actorMemberId: adminMemberId,
          subjectMemberId: participant.memberId,
          targetId: participant.requestId,
          entityType: "MembershipCancellationRequest",
          entityId: participant.requestId,
          category: "account",
          severity: "important",
          outcome: "success",
          summary: "Membership cancellation participant rejected",
          details: note,
          metadata: { participantId: participant.id },
          ipAddress,
        },
        tx,
      );
    }

    await updateRequestLifecycle(
      tx,
      participant.requestId,
      adminMemberId,
      now,
      note,
    );
  });

  if (action === "approve") {
    try {
      await queueApprovedMembershipCancellationXeroOperations({
        memberId: participant.memberId,
        requestId: participant.requestId,
        participantId: participant.id,
        createdByMemberId: adminMemberId,
      });
    } catch (err) {
      logger.error(
        { err, memberId: participant.memberId, requestId: participant.requestId },
        "Failed to queue Xero membership cancellation operations",
      );
    }
  }

  await sendCancellationOutcomeEmail({
    action,
    member: participant.member,
    requestReason: participant.request.reason,
    adminNote: note,
  });

  const updatedRequest = await getAdminRequestById(participant.requestId);
  if (!updatedRequest) {
    throw new MembershipCancellationAdminError(
      "Cancellation request could not be reloaded.",
      500,
    );
  }

  const blockersByMemberId = await loadBlockersByMemberId(
    updatedRequest.participants
      .filter(
        (item) =>
          item.status === MembershipCancellationParticipantStatus.REQUESTED,
      )
      .map((item) => item.memberId),
  );

  return {
    request: serializeRequest(updatedRequest, blockersByMemberId),
  };
}
