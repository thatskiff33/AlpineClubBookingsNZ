import { z } from "zod";
import type { AgeTier } from "@prisma/client";
import { randomBytes } from "crypto";
import { hash } from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import {
  computeAgeTier,
  computeAgeTierWithSettings,
  getAgeTierSettings,
  getSeasonStartDate,
  type AgeTierSettingData,
} from "@/lib/age-tier";
import { getSeasonYear } from "@/lib/utils";
import {
  buildParentLinks,
  resolveParentNotificationSourceId,
} from "@/lib/member-parent-links";
import { validateInheritEmailSource } from "@/lib/member-email-inheritance";
import {
  sendChildRequestApprovedEmail,
  sendChildRequestRejectedEmail,
} from "@/lib/email";

export const REVIEWED_REQUEST_TYPES = [
  "JOIN_REQUEST",
  "CHILD_REQUEST",
  "ADULT_REQUEST",
  "REMOVAL_REQUEST",
] as const;

const CHILD_REQUEST_AGE_TIERS: AgeTier[] = ["INFANT", "CHILD", "YOUTH"];

class ReviewRequestError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 422 = 422
  ) {
    super(message);
  }
}

type JsonRouteResult = {
  body: unknown;
  init?: ResponseInit;
};

function cleanOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function jsonResult(body: unknown, init?: ResponseInit): JsonRouteResult {
  return { body, init };
}

export const reviewFamilyGroupRequestSchema = z.object({
  requestId: z.string().min(1),
  action: z.enum(["approve", "reject"]),
  linkedMemberId: z.string().min(1).optional(),
  // Empty string is intentionally allowed: the admin request-review UI's
  // "Use child's own email" option sends inheritEmailFromId: "" (its
  // <option value="">), which the approve path coerces to null (no inheritance,
  // child keeps its own email) via `data.inheritEmailFromId?.trim() || null` and
  // resolveParentNotificationSourceId. Do not tighten to reject "" without
  // updating that client — a rolling deploy would 422 the old client's requests.
  inheritEmailFromId: z.string().optional().nullable().or(z.literal("")),
  createNewMember: z.boolean().optional(),
  rejectionReason: z.string().max(500).optional(),
});

export type ReviewFamilyGroupRequestInput = z.infer<
  typeof reviewFamilyGroupRequestSchema
>;

function getSameDayRange(date: Date) {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return { gte: start, lt: end };
}

function getRequestName(request: {
  type: string;
  childFirstName?: string | null;
  childLastName?: string | null;
  requestedFirstName?: string | null;
  requestedLastName?: string | null;
}) {
  if (request.type === "CHILD_REQUEST") {
    return [request.childFirstName, request.childLastName].filter(Boolean).join(" ").trim();
  }
  return [request.requestedFirstName, request.requestedLastName].filter(Boolean).join(" ").trim();
}

function getChildRequestTierMetadata(
  request: { type: string; childDateOfBirth?: Date | null },
  ageTierSettings: AgeTierSettingData[]
) {
  if (request.type !== "CHILD_REQUEST" || !request.childDateOfBirth) {
    return {
      requestedAgeTier: null,
      requestedAgeTierLabel: null,
      canCreateMemberFromRequest: false,
    };
  }

  const requestedAgeTier = computeAgeTierWithSettings(
    request.childDateOfBirth,
    getSeasonStartDate(getSeasonYear()),
    ageTierSettings
  );
  const setting = ageTierSettings.find((candidate) => candidate.tier === requestedAgeTier);

  return {
    requestedAgeTier,
    requestedAgeTierLabel: setting?.label ?? requestedAgeTier,
    canCreateMemberFromRequest:
      setting?.familyGroupRequestCreateMemberAllowed === true,
  };
}

