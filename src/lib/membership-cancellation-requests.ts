import { hashActionToken, issueActionToken } from "@/lib/action-tokens";
import { logAudit } from "@/lib/audit";
import {
  sendAdminMembershipCancellationRequestAlert,
  sendMembershipCancellationConfirmationEmail,
  sendMembershipCancellationSubmittedEmail,
} from "@/lib/email";
import logger from "@/lib/logger";
import {
  loadMembershipCancellationSettings,
  type MembershipCancellationSettings,
} from "@/lib/membership-cancellation-settings";
import { prisma } from "@/lib/prisma";

export const MEMBERSHIP_CANCELLATION_CONFIRMATION_TTL_MS =
  7 * 24 * 60 * 60 * 1000;

const OPEN_REQUEST_STATUSES = ["REQUESTED", "APPROVED"] as const;
const OPEN_PARTICIPANT_STATUSES = [
  "REQUESTED",
  "PENDING_CONFIRMATION",
  "APPROVED",
] as const;

type CancellationMemberRecord = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  active: boolean;
  canLogin: boolean;
  role: string;
  cancelledAt: Date | null;
  parentMemberId: string | null;
  secondaryParentId: string | null;
  familyGroupMemberships: Array<{
    familyGroupId: string;
    familyGroup: { id: string; name: string | null } | null;
  }>;
};

type CancellationParticipantRecord = {
  id: string;
  status: string;
  memberId: string;
  confirmationTokenExpiresAt?: Date | null;
  confirmedAt?: Date | null;
  declinedAt?: Date | null;
  createdAt: Date;
  member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    ageTier: string;
    canLogin: boolean;
    active: boolean;
  };
};

type CancellationRequestRecord = {
  id: string;
  status: string;
  reason: string | null;
  submittedAt: Date;
  reviewedAt?: Date | null;
  completedAt?: Date | null;
  requestedBy: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  participants: CancellationParticipantRecord[];
};

export type MembershipCancellationRelationship =
  | "self"
  | "dependent"
  | "non_login_adult"
  | "family_adult";

export type MembershipCancellationCandidate = {
  id: string;
  name: string;
  email: string;
  ageTier: string;
  relationship: MembershipCancellationRelationship;
  canLogin: boolean;
  requiresOwnConfirmation: boolean;
  eligible: boolean;
  ineligibleReason: string | null;
  familyGroupNames: string[];
  activeRequest: {
    id: string;
    status: string;
    participantStatus: string;
    submittedAt: string;
  } | null;
};

export type SerializedMembershipCancellationRequest = {
  id: string;
  status: string;
  reason: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  completedAt: string | null;
  requestedBy: {
    id: string;
    name: string;
    email: string;
  } | null;
  participants: Array<{
    id: string;
    memberId: string;
    name: string;
    email: string;
    ageTier: string;
    canLogin: boolean;
    active: boolean;
    status: string;
    confirmationTokenExpiresAt: string | null;
    confirmedAt: string | null;
    declinedAt: string | null;
    createdAt: string;
  }>;
};

export type MembershipCancellationOverview = {
  settings: MembershipCancellationSettings;
  candidates: MembershipCancellationCandidate[];
  requests: SerializedMembershipCancellationRequest[];
};

export type MembershipCancellationConfirmationDetails = {
  tokenStatus:
    | "missing"
    | "invalid"
    | "wrong_member"
    | "expired"
    | "responded"
    | "request_closed"
    | "ready";
  canRespond: boolean;
  message: string;
  request: SerializedMembershipCancellationRequest | null;
  participant: SerializedMembershipCancellationRequest["participants"][number] | null;
};

export class MembershipCancellationRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "MembershipCancellationRequestError";
  }
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown) {
  const cleaned = cleanString(value);
  return cleaned ? cleaned : null;
}

function memberName(member: {
  firstName?: string | null;
  lastName?: string | null;
}) {
  return [member.firstName, member.lastName].filter(Boolean).join(" ").trim();
}

