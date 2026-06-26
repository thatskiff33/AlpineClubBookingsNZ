import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { getSeasonYear } from "@/lib/utils";
import {
  getXeroContactGroupMemberships,
  isXeroConnected,
  syncManagedXeroContactGroupForMember,
  updateXeroContact,
} from "@/lib/xero";
import {
  buildXeroContactUpdatePayload,
  hasMemberXeroContactChanges,
  shouldRepairXeroContactNameOrder,
} from "@/lib/xero-contact-sync";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import logger from "@/lib/logger";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
import {
  copyStreetAddressToPostal,
  POSTAL_ADDRESS_FIELDS,
} from "@/lib/member-address";
import { validateInheritEmailSource } from "@/lib/member-email-inheritance";
import { buildParentLinks } from "@/lib/member-parent-links";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import { getAssignedPromoCodeSummariesForMember } from "@/lib/promo";
import {
  buildMemberAuditLogWhere,
  getAuditLogActorMemberId,
} from "@/lib/audit-query";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditEmailDomain,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  getMemberArchiveLifecycleRequests,
  getMemberDeleteEligibility,
  getMemberDeleteLifecycleRequests,
} from "@/lib/member-lifecycle-actions";
import { nameField } from "@/lib/zod-helpers";
import { genderEnum, titleEnum } from "@/lib/member-enums";

const maxStr = (len: number) => z.string().max(len).optional().nullable();

type JsonRouteResult = {
  body: unknown;
  init?: ResponseInit;
};

function jsonResult(body: unknown, init?: ResponseInit): JsonRouteResult {
  return { body, init };
}

export const updateMemberSchema = z.object({
  title: titleEnum.optional().nullable(),
  firstName: nameField({ required: "First name is required" }).optional(),
  lastName: nameField({ required: "Last name is required" }).optional(),
  gender: genderEnum.optional().nullable(),
  occupation: z.string().max(100).optional().nullable().or(z.literal("")),
  email: z.string().email("Invalid email address").optional(),
  phoneCountryCode: z.string().max(5).optional().nullable(),
  phoneAreaCode: z.string().max(5).optional().nullable(),
  phoneNumber: z.string().max(15).optional().nullable(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format")
    .optional()
    .nullable()
    .or(z.literal("")),
  role: z.enum(["MEMBER", "ADMIN", "LODGE", "ASSOCIATE", "LIFE"]).optional(),
  financeAccessLevel: z.enum(["NONE", "VIEWER", "MANAGER"]).optional(),
  ageTier: z.enum(["ADULT", "YOUTH", "CHILD", "INFANT"]).optional(),
  active: z.boolean().optional(),
  canLogin: z.boolean().optional(),
  forcePasswordChange: z.boolean().optional(),
  requiresInduction: z.boolean().optional(),
  inheritEmailFromId: z.string().optional().nullable().or(z.literal("")),
  joinedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format")
    .optional()
    .nullable()
    .or(z.literal("")),
  lifeMemberDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format")
    .optional()
    .nullable()
    .or(z.literal("")),
  comments: z.string().max(4000).optional().nullable().or(z.literal("")),
  // Addresses
  streetAddressLine1: maxStr(200),
  streetAddressLine2: maxStr(200),
  streetCity: maxStr(200),
  streetRegion: maxStr(200),
  streetPostalCode: maxStr(20),
  streetCountry: maxStr(100),
  postalAddressLine1: maxStr(200),
  postalAddressLine2: maxStr(200),
  postalCity: maxStr(200),
  postalRegion: maxStr(200),
  postalPostalCode: maxStr(20),
  postalCountry: maxStr(100),
  postalSameAsPhysical: z.boolean().optional(),
});

export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

const PHONE_FIELDS = [
  "phoneCountryCode",
  "phoneAreaCode",
  "phoneNumber",
] as const;
const ADDRESS_FIELDS = [
  "streetAddressLine1",
  "streetAddressLine2",
  "streetCity",
  "streetRegion",
  "streetPostalCode",
  "streetCountry",
  "postalAddressLine1",
  "postalAddressLine2",
  "postalCity",
  "postalRegion",
  "postalPostalCode",
  "postalCountry",
] as const;
const ADMIN_MEMBER_AUDIT_FIELDS = [
  "title",
  "firstName",
  "lastName",
  "gender",
  "occupation",
  "email",
  ...PHONE_FIELDS,
  ...ADDRESS_FIELDS,
  "dateOfBirth",
  "ageTier",
  "joinedDate",
  "lifeMemberDate",
  "role",
  "financeAccessLevel",
  "active",
  "canLogin",
  "forcePasswordChange",
  "requiresInduction",
  "comments",
  "inheritEmailFromId",
] as const;
const ADMIN_MEMBER_ACCESS_FIELDS = [
  "role",
  "financeAccessLevel",
  "active",
  "canLogin",
  "forcePasswordChange",
] as const;

function normalizeAuditValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (value === undefined || value === "") {
    return null;
  }
  return value;
}