async function findPotentialMemberMatches(request: {
  type: string;
  familyGroupId: string;
  childFirstName?: string | null;
  childLastName?: string | null;
  childDateOfBirth?: Date | null;
  requestedFirstName?: string | null;
  requestedLastName?: string | null;
  requestedDateOfBirth?: Date | null;
  requestedEmail?: string | null;
}) {
  if (request.type !== "CHILD_REQUEST" && request.type !== "ADULT_REQUEST") {
    return [];
  }

  const firstName =
    request.type === "CHILD_REQUEST"
      ? request.childFirstName
      : request.requestedFirstName;
  const lastName =
    request.type === "CHILD_REQUEST"
      ? request.childLastName
      : request.requestedLastName;
  const dateOfBirth =
    request.type === "CHILD_REQUEST"
      ? request.childDateOfBirth
      : request.requestedDateOfBirth;

  if (!firstName || !lastName) {
    return [];
  }

  const members = await prisma.member.findMany({
    where: {
      AND: [
        { firstName: { contains: firstName.trim(), mode: "insensitive" as const } },
        { lastName: { contains: lastName.trim(), mode: "insensitive" as const } },
        ...(dateOfBirth ? [{ dateOfBirth: getSameDayRange(dateOfBirth) }] : []),
        ...(request.type === "ADULT_REQUEST"
          ? [
              { ageTier: "ADULT" as AgeTier },
              { active: true },
              { archivedAt: null },
            ]
          : []),
        ...(request.type === "CHILD_REQUEST"
          ? [
              { ageTier: { in: CHILD_REQUEST_AGE_TIERS } },
              { active: true },
              { archivedAt: null },
            ]
          : []),
        ...(request.type === "ADULT_REQUEST" && request.requestedEmail
          ? [{ email: { equals: request.requestedEmail, mode: "insensitive" as const } }]
          : []),
      ],
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      ageTier: true,
      active: true,
      canLogin: true,
      parentMemberId: true,
      secondaryParentId: true,
      inheritEmailFromId: true,
      parent: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          ageTier: true,
          active: true,
          canLogin: true,
          inheritEmailFromId: true,
        },
      },
      secondaryParent: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          ageTier: true,
          active: true,
          canLogin: true,
          inheritEmailFromId: true,
        },
      },
      dateOfBirth: true,
      familyGroupMemberships: {
        where: { familyGroupId: request.familyGroupId },
        select: { familyGroupId: true },
      },
    },
    orderBy: [{ active: "desc" }, { lastName: "asc" }, { firstName: "asc" }],
    take: 10,
  });

  return members.map((member) => ({
    id: member.id,
    firstName: member.firstName,
    lastName: member.lastName,
    email: member.email,
    ageTier: member.ageTier,
    active: member.active,
    canLogin: member.canLogin,
    dateOfBirth: member.dateOfBirth,
    parentLinks: buildParentLinks(member),
    alreadyInGroup: member.familyGroupMemberships.length > 0,
  }));
}

