import {
  MemberLifecycleAction,
  MemberLifecycleActionRequestStatus,
  SubscriptionStatus,
  type Prisma,
} from "@prisma/client";
import { CLUB_HUT_LEADER_LABEL } from "@/config/club-identity";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { enqueueHostingCoverageReevaluationForMember } from "@/lib/adult-member-hosting-review";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { hasAdminAccess, memberHoldsPrivilegedRole } from "@/lib/access-roles";
import {
  actorIsFullAdmin,
  LAST_FULL_ADMIN_GUARD_MESSAGE,
  PRIVILEGED_TARGET_GUARD_MESSAGE,
  wouldRemoveLastFullAdmin,
} from "@/lib/admin-account-guards";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import { createAuditLog } from "@/lib/audit";
import { deleteOwnedMemberPhotoBlobs } from "@/lib/member-photo";
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
import { retireInheritedEmailCopies } from "@/lib/member-email-inheritance";
import {
  EMPTY_ORPHANED_FAMILY_LINKS,
  readFamilyLinkOrphans,
  type OrphanedFamilyLinks,
} from "@/lib/member-family-link-orphans";
import {
  cleanText,
  memberDisplayName,
  serializeDate,
  serializeMember,
} from "@/lib/member-serialization";
import { lockMemberForAccountDeletionXeroFence } from "@/lib/xero-contact-create-recovery";

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
  // Role fields feed the #1604 privileged-target guard: archive requires a
  // prior cancellation (which clears canLogin but not the stored role fields),
  // so this is evaluated canLogin-blind via memberHoldsPrivilegedRole.
  role: true,
  financeAccessLevel: true,
  accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
} satisfies Prisma.MemberSelect;

const lifecycleActionRequestInclude = {
  requestedBy: { select: memberSummarySelect },
  reviewedBy: { select: memberSummarySelect },
} satisfies Prisma.MemberLifecycleActionRequestInclude;

type LifecycleActionRequestRecord =
  Prisma.MemberLifecycleActionRequestGetPayload<{
    include: typeof lifecycleActionRequestInclude;
  }>;

type MemberDeleteEligibilityBlocker = {
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
  // #1788: admin per-review email choice. Absent/undefined = notify (default);
  // false = suppress the member-facing email. Only honoured by the ARCHIVE
  // review (which emails the target member); the DELETE review's admin-facing
  // emails always send regardless of this flag.
  notifyMember?: boolean;
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
  // Raw requester FK (nullable via onDelete: SetNull). Kept alongside the
  // resolved `requestedBy` object so the deletion-requests page can enforce the
  // second-admin separation-of-duties rule (#1938) even when the requester's
  // member record has since been deleted and `requestedBy` is null.
  requestedByMemberId: string | null;
  requestedBy: { id: string; name: string; email: string } | null;
  reviewedBy: { id: string; name: string; email: string } | null;
  memberSnapshot: Prisma.JsonValue | null;
};

export type AdminMemberLifecycleActionStatusFilter =
  | MemberLifecycleActionRequestStatus
  | "ALL";