function getChangedFields(
  before: Record<string, unknown>,
  updateData: Record<string, unknown>,
  fields: readonly string[],
): string[] {
  return fields.filter((field) => {
    if (!Object.prototype.hasOwnProperty.call(updateData, field)) {
      return false;
    }
    return (
      normalizeAuditValue(before[field]) !==
      normalizeAuditValue(updateData[field])
    );
  });
}

function hasAnyField(
  changedFields: readonly string[],
  fields: readonly string[],
): boolean {
  return fields.some((field) => changedFields.includes(field));
}

function buildAccessChanges(
  before: Record<string, unknown>,
  updateData: Record<string, unknown>,
  changedFields: readonly string[],
) {
  return ADMIN_MEMBER_ACCESS_FIELDS.filter((field) =>
    changedFields.includes(field),
  ).map((field) => ({
    field,
    before: before[field],
    after: updateData[field],
  }));
}

function getAdminMemberAuditAction(
  before: Record<string, unknown>,
  updateData: Record<string, unknown>,
): { action: string; summary: string } {
  if (
    Object.prototype.hasOwnProperty.call(updateData, "active") &&
    before.active !== updateData.active
  ) {
    if (updateData.active === false) {
      return {
        action: "admin.member.deactivated",
        summary: "Member deactivated by admin",
      };
    }
    if (updateData.active === true) {
      return {
        action: "admin.member.reactivated",
        summary: "Member reactivated by admin",
      };
    }
  }

  return {
    action: "admin.member.updated",
    summary: "Member updated by admin",
  };
}