export async function listAdminFamilyGroupRequests(): Promise<JsonRouteResult> {
  const ageTierSettings = await getAgeTierSettings();
  const requests = await prisma.familyGroupJoinRequest.findMany({
    where: {
      status: "PENDING",
      type: { in: [...REVIEWED_REQUEST_TYPES] },
    },
    include: {
      requester: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      subjectMember: {
        select: { id: true, firstName: true, lastName: true, email: true, ageTier: true, active: true },
      },
      familyGroup: {
        select: {
          id: true,
          name: true,
          memberships: {
            where: { member: { active: true, archivedAt: null } },
            select: {
              member: {
                select: { id: true, firstName: true, lastName: true, email: true, ageTier: true },
              },
            },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const mapped = await Promise.all(
    requests.map(async (request) => ({
      ...request,
      ...getChildRequestTierMetadata(request, ageTierSettings),
      familyGroup: {
        ...request.familyGroup,
        members: request.familyGroup.memberships.map((membership) => membership.member),
        memberships: undefined,
      },
      matchingMembers: await findPotentialMemberMatches(request),
    }))
  );

  return jsonResult({ requests: mapped });
}

async function validateLinkedMemberForRequest(params: {
  linkedMemberId: string;
  requestType: string;
}) {
  const linkedMember = await prisma.member.findUnique({
    where: { id: params.linkedMemberId },
    select: {
      id: true,
      ageTier: true,
      active: true,
      archivedAt: true,
      canLogin: true,
      parentMemberId: true,
      secondaryParentId: true,
      inheritEmailFromId: true,
      parent: { select: { id: true, inheritEmailFromId: true } },
      secondaryParent: { select: { id: true, inheritEmailFromId: true } },
      dependents: { select: { id: true }, take: 1 },
      secondaryDependents: { select: { id: true }, take: 1 },
    },
  });

  if (!linkedMember) {
    return { error: "Selected member record not found", status: 404 as const };
  }
  if (params.requestType === "CHILD_REQUEST") {
    if (
      !linkedMember.active ||
      linkedMember.archivedAt ||
      !CHILD_REQUEST_AGE_TIERS.includes(linkedMember.ageTier)
    ) {
      return {
        error: "Selected member must be an active infant, child, or youth",
        status: 422 as const,
      };
    }
  }
  if (params.requestType === "ADULT_REQUEST") {
    if (!linkedMember.active || linkedMember.archivedAt || linkedMember.ageTier !== "ADULT") {
      return { error: "Selected member must be an active adult", status: 422 as const };
    }
    if (linkedMember.canLogin) {
      return {
        error: "Same-email adult requests must link to a non-login adult member",
        status: 422 as const,
      };
    }
  }

  return { memberId: linkedMember.id, member: linkedMember };
}

export async function reviewAdminFamilyGroupRequest(params: {
  adminMemberId: string;
  data: ReviewFamilyGroupRequestInput;
}): Promise<JsonRouteResult> {
  const { adminMemberId, data } = params;
  const { requestId, action } = data;
  const linkedMemberId = data.linkedMemberId?.trim();
  const rejectionReason = data.rejectionReason?.trim();

  const request = await prisma.familyGroupJoinRequest.findUnique({
    where: { id: requestId },
    include: {
      requester: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          ageTier: true,
          active: true,
          archivedAt: true,
          inheritEmailFromId: true,
          phoneCountryCode: true,
          phoneAreaCode: true,
          phoneNumber: true,
          streetAddressLine1: true,
          streetAddressLine2: true,
          streetCity: true,
          streetRegion: true,
          streetPostalCode: true,
          streetCountry: true,
          postalAddressLine1: true,
          postalAddressLine2: true,
          postalCity: true,
          postalRegion: true,
          postalPostalCode: true,
          postalCountry: true,
        },
      },
      familyGroup: { select: { id: true, name: true } },
      subjectMember: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  if (!request) {
    return jsonResult({ error: "Request not found" }, { status: 404 });
  }

  if (request.status !== "PENDING") {
    return jsonResult({ error: "Request has already been reviewed" }, { status: 422 });
  }

  if (request.type === "ADULT_INVITE") {
    return jsonResult(
      { error: "Adult invitations are managed by the invited member, not admin review." },
      { status: 422 }
    );
  }

  if (action === "approve") {
    let affectedMemberId = request.requesterId;
    let childMemberCreateData: {
      email: string;
      firstName: string;
      lastName: string;
      dateOfBirth: Date;
      ageTier: AgeTier;
      active: true;
      canLogin: false;
      role: "USER";
      parentMemberId: string;
      inheritParentEmail: true;
      inheritEmailFromId: string;
      passwordHash: string;
      emailVerified: true;
      phoneCountryCode: string | null;
      phoneAreaCode: string | null;
      phoneNumber: string | null;
      streetAddressLine1: string | null;
      streetAddressLine2: string | null;
      streetCity: string | null;
      streetRegion: string | null;
      streetPostalCode: string | null;
      streetCountry: string | null;
      postalAddressLine1: string | null;
      postalAddressLine2: string | null;
      postalCity: string | null;
      postalRegion: string | null;
      postalPostalCode: string | null;
      postalCountry: string | null;
    } | null = null;
    let adultMemberCreateData: {
      email: string;
      firstName: string;
      lastName: string;
      dateOfBirth: Date;
      ageTier: AgeTier;
      active: true;
      canLogin: false;
      passwordHash: string;
      emailVerified: true;
    } | null = null;
    let childMemberForParentLink: {
      id: string;
      parentMemberId: string | null;
      secondaryParentId: string | null;
      inheritEmailFromId: string | null;
      parent: { id: string; inheritEmailFromId: string | null } | null;
      secondaryParent: { id: string; inheritEmailFromId: string | null } | null;
      dependents: Array<{ id: string }>;
      secondaryDependents: Array<{ id: string }>;
    } | null = null;

    if (request.type === "CHILD_REQUEST") {
      if (linkedMemberId && data.createNewMember) {
        return jsonResult(
          { error: "Choose an existing child member or create a new dependant, not both." },
          { status: 422 }
        );
      }

      if (data.createNewMember) {
        if (
          request.requester.active === false ||
          request.requester.archivedAt ||
          request.requester.ageTier !== "ADULT"
        ) {
          return jsonResult(
            { error: "Child requests can only be approved for active adult requesters." },
            { status: 422 }
          );
        }
        if (!request.childFirstName || !request.childLastName || !request.childDateOfBirth) {
          return jsonResult(
            { error: "Legacy child requests without DOB must link to an existing member or be rejected." },
            { status: 422 }
          );
        }

        const ageTierSettings = await getAgeTierSettings();
        const childRequestTier = getChildRequestTierMetadata(request, ageTierSettings);
        if (
          !childRequestTier.requestedAgeTier ||
          !childRequestTier.canCreateMemberFromRequest
        ) {
          return jsonResult(
            {
              error:
                "This age tier is not configured to allow admin-created members from family group requests. Link an existing member or reject the request.",
            },
            { status: 422 }
          );
        }

        const inheritEmailFromId =
          request.requester.inheritEmailFromId || request.requesterId;
        const validation = await validateInheritEmailSource({ inheritEmailFromId });
        if (!validation.ok) {
          return jsonResult({ error: validation.error }, { status: validation.status });
        }

        childMemberCreateData = {
          email: request.requester.email.toLowerCase().trim(),
          firstName: request.childFirstName.trim(),
          lastName: request.childLastName.trim(),
          dateOfBirth: request.childDateOfBirth,
          ageTier: childRequestTier.requestedAgeTier,
          active: true,
          canLogin: false,
          role: "USER",
          parentMemberId: request.requesterId,
          inheritParentEmail: true,
          inheritEmailFromId,
          passwordHash: await hash(randomBytes(32).toString("hex"), 13),
          emailVerified: true,
          phoneCountryCode: cleanOptionalString(request.requester.phoneCountryCode),
          phoneAreaCode: cleanOptionalString(request.requester.phoneAreaCode),
          phoneNumber: cleanOptionalString(request.requester.phoneNumber),
          streetAddressLine1: cleanOptionalString(request.requester.streetAddressLine1),
          streetAddressLine2: cleanOptionalString(request.requester.streetAddressLine2),
          streetCity: cleanOptionalString(request.requester.streetCity),
          streetRegion: cleanOptionalString(request.requester.streetRegion),
          streetPostalCode: cleanOptionalString(request.requester.streetPostalCode),
          streetCountry: cleanOptionalString(request.requester.streetCountry),
          postalAddressLine1: cleanOptionalString(request.requester.postalAddressLine1),
          postalAddressLine2: cleanOptionalString(request.requester.postalAddressLine2),
          postalCity: cleanOptionalString(request.requester.postalCity),
          postalRegion: cleanOptionalString(request.requester.postalRegion),
          postalPostalCode: cleanOptionalString(request.requester.postalPostalCode),
          postalCountry: cleanOptionalString(request.requester.postalCountry),
        };
      } else if (!linkedMemberId) {
        return jsonResult(
          { error: "Select the member record to link before approving this infant/child/youth request." },
          { status: 422 }
        );
      } else {
        const linked = await validateLinkedMemberForRequest({
          linkedMemberId,
          requestType: request.type,
        });
        if ("error" in linked) {
          return jsonResult({ error: linked.error }, { status: linked.status });
        }
        affectedMemberId = linked.memberId;
        childMemberForParentLink = linked.member;
      }
    }

    if (request.type === "ADULT_REQUEST") {
      if (linkedMemberId && data.createNewMember) {
        return jsonResult(
          { error: "Choose an existing member or create a new member, not both." },
          { status: 422 }
        );
      }

      if (linkedMemberId) {
        const linked = await validateLinkedMemberForRequest({
          linkedMemberId,
          requestType: request.type,
        });
        if ("error" in linked) {
          return jsonResult({ error: linked.error }, { status: linked.status });
        }
        affectedMemberId = linked.memberId;
      } else if (data.createNewMember) {
        if (
          !request.requestedFirstName ||
          !request.requestedLastName ||
          !request.requestedDateOfBirth ||
          !request.requestedEmail
        ) {
          return jsonResult(
            { error: "Adult request is missing required member details." },
            { status: 422 }
          );
        }

        const ageTier = await computeAgeTier(
          request.requestedDateOfBirth,
          getSeasonStartDate(getSeasonYear())
        );
        if (ageTier !== "ADULT") {
          return jsonResult(
            { error: "Requested member is not an adult for the current season." },
            { status: 422 }
          );
        }

        adultMemberCreateData = {
          email: request.requestedEmail.toLowerCase().trim(),
          firstName: request.requestedFirstName.trim(),
          lastName: request.requestedLastName.trim(),
          dateOfBirth: request.requestedDateOfBirth,
          ageTier,
          active: true,
          canLogin: false,
          passwordHash: await hash(randomBytes(32).toString("hex"), 13),
          emailVerified: true,
        };
      } else {
        return jsonResult(
          { error: "Select an existing adult member or choose to create a new non-login adult." },
          { status: 422 }
        );
      }
    }

    if (request.type === "REMOVAL_REQUEST") {
      if (!request.subjectMemberId) {
        return jsonResult(
          { error: "Removal request is missing the member to remove." },
          { status: 422 }
        );
      }
      affectedMemberId = request.subjectMemberId;
    }

    try {
      await prisma.$transaction(async (tx) => {
        if (childMemberCreateData) {
          const created = await tx.member.create({
            data: childMemberCreateData,
            select: { id: true },
          });
          affectedMemberId = created.id;
        }

        if (adultMemberCreateData) {
          const created = await tx.member.create({
            data: adultMemberCreateData,
            select: { id: true },
          });
          affectedMemberId = created.id;
        }

        if (request.type === "CHILD_REQUEST" && childMemberForParentLink) {
          if (
            request.requester.active === false ||
            request.requester.archivedAt ||
            (request.requester.ageTier && request.requester.ageTier !== "ADULT")
          ) {
            throw new ReviewRequestError("Child requests can only be approved for active adult requesters.");
          }
          if (
            (childMemberForParentLink.dependents?.length ?? 0) > 0 ||
            (childMemberForParentLink.secondaryDependents?.length ?? 0) > 0
          ) {
            throw new ReviewRequestError("Selected child member already has dependants.");
          }

          const requesterAlreadyLinked =
            childMemberForParentLink.parentMemberId === request.requesterId ||
            childMemberForParentLink.secondaryParentId === request.requesterId;
          const linkAsSecondary =
            Boolean(childMemberForParentLink.parentMemberId) &&
            childMemberForParentLink.parentMemberId !== request.requesterId;
          if (
            !requesterAlreadyLinked &&
            childMemberForParentLink.parentMemberId &&
            childMemberForParentLink.secondaryParentId
          ) {
            throw new ReviewRequestError("Selected child member already has two parents linked.");
          }

          const parentLinksAfterSave = [
            ...(childMemberForParentLink.parent
              ? [childMemberForParentLink.parent]
              : []),
            ...(childMemberForParentLink.secondaryParent
              ? [childMemberForParentLink.secondaryParent]
              : []),
            {
              id: request.requesterId,
              inheritEmailFromId: request.requester.inheritEmailFromId,
            },
          ];
          const explicitInheritEmailFromId =
            Object.prototype.hasOwnProperty.call(data, "inheritEmailFromId")
              ? data.inheritEmailFromId?.trim() || null
              : request.requesterId;
          const resolvedInheritEmailFromId = resolveParentNotificationSourceId(
            parentLinksAfterSave,
            explicitInheritEmailFromId
          );
          if (resolvedInheritEmailFromId === undefined && explicitInheritEmailFromId) {
            throw new ReviewRequestError("Notification email recipient must be one of the linked parents.");
          }
          if (resolvedInheritEmailFromId) {
            const validation = await validateInheritEmailSource(
              {
                memberId: childMemberForParentLink.id,
                inheritEmailFromId: resolvedInheritEmailFromId,
              },
              tx
            );
            if (!validation.ok) {
              throw new ReviewRequestError(validation.error, validation.status);
            }
          }

          await tx.member.update({
            where: { id: childMemberForParentLink.id },
            data: {
              ...(!requesterAlreadyLinked
                ? linkAsSecondary
                  ? { secondaryParent: { connect: { id: request.requesterId } } }
                  : { parent: { connect: { id: request.requesterId } } }
                : {}),
              inheritParentEmail: Boolean(resolvedInheritEmailFromId),
              inheritEmailFrom: resolvedInheritEmailFromId
                ? { connect: { id: resolvedInheritEmailFromId } }
                : { disconnect: true },
            },
          });
        }

        if (request.type === "REMOVAL_REQUEST") {
          await tx.familyGroupMember.deleteMany({
            where: {
              familyGroupId: request.familyGroupId,
              memberId: affectedMemberId,
            },
          });
        } else {
          await tx.familyGroupMember.upsert({
            where: {
              familyGroupId_memberId: {
                familyGroupId: request.familyGroupId,
                memberId: affectedMemberId,
              },
            },
            create: {
              familyGroupId: request.familyGroupId,
              memberId: affectedMemberId,
              role: "MEMBER",
            },
            update: {},
          });
        }

        await tx.familyGroupJoinRequest.update({
          where: { id: requestId },
          data: {
            status: "APPROVED",
            reviewedAt: new Date(),
            reviewedBy: adminMemberId,
            ...(request.type === "CHILD_REQUEST" || request.type === "ADULT_REQUEST"
              ? { linkedMemberId: affectedMemberId }
              : {}),
          },
        });
      });
    } catch (error) {
      if (error instanceof ReviewRequestError) {
        return jsonResult({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const auditAction =
      request.type === "CHILD_REQUEST"
        ? "FAMILY_GROUP_CHILD_REQUEST_APPROVED"
        : request.type === "ADULT_REQUEST"
          ? "FAMILY_GROUP_ADULT_REQUEST_APPROVED"
          : request.type === "REMOVAL_REQUEST"
            ? "FAMILY_GROUP_REMOVAL_REQUEST_APPROVED"
            : "FAMILY_GROUP_JOIN_APPROVED";

    logAudit({
      action: auditAction,
      memberId: adminMemberId,
      targetId: affectedMemberId,
      subjectMemberId: affectedMemberId,
      entityType: "FamilyGroupJoinRequest",
      entityId: requestId,
      category: "family",
      outcome: "success",
      summary: "Family group request approved",
      details: JSON.stringify({
        familyGroupId: request.familyGroupId,
        requestId,
        requestType: request.type,
        linkedMemberId:
          request.type === "CHILD_REQUEST" || request.type === "ADULT_REQUEST"
            ? affectedMemberId
            : undefined,
      }),
      metadata: {
        familyGroupId: request.familyGroupId,
        requestType: request.type,
        linkedMemberId:
          request.type === "CHILD_REQUEST" || request.type === "ADULT_REQUEST"
            ? affectedMemberId
            : null,
      },
    });

    logger.info(
      {
        requestId,
        requesterId: request.requesterId,
        familyGroupId: request.familyGroupId,
        requestType: request.type,
        affectedMemberId,
      },
      "Family group request approved"
    );

    if (request.type === "CHILD_REQUEST" && request.requester) {
      const childName = getRequestName(request);
      sendChildRequestApprovedEmail(
        request.requester.email,
        request.requester.firstName,
        childName || "your child",
        request.familyGroup?.name ?? "your family group"
      ).catch((err) => {
        logger.error({ err, requestId }, "Failed to send child request approved email");
      });
    }
  } else {
    await prisma.familyGroupJoinRequest.update({
      where: { id: requestId },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewedBy: adminMemberId,
      },
    });

    const auditAction =
      request.type === "CHILD_REQUEST"
        ? "FAMILY_GROUP_CHILD_REQUEST_REJECTED"
        : request.type === "ADULT_REQUEST"
          ? "FAMILY_GROUP_ADULT_REQUEST_REJECTED"
          : request.type === "REMOVAL_REQUEST"
            ? "FAMILY_GROUP_REMOVAL_REQUEST_REJECTED"
            : "FAMILY_GROUP_JOIN_REJECTED";

    logAudit({
      action: auditAction,
      memberId: adminMemberId,
      targetId: request.subjectMemberId ?? request.requesterId,
      subjectMemberId: request.subjectMemberId ?? request.requesterId,
      entityType: "FamilyGroupJoinRequest",
      entityId: requestId,
      category: "family",
      outcome: "success",
      summary: "Family group request rejected",
      details: JSON.stringify({
        familyGroupId: request.familyGroupId,
        requestId,
        requestType: request.type,
        rejectionReason: rejectionReason || undefined,
      }),
      metadata: {
        familyGroupId: request.familyGroupId,
        requestType: request.type,
        rejectionReason: rejectionReason || null,
      },
    });

    logger.info(
      { requestId, requesterId: request.requesterId, requestType: request.type },
      "Family group request rejected"
    );

    if (request.type === "CHILD_REQUEST" && request.requester) {
      const childName = getRequestName(request);
      sendChildRequestRejectedEmail(
        request.requester.email,
        request.requester.firstName,
        childName || "your child",
        rejectionReason || undefined
      ).catch((err) => {
        logger.error({ err, requestId }, "Failed to send child request rejected email");
      });
    }
  }

  return jsonResult({ success: true, action });
}