export type SerializedAdminMemberArchiveLifecycleRequest =
  SerializedMemberLifecycleActionRequest & {
    member: {
      id: string;
      name: string;
      email: string;
      active: boolean;
      canLogin: boolean;
      cancelledAt: string | null;
      archivedAt: string | null;
      archivedReason: string | null;
    } | null;
    // Display name that stays populated even when the live member lookup
    // misses (e.g. an APPROVED DELETE whose target record is already gone):
    // it falls back to the captured `memberSnapshot`. #1938.
    targetName: string;
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

export function memberNameFromSnapshot(snapshot: unknown, fallback: string) {
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

function serializeMemberLifecycleActionRequest(
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
    requestedByMemberId: request.requestedByMemberId,
    requestedBy: serializeMember(request.requestedBy),
    reviewedBy: serializeMember(request.reviewedBy),
    memberSnapshot: request.memberSnapshot,
  };
}

function serializeArchiveTargetMember(
  member:
    | Prisma.MemberGetPayload<{ select: typeof archiveTargetMemberSelect }>
    | null
    | undefined,
) {
  if (!member) return null;

  return {
    id: member.id,
    name: memberDisplayName(member),
    email: member.email,
    active: member.active,
    canLogin: member.canLogin,
    cancelledAt: serializeDate(member.cancelledAt),
    archivedAt: serializeDate(member.archivedAt),
    archivedReason: member.archivedReason,
  };
}

function serializeAdminLifecycleRequest(
  request: LifecycleActionRequestRecord,
  member:
    | Prisma.MemberGetPayload<{ select: typeof archiveTargetMemberSelect }>
    | null
    | undefined,
): SerializedAdminMemberArchiveLifecycleRequest {
  return {
    ...serializeMemberLifecycleActionRequest(request),
    member: serializeArchiveTargetMember(member),
    targetName: member
      ? memberDisplayName(member)
      : memberNameFromSnapshot(request.memberSnapshot, request.memberId),
  };
}

function pendingDeleteWhere(memberId: string, ignoreRequestId?: string) {
  return {
    memberId,
    action: MemberLifecycleAction.DELETE,
    status: MemberLifecycleActionRequestStatus.REQUESTED,
    ...(ignoreRequestId ? { id: { not: ignoreRequestId } } : {}),
  } satisfies Prisma.MemberLifecycleActionRequestWhereInput;
}

type BlockerSpec = {
  code: string;
  label: string;
  query: (
    db: LifecycleActionClient,
    memberId: string,
    ignoreRequestId?: string,
  ) => Promise<number>;
};

function meaningfulMemberSubscriptionWhere(
  memberId: string,
): Prisma.MemberSubscriptionWhereInput {
  return {
    memberId,
    OR: [
      {
        status: {
          in: [
            SubscriptionStatus.UNPAID,
            SubscriptionStatus.PAID,
            SubscriptionStatus.OVERDUE,
          ],
        },
      },
      { xeroInvoiceId: { not: null } },
      { xeroInvoiceNumber: { not: null } },
      { xeroOnlineInvoiceUrl: { not: null } },
      { paidAt: { not: null } },
      // Even a zero-cent NO_INVOICE subscription is immutable charge coverage
      // and must block hard deletion rather than surfacing a late FK failure.
      // #2147: chargeCoverage is now a list — ANY coverage row (active or a
      // retained released one) is durable history that blocks deletion.
      { chargeCoverage: { some: {} } },
    ],
  };
}

const MEMBER_DELETE_BLOCKER_SPECS: readonly BlockerSpec[] = [
  {
    code: "pending_delete_request",
    label: "A delete request is already pending for this member.",
    query: (db, memberId, ignoreRequestId) =>
      db.memberLifecycleActionRequest.count({
        where: pendingDeleteWhere(memberId, ignoreRequestId),
      }),
  },
  {
    code: "owned_bookings",
    label: "Owned bookings exist.",
    query: (db, memberId) => db.booking.count({ where: { memberId } }),
  },
  {
    code: "guest_appearances",
    label: "Booking guest appearances exist.",
    query: (db, memberId) => db.bookingGuest.count({ where: { memberId } }),
  },
  {
    code: "payments",
    label: "Payments exist through owned bookings.",
    query: (db, memberId) =>
      db.payment.count({ where: { booking: { memberId } } }),
  },
  {
    code: "payment_refunds",
    label: "Payment refunds exist through owned bookings.",
    query: (db, memberId) =>
      db.paymentRefund.count({ where: { payment: { booking: { memberId } } } }),
  },
  {
    code: "payment_recovery_operations",
    label: "Payment recovery operations exist through owned bookings.",
    query: (db, memberId) =>
      db.paymentRecoveryOperation.count({ where: { booking: { memberId } } }),
  },
  {
    code: "credits",
    label: "Member credit history exists.",
    query: (db, memberId) =>
      db.memberCredit.count({
        where: {
          OR: [
            { memberId },
            { requestedById: memberId },
            { approvedById: memberId },
          ],
        },
      }),
  },
  {
    code: "credit_adjustment_requests",
    label: "Credit adjustment requests reference this member.",
    query: (db, memberId) =>
      db.adminCreditAdjustmentRequest.count({
        where: {
          OR: [
            { memberId },
            { requestedById: memberId },
            { reviewedById: memberId },
          ],
        },
      }),
  },
  {
    code: "refund_requests",
    label: "Refund requests exist.",
    query: (db, memberId) =>
      db.refundRequest.count({
        where: { OR: [{ memberId }, { booking: { memberId } }] },
      }),
  },
  {
    code: "subscriptions",
    label: "Membership subscriptions with invoice or payment history exist.",
    query: (db, memberId) =>
      db.memberSubscription.count({
        where: meaningfulMemberSubscriptionWhere(memberId),
      }),
  },
  {
    // MembershipSubscriptionCharge.recipientMemberId is a RESTRICT FK, so a
    // member who is only the billing recipient of a family charge (e.g. after
    // a group dissolves) would otherwise pass every blocker and then fail
    // member.delete with an unhandled P2003 (issue #1886).
    code: "subscription_charge_recipient",
    label:
      "Membership subscription charges name this member as invoice recipient.",
    query: (db, memberId) =>
      db.membershipSubscriptionCharge.count({
        where: { recipientMemberId: memberId },
      }),
  },
  {
    code: "promo_redemptions",
    label: "Promo redemptions exist.",
    query: (db, memberId) => {
      const allocationDelegate = (
        db as LifecycleActionClient & {
          promoRedemptionAllocation?: {
            count: (args: { where: { memberId: string } }) => Promise<number>;
          };
        }
      ).promoRedemptionAllocation;
      return allocationDelegate
        ? allocationDelegate.count({ where: { memberId } })
        : db.promoRedemption.count({ where: { memberId } });
    },
  },
  {
    code: "promo_assignments",
    label: "Promo assignments exist.",
    query: (db, memberId) =>
      db.promoCodeAssignment.count({ where: { memberId } }),
  },
  {
    code: "nomination_tokens",
    label: "Nomination tokens reference this member.",
    query: (db, memberId) =>
      db.nominationToken.count({ where: { nominatorMemberId: memberId } }),
  },
  {
    code: "member_applications",
    label: "Member applications reference this member.",
    query: (db, memberId) =>
      db.memberApplication.count({
        where: {
          OR: [
            { nominator1Id: memberId },
            { nominator2Id: memberId },
            { reviewedBy: memberId },
          ],
        },
      }),
  },
  {
    code: "membership_cancellation_requests",
    label: "Membership cancellation requests reference this member.",
    query: async (db, memberId) => {
      const [requests, participants] = await Promise.all([
        db.membershipCancellationRequest.count({
          where: {
            OR: [
              { requestedByMemberId: memberId },
              { reviewedByMemberId: memberId },
            ],
          },
        }),
        db.membershipCancellationRequestParticipant.count({
          where: { OR: [{ memberId }, { reviewedByMemberId: memberId }] },
        }),
      ]);
      return requests + participants;
    },
  },
  {
    code: "unresolved_family_requests",
    label: "Unresolved family requests reference this member.",
    query: (db, memberId) =>
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
  },
  {
    code: "family_group_memberships",
    label: "Family group memberships reference this member.",
    query: (db, memberId) =>
      db.familyGroupMember.count({ where: { memberId } }),
  },
  {
    code: "dependants",
    label: "Dependants are linked to this member.",
    query: (db, memberId) =>
      db.member.count({
        where: {
          OR: [{ parentMemberId: memberId }, { secondaryParentId: memberId }],
        },
      }),
  },
  {
    code: "email_inheritance_references",
    label: "Other members inherit email from this member.",
    query: (db, memberId) =>
      db.member.count({ where: { inheritEmailFromId: memberId } }),
  },
  {
    code: "hut_leader_assignments",
    label: `${CLUB_HUT_LEADER_LABEL.charAt(0).toUpperCase()}${CLUB_HUT_LEADER_LABEL.slice(1).toLowerCase()} assignments reference this member.`,
    query: (db, memberId) =>
      db.hutLeaderAssignment.count({ where: { memberId } }),
  },
  {
    code: "issue_reports",
    label: "Issue reports reference this member.",
    query: (db, memberId) => db.issueReport.count({ where: { memberId } }),
  },
  {
    code: "booking_modifications",
    label: "Booking modification history references this member.",
    query: (db, memberId) =>
      db.bookingModification.count({
        where: { OR: [{ memberId }, { booking: { memberId } }] },
      }),
  },
  {
    code: "booking_change_requests",
    label: "Pending booking change requests reference this member.",
    query: (db, memberId) =>
      db.bookingChangeRequest.count({
        where: { requestedByMemberId: memberId, status: "REQUESTED" },
      }),
  },
  {
    code: "account_deletion_requests",
    label: "Self-service account deletion requests reference this member.",
    query: (db, memberId) =>
      db.deletionRequest.count({ where: { memberId } }),
  },
];

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
      accessRoles: { select: { role: true } },
      parentMemberId: true,
      secondaryParentId: true,
      inheritEmailFromId: true,
    },
  });

  if (!member) {
    throw new MemberLifecycleActionError("Member not found.", 404);
  }

  const counts = await Promise.all(
    MEMBER_DELETE_BLOCKER_SPECS.map((spec) =>
      spec.query(db, memberId, ignoreRequestId),
    ),
  );

  const blockers: MemberDeleteEligibilityBlocker[] = [];

  if (currentAdminMemberId && currentAdminMemberId === memberId) {
    blockers.push({
      code: "self_delete",
      label:
        "The current admin cannot request or approve deletion of their own member record.",
    });
  }

  if (hasAdminAccess(member)) {
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

  MEMBER_DELETE_BLOCKER_SPECS.forEach((spec, index) => {
    const count = counts[index];
    if (count > 0) {
      blockers.push({ code: spec.code, label: spec.label, count });
    }
  });

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

function pendingReviewCountWhere(action: MemberLifecycleAction) {
  return {
    action,
    status: MemberLifecycleActionRequestStatus.REQUESTED,
  } satisfies Prisma.MemberLifecycleActionRequestWhereInput;
}

export async function getPendingMemberArchiveReviewCount() {
  return prisma.memberLifecycleActionRequest.count({
    where: pendingReviewCountWhere(MemberLifecycleAction.ARCHIVE),
  });
}

export async function getPendingMemberDeleteReviewCount() {
  return prisma.memberLifecycleActionRequest.count({
    where: pendingReviewCountWhere(MemberLifecycleAction.DELETE),
  });
}

/**
 * Admin review list for member lifecycle action requests, parameterised by
 * action (#1938). ARCHIVE feeds the membership-cancellations page; DELETE feeds
 * the new admin-initiated section on /admin/deletion-requests. The serializer
 * carries both the live `member` (null once an APPROVED DELETE has removed the
 * record) and a snapshot-safe `targetName`. `pendingCount` is always the
 * REQUESTED count for the same action, so the caller can badge it directly.
 */
export async function getAdminMemberLifecycleRequests({
  action = MemberLifecycleAction.ARCHIVE,
  status = MemberLifecycleActionRequestStatus.REQUESTED,
  page = 1,
  pageSize = 25,
}: {
  action?: MemberLifecycleAction;
  status?: AdminMemberLifecycleActionStatusFilter;
  page?: number;
  pageSize?: number;
}) {
  const where =
    status === "ALL"
      ? { action }
      : {
          action,
          status,
        };

  const [requests, total, pendingCount] = await Promise.all([
    prisma.memberLifecycleActionRequest.findMany({
      where,
      include: lifecycleActionRequestInclude,
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.memberLifecycleActionRequest.count({ where }),
    prisma.memberLifecycleActionRequest.count({
      where: pendingReviewCountWhere(action),
    }),
  ]);

  const memberIds = [...new Set(requests.map((request) => request.memberId))];
  const members =
    memberIds.length > 0
      ? await prisma.member.findMany({
          where: { id: { in: memberIds } },
          select: archiveTargetMemberSelect,
        })
      : [];
  const membersById = new Map(members.map((member) => [member.id, member]));

  return {
    requests: requests.map((request) =>
      serializeAdminLifecycleRequest(
        request,
        membersById.get(request.memberId),
      ),
    ),
    pendingCount,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

/**
 * Back-compat wrapper: the membership-cancellations page and its tests call the
 * ARCHIVE list by this name. New callers should use
 * getAdminMemberLifecycleRequests with an explicit action.
 */
export async function getAdminMemberArchiveLifecycleRequests({
  status = MemberLifecycleActionRequestStatus.REQUESTED,
  page = 1,
  pageSize = 25,
}: {
  status?: AdminMemberLifecycleActionStatusFilter;
  page?: number;
  pageSize?: number;
}) {
  return getAdminMemberLifecycleRequests({
    action: MemberLifecycleAction.ARCHIVE,
    status,
    page,
    pageSize,
  });
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
  /** #2716: stale copies of this member's address stamped undeliverable. */
  retiredInheritedEmailCopies: number;
  /** #2255: the same detached members the cancellation flow declares. */
  orphanedLinks: OrphanedFamilyLinks;
};

async function cleanupArchivedMemberLinks(
  tx: Prisma.TransactionClient,
  memberId: string,
): Promise<ArchivedMemberLinkCleanupCounts> {
  // #2255: read who this sweep is about to detach BEFORE nulling the columns —
  // afterwards there is no record of the links at all. Archive runs the
  // identical sweep to cancellation approval, and at four generations its blast
  // radius reaches grandchildren the same way, so it gets the same declaration
  // rather than only a row count in the audit metadata.
  const orphanedLinks = await readFamilyLinkOrphans(tx, memberId);

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
  // #2716: retire the denormalised COPIES of this member's address BEFORE the
  // pointers are cleared, because the pointers are what identify whose address
  // it is. Clearing them alone left the copy behind, and every reader falls
  // through to it — so the archived member kept receiving their dependants'
  // mail, and those dependants looked perfectly reachable.
  const departing = await tx.member.findUnique({
    where: { id: memberId },
    select: { email: true },
  });
  const retiredCopies = departing
    ? await retireInheritedEmailCopies(tx, {
        id: memberId,
        email: departing.email,
      })
    : { retired: 0 };
  // #2716: the CHOICE goes with the pointer here. Nothing in the product clears
  // `archivedAt` — the archive state machine has no reverse edge — so a choice
  // naming an archived member can never resolve again, and keeping it would
  // report these dependants as waiting on an address that is never coming.
  const inheritance = await tx.member.updateMany({
    where: {
      OR: [
        { inheritEmailFromId: memberId },
        { inheritEmailChoiceId: memberId },
      ],
    },
    data: { inheritEmailFromId: null, inheritEmailChoiceId: null },
  });
  // Billing-family removal sweep (#1932, E6): the archived member is leaving all
  // families in this transaction, so clear any billing-family selection they hold.
  await tx.member.updateMany({
    where: { id: memberId, billingFamilyGroupId: { not: null } },
    data: { billingFamilyGroupId: null },
  });

  return {
    cleanedFamilyGroupMembers: familyGroupMembers.count,
    nulledChildren: children.count,
    nulledSecondaryParents: secondaryParents.count,
    nulledInheritance: inheritance.count,
    retiredInheritedEmailCopies: retiredCopies.retired,
    orphanedLinks,
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

  // Privileged-target guard (issue #1604): only a Full Admin may archive an
  // account that holds (or dormantly stores) a privileged access role. Checked
  // canLogin-blind because archive targets are already cancelled (canLogin
  // false). Enforced again at approval below for defence in depth.
  if (
    !(await actorIsFullAdmin(prisma, requestedByMemberId)) &&
    memberHoldsPrivilegedRole(member)
  ) {
    throw new MemberLifecycleActionError(PRIVILEGED_TARGET_GUARD_MESSAGE, 403);
  }

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

// test seam
export async function reviewMemberDeleteRequest({
  requestId,
  reviewedByMemberId,
  action,
  reviewNote,
  ipAddress,
}: LifecycleReviewInput) {
  const note = cleanText(reviewNote);
  const request = await loadDeleteRequestById(requestId);
  // #2255: filled inside the transaction, read after it — the links it
  // describes are gone by the time it commits.
  let orphanedByHardDelete: OrphanedFamilyLinks = EMPTY_ORPHANED_FAMILY_LINKS;

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
      // Claim the review atomically (issue #1886). The pre-transaction status
      // check above reads stale data under concurrency: another admin's
      // review can commit between that read and this transaction. Guarding
      // the update on status ensures the losing reviewer matches zero rows
      // and bails with the 409 instead of silently overwriting the earlier
      // decision. Mirrors the archiveClaim guarded-updateMany pattern below.
      const reviewClaim = await tx.memberLifecycleActionRequest.updateMany({
        where: {
          id: request.id,
          status: MemberLifecycleActionRequestStatus.REQUESTED,
        },
        data: {
          status: MemberLifecycleActionRequestStatus.REJECTED,
          reviewNote: note,
          reviewedByMemberId,
          reviewedAt: new Date(),
        },
      });
      if (reviewClaim.count !== 1) {
        throw new MemberLifecycleActionError(
          "This delete request has already been reviewed.",
          409,
        );
      }

      const reviewed = await tx.memberLifecycleActionRequest.findUniqueOrThrow({
        where: { id: request.id },
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

    // Uniform shape on both branches: a caller must never have to check
    // whether the key exists before reading it. A rejection detaches nothing.
    return {
      request: serializeMemberLifecycleActionRequest(rejected),
      orphanedLinks: EMPTY_ORPHANED_FAMILY_LINKS,
    };
  }

  const approved = await prisma.$transaction(async (tx) => {
    // Serialize concurrent member-lifecycle work for this member id so an
    // eligibility re-check inside this transaction cannot be raced by a
    // parallel write (new booking, guest appearance, family request,
    // refund) that would otherwise leave us with a 500 from FK RESTRICT
    // or an orphaned SET NULL row. See docs/ARCHITECTURE.md for the
    // wider advisory-lock convention.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`member-lifecycle:${request.memberId}`}))`;

    // Xero CONTACT CREATE/UPDATE reservations take this Member row KEY SHARE
    // before committing their durable provider-work proof. Take the conflicting
    // row lock and re-check the complete blocker set before eligibility, the
    // review claim, or any destructive write. Reservation-first therefore
    // refuses this delete; delete-first keeps the row locked until hard-delete
    // commits, after which a waiting reservation observes a missing member and
    // performs no provider call.
    const fencedMember = await lockMemberForAccountDeletionXeroFence(
      tx,
      request.memberId,
    );

    const eligibility = await getMemberDeleteEligibility({
      memberId: request.memberId,
      currentAdminMemberId: reviewedByMemberId,
      ignoreRequestId: request.id,
      db: tx,
    });
    assertEligibleForDelete(eligibility);

    const snapshot = await buildMemberSnapshot(request.memberId, tx, eligibility);
    const now = new Date();

    // Claim the review atomically as the first write of this transaction
    // (issue #1886). The advisory lock serializes lifecycle work per member,
    // but the request row itself can be reviewed concurrently (e.g. admin B
    // rejects while admin A approves): without this status guard the losing
    // approver would overwrite the committed rejection and hard-delete the
    // member anyway. Guarding on REQUESTED means the loser matches zero rows
    // and bails with the 409 before any destructive write. Mirrors the
    // archiveClaim guarded-updateMany pattern below.
    const reviewClaim = await tx.memberLifecycleActionRequest.updateMany({
      where: {
        id: request.id,
        status: MemberLifecycleActionRequestStatus.REQUESTED,
      },
      data: {
        status: MemberLifecycleActionRequestStatus.APPROVED,
        reviewNote: note,
        reviewedByMemberId,
        reviewedAt: now,
        processedAt: now,
        memberSnapshot: snapshot,
      },
    });
    if (reviewClaim.count !== 1) {
      throw new MemberLifecycleActionError(
        "This delete request has already been reviewed.",
        409,
      );
    }

    await tx.xeroObjectLink.updateMany({
      where: {
        localModel: "Member",
        localId: request.memberId,
        active: true,
      },
      data: { active: false },
    });

    const memberBeforeDelete = await tx.member.update({
      where: { id: request.memberId },
      data: { xeroContactId: null },
      select: { photoImageId: true },
    });

    // #2859: the cached Xero contact goes with the member, exactly as it does
    // on the anonymising deletion path (`deletion-requests/[id]/route.ts`).
    // This is the STRONGER erasure of the two — the Member row itself is about
    // to be removed — so leaving a `XeroContactCache` row holding the deleted
    // member's date of birth, name, email, phone and address would be the
    // plainer version of the same defect. Deleted, not nulled: a row that
    // exists and holds `null` reads to `buildXeroContactCompanyNumberPatch` as
    // "we looked, and Xero's NZBN field is empty", which is its permission to
    // write — and Xero still holds the value (#2873), so manufacturing that
    // permission would let a later namesake matched onto this same contact have
    // a real business number overwritten by a birthday.
    if (fencedMember.xeroContactId) {
      await tx.xeroContactCache.deleteMany({
        where: { contactId: fencedMember.xeroContactId },
      });
    }

    const reviewed = await tx.memberLifecycleActionRequest.findUniqueOrThrow({
      where: { id: request.id },
      include: lifecycleActionRequestInclude,
    });

    // Scrub the member's own MEMBER_PHOTO blob (and any unreferenced blob they
    // uploaded) so the hard-delete leaves no orphaned photo bytes — mirroring
    // the merge reconcile. The shared helper spares blobs still referenced by
    // another surviving member (an ex-admin deleted here may have uploaded
    // photos on behalf of others). Runs before the delete while the member's
    // pointer still exists. Lock order (deadlock-freedom): the `member.update`
    // above already holds this member's row lock, so this MediaImage delete
    // takes MediaImage AFTER Member — matching the photo upload writer's
    // Member(FOR UPDATE)→MediaImage order. Do not move this above that update.
    // See docs/CONCURRENCY_AND_LOCKING.md → "Member photo writer".
    const photoReconcile = await deleteOwnedMemberPhotoBlobs(tx, {
      memberId: request.memberId,
      photoImageId: memberBeforeDelete.photoImageId,
    });

    // #2255: the FOURTH removal path, and the only one that relied on the
    // database to do the detaching. `onDelete: SetNull` nulls the dependants'
    // parent columns and their `inheritEmailFromId` as the row goes, so the
    // links really are cleared — but silently, with no declaration, and it
    // leaves `inheritParentEmail: true` standing beside a NULL pointer. That
    // combination reads as "inherits from nobody", which no writer produces and
    // no reader expects. Captured before the delete (afterwards there is
    // nothing left to read) and the stranded flag cleared after it.
    const orphanedByDelete = await readFamilyLinkOrphans(tx, request.memberId);
    orphanedByHardDelete = orphanedByDelete;

    await tx.member.delete({ where: { id: request.memberId } });

    if (orphanedByDelete.emailInheritors.length > 0) {
      // #2716: both self-relations carry `onDelete: SetNull`, so the deleted
      // row takes the CHOICE with it as well as the pointer — which is why the
      // stranded-flag repair is scoped on both being NULL. A member who kept a
      // choice would still have a live decision and must keep the flag that
      // records where it came from.
      await tx.member.updateMany({
        where: {
          id: { in: orphanedByDelete.emailInheritors.map((row) => row.id) },
          inheritEmailFromId: null,
          inheritEmailChoiceId: null,
        },
        data: { inheritParentEmail: false },
      });
    }

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
          memberPhotoBlobsDeleted: photoReconcile.deleted,
          // #2255: named, not just counted — the same declaration the other
          // three removal paths make.
          detachedDependantIds: orphanedByDelete.dependants.map((row) => row.id),
          detachedEmailInheritorIds: orphanedByDelete.emailInheritors.map(
            (row) => row.id,
          ),
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

  return {
    request: serializeMemberLifecycleActionRequest(approved),
    // Always present (empty arrays when nothing was linked), matching the
    // cancellation and archive contracts.
    orphanedLinks: orphanedByHardDelete,
  };
}

// test seam
export async function reviewMemberArchiveRequest({
  requestId,
  reviewedByMemberId,
  action,
  reviewNote,
  ipAddress,
  notifyMember,
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

  // #1788 honesty rule — the target member is only emailed when they exist and
  // have an address on file (archive never mutates email, so this pre-transaction
  // value is valid for both the reject and approve post-commit sends). Record the
  // suppression in the audit ONLY on a path that truly would have sent; a member
  // with no email sends nothing either way, so no notify field is written. The
  // per-send gate is written inline (`targetMember?.email && notifyMember !==
  // false`) so the send callbacks narrow `targetMember` to non-null.
  const notifyAuditFields =
    targetMember?.email && notifyMember === false ? { notifyMember: false } : {};

  if (action === "reject") {
    const rejected = await prisma.$transaction(async (tx) => {
      // Claim the review atomically (issue #1886) — see the delete-reject
      // transaction for the race this guards against.
      const reviewClaim = await tx.memberLifecycleActionRequest.updateMany({
        where: {
          id: request.id,
          status: MemberLifecycleActionRequestStatus.REQUESTED,
        },
        data: {
          status: MemberLifecycleActionRequestStatus.REJECTED,
          reviewNote: note,
          reviewedByMemberId,
          reviewedAt: new Date(),
        },
      });
      if (reviewClaim.count !== 1) {
        throw new MemberLifecycleActionError(
          "This archive request has already been reviewed.",
          409,
        );
      }

      const reviewed = await tx.memberLifecycleActionRequest.findUniqueOrThrow({
        where: { id: request.id },
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
            ...notifyAuditFields,
          },
          ipAddress,
        },
        tx,
      );

      return reviewed;
    });

    // #1788: notify the target member unless the admin opted out (default is
    // notify; the suppression is audited above).
    if (targetMember?.email && notifyMember !== false) {
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

  // #2255: filled inside the transaction, read after it. Declared out here
  // because the links it describes no longer exist once the sweep commits.
  let orphanedByArchive: OrphanedFamilyLinks = EMPTY_ORPHANED_FAMILY_LINKS;

  // #3123 / INV-LOCK-004 — the club's day, resolved before the transaction
  // opens. `enqueueHostingCoverageReevaluationForMember` takes a `Member` row
  // lock and then bounds its fan-out on `checkOut >= today`, so it cannot
  // resolve the club's persisted timezone itself: that read is a
  // `clubTimeSettings.findUnique` and would take a second pooled connection
  // under the lock.
  const clubTodayForFanout = await clubTodayDateOnlyInstant();

  const approved = await prisma.$transaction(async (tx) => {
    // See reviewMemberDeleteRequest for the advisory-lock rationale.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`member-lifecycle:${request.memberId}`}))`;

    const member = await tx.member.findUnique({
      where: { id: request.memberId },
      select: archiveTargetMemberSelect,
    });

    if (!member) {
      throw new MemberLifecycleActionError("Member not found.", 404);
    }

    assertArchiveEligible(member);

    // Admin-account guards (issue #1604), enforced at the approval/execution
    // point. Privileged-target: only a Full Admin may approve an archive of an
    // account holding privileged access. Last-admin: a backstop that is vacuous
    // in practice because archive requires a prior cancellation (which already
    // cleared canLogin, so the target is not a counted active Full Admin), but
    // kept so the invariant holds if that precondition ever changes.
    if (
      !(await actorIsFullAdmin(tx, reviewedByMemberId)) &&
      memberHoldsPrivilegedRole(member)
    ) {
      throw new MemberLifecycleActionError(PRIVILEGED_TARGET_GUARD_MESSAGE, 403);
    }
    if (await wouldRemoveLastFullAdmin(tx, request.memberId)) {
      throw new MemberLifecycleActionError(LAST_FULL_ADMIN_GUARD_MESSAGE, 409);
    }

    const now = new Date();

    // Claim the review atomically as the first write of this transaction
    // (issue #1886) — see the delete-approve transaction for the concurrent
    // approve/reject race this guards against. Bailing here means a losing
    // reviewer performs no link cleanup or member writes.
    const reviewClaim = await tx.memberLifecycleActionRequest.updateMany({
      where: {
        id: request.id,
        status: MemberLifecycleActionRequestStatus.REQUESTED,
      },
      data: {
        status: MemberLifecycleActionRequestStatus.APPROVED,
        reviewNote: note,
        reviewedByMemberId,
        reviewedAt: now,
        processedAt: now,
      },
    });
    if (reviewClaim.count !== 1) {
      throw new MemberLifecycleActionError(
        "This archive request has already been reviewed.",
        409,
      );
    }

    const linkCleanupCounts = await cleanupArchivedMemberLinks(
      tx,
      request.memberId,
    );
    const { orphanedLinks: _orphanedLinks, ...countsOnly } = linkCleanupCounts;
    orphanedByArchive = linkCleanupCounts.orphanedLinks;

    // Claim the archive transition atomically. If another approve
    // transaction for the same member committed first (despite the
    // advisory lock, e.g. on a replica or after a stale read), this
    // updateMany will match zero rows and we abort with 409 rather than
    // double-stamping archivedAt.
    const archiveClaim = await tx.member.updateMany({
      where: { id: request.memberId, archivedAt: null },
      data: {
        archivedAt: now,
        archivedReason: request.reason,
        archivedViaLifecycleActionRequestId: request.id,
        active: false,
        canLogin: false,
      },
    });
    if (archiveClaim.count !== 1) {
      throw new MemberLifecycleActionError(
        "This member has already been archived.",
        409,
      );
    }

    // #2576 §8. ARCHIVING A MEMBER CAN LEAVE A CONFIRMED BOOKING UNCOVERED, and
    // "membership becoming inactive, lapsed, cancelled or archived" is the FIRST
    // change class the owner's decision names. Only the evaluator half of that
    // existed: an archived member correctly stops counting as a qualifying adult
    // host, while nothing told the club to go and look at the bookings that had been
    // relying on them. So an archive left a confirmed booking silently
    // non-compliant, with no incident, no owner email, no officer-queue entry, and
    // the booking's own review snapshot still reading "compliant" — and the member's
    // NEXT edit was then blamed for it, trapping them.
    //
    // Recorded in this transaction, so the archive and the obligation to check what
    // it broke commit or roll back together. Bounded to the bookings this person
    // actually attends; never refuses the archive.
    await enqueueHostingCoverageReevaluationForMember(
      request.memberId,
      tx,
      clubTodayForFanout,
      {
        cause: "SYSTEM_CHANGE",
        actorMemberId: reviewedByMemberId,
      },
    );

    const reviewed = await tx.memberLifecycleActionRequest.findUniqueOrThrow({
      where: { id: request.id },
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
          ...countsOnly,
          // #2255: named, not just counted — a count tells the admin something
          // happened, not who to go and look at.
          detachedDependantIds: linkCleanupCounts.orphanedLinks.dependants.map(
            (member) => member.id,
          ),
          detachedEmailInheritorIds:
            linkCleanupCounts.orphanedLinks.emailInheritors.map(
              (member) => member.id,
            ),
          ...notifyAuditFields,
        },
        ipAddress,
      },
      tx,
    );

    return reviewed;
  });

  // #2576 §8: settle the re-evaluation the archive recorded, now it has committed.
  // Unfiltered: one member can attend bookings owned by several accounts at several
  // lodges, so there is no single owner key to scope this to.
  await settleHostingCoverageAfterCommit({ limit: 25 });

  // #1788: notify the target member unless the admin opted out (default is
  // notify; the suppression is audited above).
  if (targetMember?.email && notifyMember !== false) {
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

  return {
    request: serializeMemberLifecycleActionRequest(approved),
    // Always present (empty arrays when nothing was linked), so a caller cannot
    // mistake "no key" for "nothing detached" — same contract as cancellation.
    orphanedLinks: orphanedByArchive,
  };
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