export async function getAdminMemberDetail(params: {
  id: string;
  currentAdminMemberId: string;
}): Promise<JsonRouteResult> {
  const { id, currentAdminMemberId } = params;

  const [
    member,
    bookings,
    auditLogs,
    stats,
    assignedPromoCodes,
    archiveLifecycleActionRequests,
    openCancellationParticipant,
  ] = await Promise.all([
    prisma.member.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        firstName: true,
        lastName: true,
        gender: true,
        email: true,
        phoneCountryCode: true,
        phoneAreaCode: true,
        phoneNumber: true,
        dateOfBirth: true,
        role: true,
        financeAccessLevel: true,
        ageTier: true,
        active: true,
        canLogin: true,
        forcePasswordChange: true,
        parentMemberId: true,
        secondaryParentId: true,
        inheritParentEmail: true,
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
        inheritEmailFrom: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        xeroContactId: true,
        joinedDate: true,
        lifeMemberDate: true,
        occupation: true,
        requiresInduction: true,
        cancelledAt: true,
        cancelledReason: true,
        comments: true,
        archivedAt: true,
        archivedReason: true,
        archivedViaLifecycleActionRequestId: true,
        createdAt: true,
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
        familyGroupMemberships: {
          select: {
            familyGroupId: true,
            familyGroup: { select: { id: true, name: true } },
          },
        },
        subscriptions: {
          orderBy: { seasonYear: "desc" },
        },
        dependents: {
          orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
          select: {
            id: true,
            firstName: true,
            lastName: true,
            ageTier: true,
            active: true,
            dateOfBirth: true,
            canLogin: true,
          },
        },
        secondaryDependents: {
          orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
          select: {
            id: true,
            firstName: true,
            lastName: true,
            ageTier: true,
            active: true,
            dateOfBirth: true,
            canLogin: true,
          },
        },
      },
    }),
    prisma.booking.findMany({
      where: { memberId: id, deletedAt: null },
      orderBy: { checkIn: "desc" },
      select: {
        id: true,
        checkIn: true,
        checkOut: true,
        status: true,
        finalPriceCents: true,
        _count: { select: { guests: true } },
      },
    }),
    prisma.auditLog.findMany({
      where: buildMemberAuditLogWhere(id),
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.booking.aggregate({
      where: {
        memberId: id,
        deletedAt: null,
        status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
      },
      _sum: { finalPriceCents: true },
      _count: true,
      _max: { checkOut: true },
    }),
    getAssignedPromoCodeSummariesForMember(id),
    getMemberArchiveLifecycleRequests(id),
    prisma.membershipCancellationRequestParticipant.findFirst({
      where: {
        memberId: id,
        status: { in: ["REQUESTED", "PENDING_CONFIRMATION", "APPROVED"] },
        request: { status: { in: ["REQUESTED", "APPROVED"] } },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        createdAt: true,
        confirmedAt: true,
        request: {
          select: {
            id: true,
            status: true,
            reason: true,
            submittedAt: true,
            requestedByMemberId: true,
            requestedBy: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
      },
    }),
  ]);

  if (!member) {
    return jsonResult({ error: "Member not found" }, { status: 404 });
  }

  const [deleteEligibility, deleteLifecycleActionRequests] = await Promise.all([
    getMemberDeleteEligibility({
      memberId: id,
      currentAdminMemberId,
    }),
    getMemberDeleteLifecycleRequests(id),
  ]);
  const lifecycleActionRequests = [
    ...deleteLifecycleActionRequests,
    ...archiveLifecycleActionRequests,
  ].sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));

  const actorIds = Array.from(
    new Set(
      auditLogs
        .map((log) => getAuditLogActorMemberId(log))
        .filter((memberId): memberId is string => Boolean(memberId)),
    ),
  );
  const auditActors =
    actorIds.length > 0
      ? await prisma.member.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, firstName: true, lastName: true, email: true },
        })
      : [];
  const auditActorById = new Map(auditActors.map((actor) => [actor.id, actor]));
  const auditLogsWithActors = auditLogs.map((log) => {
    const actorMemberId = getAuditLogActorMemberId(log);
    return {
      ...log,
      actor: actorMemberId ? (auditActorById.get(actorMemberId) ?? null) : null,
    };
  });

  let xeroContactGroups: Array<{ id: string; name: string }> = [];
  let xeroContactGroupsLoaded = !member.xeroContactId;
  if (member.xeroContactId) {
    try {
      const memberships = await getXeroContactGroupMemberships([
        member.xeroContactId,
      ]);
      xeroContactGroups = memberships[member.xeroContactId] ?? [];
      xeroContactGroupsLoaded = Object.prototype.hasOwnProperty.call(
        memberships,
        member.xeroContactId,
      );
    } catch (error) {
      const xeroError = getXeroApiErrorInfo(
        error,
        "Failed to fetch Xero contact groups for member detail",
      );
      if (!xeroError.handled) {
        logger.error(
          { err: error, memberId: id },
          "Failed to fetch Xero contact groups for member detail",
        );
      }
    }
  }

  return jsonResult({
    ...member,
    parentLinks: buildParentLinks(member),
    dependents: [
      ...(member.dependents ?? []).map((dependent) => ({
        ...dependent,
        parentLinkType: "PRIMARY" as const,
      })),
      ...(member.secondaryDependents ?? [])
        .filter(
          (dependent) =>
            !(member.dependents ?? []).some(
              (primary) => primary.id === dependent.id,
            ),
        )
        .map((dependent) => ({
          ...dependent,
          parentLinkType: "SECONDARY" as const,
        })),
    ],
    secondaryDependents: undefined,
    familyGroups: member.familyGroupMemberships.map((fg) => ({
      id: fg.familyGroup.id,
      name: fg.familyGroup.name,
    })),
    familyGroupMemberships: undefined,
    bookings,
    promoCodes: assignedPromoCodes,
    auditLogs: auditLogsWithActors,
    xeroContactGroups,
    xeroContactGroupsLoaded,
    deleteEligibility,
    lifecycleActionRequests,
    openCancellationRequest: openCancellationParticipant
      ? {
          id: openCancellationParticipant.request.id,
          status: openCancellationParticipant.request.status,
          reason: openCancellationParticipant.request.reason,
          submittedAt:
            openCancellationParticipant.request.submittedAt.toISOString(),
          participantId: openCancellationParticipant.id,
          participantStatus: openCancellationParticipant.status,
          requestedBy: openCancellationParticipant.request.requestedBy
            ? {
                id: openCancellationParticipant.request.requestedBy.id,
                name:
                  `${openCancellationParticipant.request.requestedBy.firstName} ${openCancellationParticipant.request.requestedBy.lastName}`.trim() ||
                  openCancellationParticipant.request.requestedBy.email,
                email: openCancellationParticipant.request.requestedBy.email,
              }
            : null,
          requestedByCurrentAdmin:
            openCancellationParticipant.request.requestedByMemberId ===
            currentAdminMemberId,
        }
      : null,
    stats: {
      totalBookings: stats._count,
      totalSpendCents: stats._sum.finalPriceCents || 0,
      lastStay: stats._max.checkOut || null,
    },
  });
}