function memberDisplayName(member: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}) {
  return memberName(member) || member.email || "Unknown member";
}

function participantSummary(
  participants: Array<{
    member: {
      firstName?: string | null;
      lastName?: string | null;
      email?: string | null;
    };
  }>,
) {
  return participants.map((participant) => memberDisplayName(participant.member)).join(", ");
}

function hasReviewableCancellationParticipant(
  participants: Array<{ status: string; confirmedAt?: Date | string | null }>,
) {
  return participants.some(
    (participant) =>
      participant.status === "REQUESTED" && Boolean(participant.confirmedAt),
  );
}

function serializeDate(value: Date | string | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function serializeRequest(
  request: CancellationRequestRecord,
): SerializedMembershipCancellationRequest {
  return {
    id: request.id,
    status: request.status,
    reason: request.reason,
    submittedAt: serializeDate(request.submittedAt) ?? "",
    reviewedAt: serializeDate(request.reviewedAt),
    completedAt: serializeDate(request.completedAt),
    requestedBy: request.requestedBy
      ? {
          id: request.requestedBy.id,
          name: memberName(request.requestedBy),
          email: request.requestedBy.email,
        }
      : null,
    participants: request.participants.map((participant) => ({
      id: participant.id,
      memberId: participant.memberId,
      name: memberName(participant.member),
      email: participant.member.email,
      ageTier: participant.member.ageTier,
      canLogin: participant.member.canLogin,
      active: participant.member.active,
      status: participant.status,
      confirmationTokenExpiresAt: serializeDate(
        participant.confirmationTokenExpiresAt,
      ),
      confirmedAt: serializeDate(participant.confirmedAt),
      declinedAt: serializeDate(participant.declinedAt),
      createdAt: serializeDate(participant.createdAt) ?? "",
    })),
  };
}

function relationshipForMember(
  member: CancellationMemberRecord,
  requesterId: string,
): MembershipCancellationRelationship {
  if (member.id === requesterId) return "self";
  if (
    member.ageTier !== "ADULT" ||
    member.parentMemberId === requesterId ||
    member.secondaryParentId === requesterId
  ) {
    return "dependent";
  }
  if (!member.canLogin) return "non_login_adult";
  return "family_adult";
}

function getFamilyGroupNames(member: CancellationMemberRecord) {
  return member.familyGroupMemberships
    .map((membership) => membership.familyGroup?.name?.trim())
    .filter((name): name is string => Boolean(name));
}

function toCandidate(
  member: CancellationMemberRecord,
  requesterId: string,
  activeParticipant:
    | {
        status: string;
        request: {
          id: string;
          status: string;
          submittedAt: Date;
        };
      }
    | undefined,
): MembershipCancellationCandidate {
  const relationship = relationshipForMember(member, requesterId);
  const requiresOwnConfirmation = member.id !== requesterId && member.canLogin;
  const roleAllowed = member.role === "MEMBER";
  const activeAllowed = member.active && !member.cancelledAt;
  const eligible = roleAllowed && activeAllowed && !activeParticipant;

  let ineligibleReason: string | null = null;
  if (!roleAllowed) {
    ineligibleReason = "Only member accounts can be included.";
  } else if (!activeAllowed) {
    ineligibleReason = "This membership is not active.";
  } else if (activeParticipant) {
    ineligibleReason = "This member already has an open cancellation request.";
  }

  return {
    id: member.id,
    name: memberName(member),
    email: member.email,
    ageTier: member.ageTier,
    relationship,
    canLogin: member.canLogin,
    requiresOwnConfirmation,
    eligible,
    ineligibleReason,
    familyGroupNames: getFamilyGroupNames(member),
    activeRequest: activeParticipant
      ? {
          id: activeParticipant.request.id,
          status: activeParticipant.request.status,
          participantStatus: activeParticipant.status,
          submittedAt: activeParticipant.request.submittedAt.toISOString(),
        }
      : null,
  };
}

async function loadCancellationCandidates(requesterMemberId: string) {
  const currentMember = await prisma.member.findUnique({
    where: { id: requesterMemberId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      ageTier: true,
      active: true,
      canLogin: true,
      role: true,
      cancelledAt: true,
      parentMemberId: true,
      secondaryParentId: true,
      familyGroupMemberships: {
        select: {
          familyGroupId: true,
          familyGroup: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!currentMember) {
    throw new MembershipCancellationRequestError("Member not found", 404);
  }

  if (
    !currentMember.active ||
    !currentMember.canLogin ||
    currentMember.role !== "MEMBER"
  ) {
    throw new MembershipCancellationRequestError(
      "Membership cancellation requests are only available to active login-capable member accounts",
      403,
    );
  }

  const groupIds = currentMember.familyGroupMemberships.map(
    (membership) => membership.familyGroupId,
  );
  const relatedMembers = await prisma.member.findMany({
    where: {
      active: true,
      role: "MEMBER",
      OR: [
        { id: currentMember.id },
        ...(groupIds.length > 0
          ? [{ familyGroupMemberships: { some: { familyGroupId: { in: groupIds } } } }]
          : []),
      ],
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      ageTier: true,
      active: true,
      canLogin: true,
      role: true,
      cancelledAt: true,
      parentMemberId: true,
      secondaryParentId: true,
      familyGroupMemberships: {
        where: groupIds.length > 0 ? { familyGroupId: { in: groupIds } } : undefined,
        select: {
          familyGroupId: true,
          familyGroup: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });

  const memberIds = relatedMembers.map((member) => member.id);
  const activeParticipants =
    memberIds.length > 0
      ? await prisma.membershipCancellationRequestParticipant.findMany({
          where: {
            memberId: { in: memberIds },
            status: { in: [...OPEN_PARTICIPANT_STATUSES] },
            request: { status: { in: [...OPEN_REQUEST_STATUSES] } },
          },
          select: {
            memberId: true,
            status: true,
            request: {
              select: {
                id: true,
                status: true,
                submittedAt: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
        })
      : [];
  const activeParticipantByMemberId = new Map(
    activeParticipants.map((participant) => [participant.memberId, participant]),
  );
  const candidates = relatedMembers.map((member) =>
    toCandidate(member, currentMember.id, activeParticipantByMemberId.get(member.id)),
  );

  return {
    currentMember,
    candidates,
  };
}

async function loadVisibleRequests(memberId: string) {
  const requests = await prisma.membershipCancellationRequest.findMany({
    where: {
      OR: [
        { requestedByMemberId: memberId },
        { participants: { some: { memberId } } },
      ],
    },
    include: {
      requestedBy: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      participants: {
        include: {
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              ageTier: true,
              canLogin: true,
              active: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { submittedAt: "desc" },
    take: 10,
  });

  return requests.map(serializeRequest);
}

export async function getMembershipCancellationOverview(
  memberId: string,
): Promise<MembershipCancellationOverview> {
  const [settings, candidateData, requests] = await Promise.all([
    loadMembershipCancellationSettings(),
    loadCancellationCandidates(memberId),
    loadVisibleRequests(memberId),
  ]);

  return {
    settings,
    candidates: candidateData.candidates,
    requests,
  };
}

export async function createMembershipCancellationRequest({
  requesterMemberId,
  participantMemberIds,
  reason,
  acknowledgedWarning,
  ipAddress,
}: {
  requesterMemberId: string;
  participantMemberIds: string[];
  reason?: string | null;
  acknowledgedWarning: boolean;
  ipAddress?: string | null;
}) {
  if (!acknowledgedWarning) {
    throw new MembershipCancellationRequestError(
      "You must acknowledge the membership cancellation warning before submitting",
      422,
    );
  }

  const selectedIds = Array.from(
    new Set(participantMemberIds.map(cleanString).filter(Boolean)),
  );

  if (selectedIds.length === 0) {
    throw new MembershipCancellationRequestError(
      "Select at least one membership to include",
      422,
    );
  }

  const { currentMember, candidates } =
    await loadCancellationCandidates(requesterMemberId);
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const invalidIds = selectedIds.filter((id) => !candidateById.get(id)?.eligible);

  if (invalidIds.length > 0) {
    throw new MembershipCancellationRequestError(
      "One or more selected memberships are not eligible for cancellation requests",
      422,
    );
  }

  const selectedCandidates = selectedIds.map((id) => candidateById.get(id)!);
  const now = new Date();
  const tokenByMemberId = new Map<
    string,
    { token: string; tokenHash: string; expiresAt: Date }
  >();

  for (const candidate of selectedCandidates) {
    if (!candidate.requiresOwnConfirmation) continue;
    const issued = issueActionToken();
    tokenByMemberId.set(candidate.id, {
      ...issued,
      expiresAt: new Date(now.getTime() + MEMBERSHIP_CANCELLATION_CONFIRMATION_TTL_MS),
    });
  }

  const request = await prisma.$transaction(async (tx) => {
    // Re-check open participant rows for each selected member inside
    // the transaction so two near-simultaneous submissions cannot both
    // succeed and create duplicate participants for the same member
    // across overlapping cancellation requests.
    const conflicting =
      await tx.membershipCancellationRequestParticipant.findMany({
        where: {
          memberId: { in: selectedCandidates.map((candidate) => candidate.id) },
          status: { in: [...OPEN_PARTICIPANT_STATUSES] },
        },
        select: { memberId: true },
      });
    if (conflicting.length > 0) {
      throw new MembershipCancellationRequestError(
        "One or more selected memberships already have an open cancellation request",
        409,
      );
    }

    return tx.membershipCancellationRequest.create({
    data: {
      requestedByMemberId: currentMember.id,
      status: "REQUESTED",
      reason: nullableText(reason),
      participants: {
        create: selectedCandidates.map((candidate) => {
          const token = tokenByMemberId.get(candidate.id);
          return {
            memberId: candidate.id,
            status: token ? "PENDING_CONFIRMATION" : "REQUESTED",
            confirmedAt: token ? null : now,
            confirmationTokenHash: token?.tokenHash ?? null,
            confirmationTokenExpiresAt: token?.expiresAt ?? null,
          };
        }),
      },
    },
    include: {
      requestedBy: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      participants: {
        include: {
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              ageTier: true,
              canLogin: true,
              active: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
    });
  });

  logAudit({
    action: "membership_cancellation.requested",
    memberId: currentMember.id,
    actorMemberId: currentMember.id,
    targetId: request.id,
    entityType: "MembershipCancellationRequest",
    entityId: request.id,
    category: "account",
    severity: "important",
    outcome: "success",
    summary: "Membership cancellation request submitted",
    metadata: {
      participantMemberIds: selectedCandidates.map((candidate) => candidate.id),
      pendingConfirmationMemberIds: selectedCandidates
        .filter((candidate) => candidate.requiresOwnConfirmation)
        .map((candidate) => candidate.id),
    },
    ipAddress,
  });

  const requesterName = memberDisplayName(currentMember);
  const summary = participantSummary(request.participants);
  const emailWarnings: string[] = [];

  try {
    await sendMembershipCancellationSubmittedEmail({
      email: currentMember.email,
      firstName: currentMember.firstName,
      participantSummary: summary,
      reason: request.reason,
    });
  } catch (err) {
    logger.error(
      { err, requestId: request.id, requesterMemberId: currentMember.id },
      "Failed to send membership cancellation submitted email",
    );
    emailWarnings.push("Submission confirmation email could not be sent");
  }

  await Promise.all(
    request.participants.map(async (participant) => {
      const token = tokenByMemberId.get(participant.memberId);
      if (!token) return;

      try {
        await sendMembershipCancellationConfirmationEmail({
          email: participant.member.email,
          firstName: participant.member.firstName,
          requesterName,
          participantName: memberName(participant.member),
          token: token.token,
          expiresAt: token.expiresAt,
        });
      } catch (err) {
        logger.error(
          { err, requestId: request.id, participantId: participant.id },
          "Failed to send membership cancellation confirmation email",
        );
        emailWarnings.push(
          `Confirmation email could not be sent to ${memberName(participant.member)}`,
        );
      }
    }),
  );

  if (hasReviewableCancellationParticipant(request.participants)) {
    try {
      await sendAdminMembershipCancellationRequestAlert({
        requesterName,
        participantSummary: summary,
        reason: request.reason,
      });
    } catch (err) {
      logger.error(
        { err, requestId: request.id },
        "Failed to send admin membership cancellation request alert",
      );
      emailWarnings.push("Admin review alert could not be sent");
    }
  }

  return {
    request: serializeRequest(request),
    emailWarnings,
  };
}

async function findConfirmationParticipant(token: string) {
  const normalizedToken = cleanString(token);
  if (!normalizedToken) return null;

  return prisma.membershipCancellationRequestParticipant.findUnique({
    where: { confirmationTokenHash: hashActionToken(normalizedToken) },
    include: {
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          ageTier: true,
          canLogin: true,
          active: true,
        },
      },
      request: {
        include: {
          requestedBy: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          participants: {
            include: {
              member: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                  ageTier: true,
                  canLogin: true,
                  active: true,
                },
              },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      },
    },
  });
}

export async function getMembershipCancellationConfirmationDetails(
  token: string,
  memberId: string,
): Promise<MembershipCancellationConfirmationDetails> {
  if (!cleanString(token)) {
    return {
      tokenStatus: "missing",
      canRespond: false,
      message: "This cancellation confirmation link is missing its token.",
      request: null,
      participant: null,
    };
  }

  const participant = await findConfirmationParticipant(token);
  if (!participant) {
    return {
      tokenStatus: "invalid",
      canRespond: false,
      message: "This cancellation confirmation link is invalid or has already been used.",
      request: null,
      participant: null,
    };
  }

  if (participant.memberId !== memberId) {
    return {
      tokenStatus: "wrong_member",
      canRespond: false,
      message: "This cancellation confirmation link is assigned to a different member account.",
      request: null,
      participant: null,
    };
  }

  const serializedRequest = serializeRequest(participant.request);
  const serializedParticipant =
    serializedRequest.participants.find((item) => item.id === participant.id) ??
    null;

  if (participant.request.status !== "REQUESTED") {
    return {
      tokenStatus: "request_closed",
      canRespond: false,
      message: "This cancellation request is no longer open.",
      request: serializedRequest,
      participant: serializedParticipant,
    };
  }

  if (participant.status !== "PENDING_CONFIRMATION") {
    return {
      tokenStatus: "responded",
      canRespond: false,
      message: "You have already responded to this cancellation request.",
      request: serializedRequest,
      participant: serializedParticipant,
    };
  }

  if (
    participant.confirmationTokenExpiresAt &&
    participant.confirmationTokenExpiresAt < new Date()
  ) {
    return {
      tokenStatus: "expired",
      canRespond: false,
      message: "This cancellation confirmation link has expired.",
      request: serializedRequest,
      participant: serializedParticipant,
    };
  }

  return {
    tokenStatus: "ready",
    canRespond: true,
    message:
      "Confirm whether your membership should be included in this cancellation request.",
    request: serializedRequest,
    participant: serializedParticipant,
  };
}

export async function respondToMembershipCancellationConfirmation({
  token,
  memberId,
  decision,
  ipAddress,
}: {
  token: string;
  memberId: string;
  decision: "confirm" | "decline";
  ipAddress?: string | null;
}) {
  const normalizedToken = cleanString(token);
  if (!normalizedToken) {
    throw new MembershipCancellationRequestError(
      "Cancellation confirmation token is required",
      422,
    );
  }

  const tokenHash = hashActionToken(normalizedToken);
  const now = new Date();
  const participant =
    await prisma.membershipCancellationRequestParticipant.findUnique({
      where: { confirmationTokenHash: tokenHash },
      include: {
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            ageTier: true,
            canLogin: true,
            active: true,
          },
        },
        request: true,
      },
    });

  if (!participant) {
    throw new MembershipCancellationRequestError(
      "This cancellation confirmation link is invalid or has already been used",
      404,
    );
  }

  if (participant.memberId !== memberId) {
    throw new MembershipCancellationRequestError(
      "This cancellation confirmation link is for a different member account",
      403,
    );
  }

  if (participant.request.status !== "REQUESTED") {
    throw new MembershipCancellationRequestError(
      "This cancellation request is no longer open",
      409,
    );
  }

  if (participant.status !== "PENDING_CONFIRMATION") {
    throw new MembershipCancellationRequestError(
      "This cancellation confirmation has already been answered",
      409,
    );
  }

  if (
    participant.confirmationTokenExpiresAt &&
    participant.confirmationTokenExpiresAt < now
  ) {
    throw new MembershipCancellationRequestError(
      "This cancellation confirmation link has expired",
      410,
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const updatedParticipant =
      await tx.membershipCancellationRequestParticipant.update({
        where: { id: participant.id },
        data:
          decision === "confirm"
            ? {
                status: "REQUESTED",
                confirmedAt: now,
                confirmationTokenHash: null,
                confirmationTokenExpiresAt: null,
              }
            : {
                status: "DECLINED",
                declinedAt: now,
                confirmationTokenHash: null,
                confirmationTokenExpiresAt: null,
              },
        include: {
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              ageTier: true,
              canLogin: true,
              active: true,
            },
          },
          request: {
            include: {
              requestedBy: {
                select: { id: true, firstName: true, lastName: true, email: true },
              },
              participants: {
                include: {
                  member: {
                    select: {
                      id: true,
                      firstName: true,
                      lastName: true,
                      email: true,
                      ageTier: true,
                      canLogin: true,
                      active: true,
                    },
                  },
                },
                orderBy: { createdAt: "asc" },
              },
            },
          },
        },
      });

    // Defence in depth: if the same member somehow has another open
    // PENDING_CONFIRMATION row across overlapping requests, invalidate
    // its token now so it cannot be replayed.
    await tx.membershipCancellationRequestParticipant.updateMany({
      where: {
        memberId,
        status: "PENDING_CONFIRMATION",
        id: { not: participant.id },
      },
      data: {
        confirmationTokenHash: null,
        confirmationTokenExpiresAt: null,
      },
    });

    return updatedParticipant;
  });

  logAudit({
    action:
      decision === "confirm"
        ? "membership_cancellation.participant_confirmed"
        : "membership_cancellation.participant_declined",
    memberId,
    actorMemberId: memberId,
    subjectMemberId: memberId,
    targetId: updated.requestId,
    entityType: "MembershipCancellationRequest",
    entityId: updated.requestId,
    category: "account",
    severity: "important",
    outcome: "success",
    summary:
      decision === "confirm"
        ? "Membership cancellation participant confirmed"
        : "Membership cancellation participant declined",
    ipAddress,
  });

  if (decision === "confirm") {
    const requesterName = updated.request.requestedBy
      ? memberDisplayName(updated.request.requestedBy)
      : "Unknown member";
    try {
      await sendAdminMembershipCancellationRequestAlert({
        requesterName,
        participantSummary: participantSummary(updated.request.participants),
        reason: updated.request.reason,
      });
    } catch (err) {
      logger.error(
        { err, requestId: updated.requestId, participantId: updated.id },
        "Failed to send admin membership cancellation confirmation alert",
      );
    }
  }

  return {
    request: serializeRequest(updated.request),
    participant:
      serializeRequest(updated.request).participants.find(
        (item) => item.id === updated.id,
      ) ?? null,
    message:
      decision === "confirm"
        ? "Your confirmation has been recorded. Your membership remains active until an administrator reviews the request."
        : "Your decline has been recorded. Your membership remains active.",
  };
}