export async function updateAdminMember(params: {
  id: string;
  currentAdminMemberId: string;
  request: NextRequest;
  data: UpdateMemberInput;
}): Promise<JsonRouteResult> {
  const { id, currentAdminMemberId, request: req, data } = params;
  const existing = await prisma.member.findUnique({ where: { id } });
  if (!existing) {
    return jsonResult({ error: "Member not found" }, { status: 404 });
  }

  if (id === currentAdminMemberId) {
    if (data.role === "MEMBER") {
      return jsonResult(
        { error: "You cannot demote your own admin account" },
        { status: 400 },
      );
    }

    if (data.active === false) {
      return jsonResult(
        { error: "You cannot deactivate your own account" },
        { status: 400 },
      );
    }

    if (data.canLogin === false) {
      return jsonResult(
        { error: "You cannot disable login for your own admin account" },
        { status: 400 },
      );
    }
  }

  if (
    (existing.archivedAt || existing.cancelledAt) &&
    (data.active === true || data.canLogin === true)
  ) {
    return jsonResult(
      {
        error: existing.archivedAt
          ? "Archived members cannot be reactivated from member edit"
          : "Cancelled members cannot be reactivated from member edit",
      },
      { status: 409 },
    );
  }

  // Check email uniqueness if changing email for a canLogin member
  const effectiveCanLogin =
    data.canLogin !== undefined ? data.canLogin : existing.canLogin;
  if (
    data.email &&
    data.email.toLowerCase() !== existing.email &&
    effectiveCanLogin
  ) {
    const emailTaken = await prisma.member.findFirst({
      where: {
        email: data.email.toLowerCase(),
        canLogin: true,
        id: { not: id },
      },
    });
    if (emailTaken) {
      return jsonResult(
        { error: "A member with this email already exists" },
        { status: 409 },
      );
    }
  }

  if (data.inheritEmailFromId !== undefined && data.inheritEmailFromId !== "") {
    const inheritEmailFromId = data.inheritEmailFromId?.trim();
    if (inheritEmailFromId) {
      const validation = await validateInheritEmailSource({
        memberId: id,
        inheritEmailFromId,
      });
      if (!validation.ok) {
        return jsonResult(
          { error: validation.error },
          { status: validation.status },
        );
      }
    }
  }

  // Build update data
  const updateData: Record<string, unknown> = {};
  if (data.title !== undefined) updateData.title = data.title ?? null;
  if (data.firstName !== undefined)
    updateData.firstName = data.firstName.trim();
  if (data.lastName !== undefined) updateData.lastName = data.lastName.trim();
  if (data.gender !== undefined) updateData.gender = data.gender ?? null;
  if (data.occupation !== undefined)
    updateData.occupation = data.occupation?.trim() || null;
  for (const f of PHONE_FIELDS) {
    if (data[f] !== undefined) updateData[f] = data[f]?.trim() || null;
  }
  for (const f of ADDRESS_FIELDS) {
    if (data[f] !== undefined) updateData[f] = data[f]?.trim() || null;
  }
  if (data.role !== undefined) updateData.role = data.role;
  const effectiveRole = data.role ?? existing.role;
  if (effectiveRole === "LODGE") {
    updateData.financeAccessLevel = "NONE";
  } else if (data.financeAccessLevel !== undefined) {
    updateData.financeAccessLevel = data.financeAccessLevel;
  }
  if (data.active !== undefined) updateData.active = data.active;
  if (data.canLogin !== undefined) updateData.canLogin = data.canLogin;
  if (data.forcePasswordChange !== undefined)
    updateData.forcePasswordChange = data.forcePasswordChange;
  if (data.requiresInduction !== undefined)
    updateData.requiresInduction = data.requiresInduction;
  if (data.inheritEmailFromId !== undefined) {
    updateData.inheritEmailFromId = data.inheritEmailFromId?.trim() || null;
  }

  if (data.postalSameAsPhysical) {
    const copiedPostalAddress = copyStreetAddressToPostal({
      streetAddressLine1: data.streetAddressLine1,
      streetAddressLine2: data.streetAddressLine2,
      streetCity: data.streetCity,
      streetRegion: data.streetRegion,
      streetPostalCode: data.streetPostalCode,
      streetCountry: data.streetCountry,
    });

    for (const field of POSTAL_ADDRESS_FIELDS) {
      updateData[field] = copiedPostalAddress[field]?.trim() || null;
    }
  }

  // Handle email
  if (data.email !== undefined) {
    updateData.email = data.email.toLowerCase().trim();
  }

  // Handle joinedDate
  if (data.joinedDate !== undefined) {
    if (data.joinedDate && data.joinedDate !== "") {
      const jd = new Date(data.joinedDate);
      if (isNaN(jd.getTime())) {
        return jsonResult({ error: "Invalid joined date" }, { status: 422 });
      }
      updateData.joinedDate = jd;
    } else {
      updateData.joinedDate = null;
    }
  }

  if (data.lifeMemberDate !== undefined) {
    if (data.lifeMemberDate && data.lifeMemberDate !== "") {
      const lmd = new Date(data.lifeMemberDate);
      if (isNaN(lmd.getTime())) {
        return jsonResult(
          { error: "Invalid life member date" },
          { status: 422 },
        );
      }
      updateData.lifeMemberDate = lmd;
    } else {
      updateData.lifeMemberDate = null;
    }
  }

  if (data.comments !== undefined) {
    updateData.comments = data.comments?.trim() || null;
  }

  // Handle DOB and age tier
  if (data.dateOfBirth !== undefined) {
    if (data.dateOfBirth && data.dateOfBirth !== "") {
      const dob = new Date(data.dateOfBirth);
      if (isNaN(dob.getTime())) {
        return jsonResult({ error: "Invalid date of birth" }, { status: 422 });
      }
      updateData.dateOfBirth = dob;
      updateData.ageTier = await computeAgeTier(
        dob,
        getSeasonStartDate(getSeasonYear()),
      );
    } else {
      updateData.dateOfBirth = null;
      // Use explicit ageTier if provided, otherwise keep existing
      if (data.ageTier) updateData.ageTier = data.ageTier;
    }
  } else if (data.ageTier !== undefined) {
    updateData.ageTier = data.ageTier;
  }

  try {
    const existingAuditRecord = existing as unknown as Record<string, unknown>;
    const changedFields = getChangedFields(
      existingAuditRecord,
      updateData,
      ADMIN_MEMBER_AUDIT_FIELDS,
    );
    const accessChanges = buildAccessChanges(
      existingAuditRecord,
      updateData,
      changedFields,
    );
    const auditAction = getAdminMemberAuditAction(
      existingAuditRecord,
      updateData,
    );
    const [updated] = await prisma.$transaction([
      prisma.member.update({
        where: { id },
        data: updateData,
        select: {
          id: true,
          title: true,
          firstName: true,
          lastName: true,
          gender: true,
          occupation: true,
          email: true,
          phoneCountryCode: true,
          phoneAreaCode: true,
          phoneNumber: true,
          dateOfBirth: true,
          role: true,
          financeAccessLevel: true,
          ageTier: true,
          active: true,
          canLogin: true,
          parentMemberId: true,
          secondaryParentId: true,
          inheritParentEmail: true,
          inheritEmailFromId: true,
          xeroContactId: true,
          joinedDate: true,
          lifeMemberDate: true,
          requiresInduction: true,
          cancelledAt: true,
          comments: true,
          createdAt: true,
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
      }),
      prisma.auditLog.create(
        buildStructuredAuditLogCreateArgs({
          action: auditAction.action,
          actor: { memberId: currentAdminMemberId },
          subject: { memberId: id },
          entity: { type: "Member", id },
          category: "admin",
          severity: "critical",
          outcome: "success",
          summary: auditAction.summary,
          metadata: {
            changedFields,
            changedFieldCount: changedFields.length,
            fieldGroups: {
              name: hasAnyField(changedFields, ["firstName", "lastName"]),
              title: changedFields.includes("title"),
              gender: changedFields.includes("gender"),
              occupation: changedFields.includes("occupation"),
              email: changedFields.includes("email"),
              phone: hasAnyField(changedFields, PHONE_FIELDS),
              address: hasAnyField(changedFields, ADDRESS_FIELDS),
              access: accessChanges.length > 0,
              dateOfBirth: changedFields.includes("dateOfBirth"),
              ageTier: changedFields.includes("ageTier"),
              joinedDate: changedFields.includes("joinedDate"),
              lifeMemberDate: changedFields.includes("lifeMemberDate"),
              comments: changedFields.includes("comments"),
              emailInheritance: changedFields.includes("inheritEmailFromId"),
            },
            accessChanges,
            emailChange: changedFields.includes("email")
              ? {
                  changed: true,
                  oldDomain: getAuditEmailDomain(existing.email),
                  newDomain: getAuditEmailDomain(
                    typeof updateData.email === "string"
                      ? updateData.email
                      : null,
                  ),
                }
              : undefined,
          },
          request: getAuditRequestContext(req),
        }),
      ),
    ]);

    const hasMappedContactUpdate = updated.xeroContactId
      ? hasMemberXeroContactChanges(existing, updated)
      : false;
    const shouldRepairContactNameOrder = updated.xeroContactId
      ? await shouldRepairXeroContactNameOrder(updated)
      : false;
    const needsContactUpdate = Boolean(
      updated.xeroContactId &&
      (hasMappedContactUpdate || shouldRepairContactNameOrder),
    );
    const needsContactGroupSync =
      updated.xeroContactId && existing.ageTier !== updated.ageTier;

    if (
      updated.xeroContactId &&
      (needsContactUpdate || needsContactGroupSync)
    ) {
      try {
        if (await isXeroConnected()) {
          if (needsContactUpdate) {
            await updateXeroContact(
              updated.xeroContactId,
              buildXeroContactUpdatePayload(updated),
              {
                localModel: "Member",
                localId: id,
                createdByMemberId: currentAdminMemberId,
                preserveXeroName: !shouldRepairContactNameOrder,
              },
            );
          }

          if (needsContactGroupSync) {
            await syncManagedXeroContactGroupForMember(id, {
              createdByMemberId: currentAdminMemberId,
            });
          }
        }
      } catch (xeroErr) {
        logger.error(
          { err: xeroErr, memberId: id },
          "Xero sync failed for member update",
        );
      }
    }

    return jsonResult(updated);
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      return jsonResult(
        { error: "A member with this email already exists" },
        { status: 409 },
      );
    }

    logger.error({ err: error, memberId: id }, "Failed to update member");
    return jsonResult({ error: "Failed to update member" }, { status: 500 });
  }
}
