import { NextRequest } from "next/server";
import type { AgeTier } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { enqueueHostingCoverageReevaluationForMember } from "@/lib/adult-member-hosting-review";
import {
  HOSTING_COVERAGE_RETRY_BODY,
  isHostingCoverageParticipantRetry,
} from "@/lib/adult-member-hosting-queue-participants";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { clubToday, dateOnlyInstantOf, parseCalendarDate } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { clubSeasonYear } from "@/lib/financial-year";
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
import {
  findMemberContactChangeMergeBlocker,
  getMemberContactCreateRecoveryState,
} from "@/lib/xero-contact-create-recovery";
import logger from "@/lib/logger";
import {
  copyStreetAddressToPostal,
  POSTAL_ADDRESS_FIELDS,
} from "@/lib/member-address";
import {
  isLoginEmailUniqueConflict,
  MEMBER_LOGIN_EMAIL_TAKEN_MESSAGE,
} from "@/lib/member-email";
import {
  reconcileEmailInheritanceForMemberChange,
  validateInheritEmailSource,
} from "@/lib/member-email-inheritance";
import {
  buildParentLinks,
  resolveInheritedEmailSourceId,
} from "@/lib/member-parent-links";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import { getAssignedPromoCodeSummariesForMember } from "@/lib/promo";
import { getFamilyBillingMode } from "@/lib/authoritative-fees";
import {
  buildMemberAuditLogWhere,
  getAuditLogActorMemberId,
} from "@/lib/audit-query";
import {
  committeeAssignmentSelect,
  serializeCommitteeAssignment,
} from "@/lib/committee";
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
import { genderEnum, titleEnum } from "@/lib/member-enums-schema";
import { ROLE_VALUES } from "@/lib/member-roles";
import {
  defaultMembershipTypeKeyForRole,
  membershipTypeAgeExemption,
} from "@/lib/membership-types";
import {
  LINKED_GUEST_NOT_APPLICABLE_BLOCK_MESSAGE,
  loadFutureLinkedGuestBookingsForMember,
  loadMemberCurrentSeasonTypeExemption,
  resolveEnforcedAgeTier,
  summarizeFutureLinkedGuestBookings,
} from "@/lib/age-tier-enforcement";
import { formatDateOnly } from "@/lib/date-only";
import {
  accessRoleChangeRequiresFullAdmin,
  accessRolesFromCompatibilityFields,
  hasPrivilegedAccess,
  isFullAdmin,
  isOrganisationMember,
  legacyRoleFromAccessRoles,
  memberHoldsPrivilegedRole,
  normalizeAssignableAccessRoleTokens,
  resolveAccessRoleTokens,
  storedAccessRolesForFullAdminGate,
  type AccessRoleInput,
} from "@/lib/access-roles";
import {
  AdminAccountGuardError,
  LAST_FULL_ADMIN_GUARD_MESSAGE,
  PRIVILEGED_TARGET_GUARD_MESSAGE,
  wouldRemoveLastFullAdmin,
} from "@/lib/admin-account-guards";
import {
  accessRoleAssignmentRowsFromTokens,
  findUnknownAccessRoleTokens,
  loadAccessRoleDefinitions,
  MEMBER_ACCESS_ROLE_SELECT,
  type AccessRoleDefinitionRecord,
} from "@/lib/access-role-definitions";
import {
  financeAccessLevelFromMatrix,
  getAdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { serializeSeasonalMembershipAssignment } from "@/lib/seasonal-membership-assignments";
import {
  acquireFuturePartnerSharedAllocationLocks,
  describePartnerSharedSweepReason,
  partnerShareSweepCounterpartNames,
  partnerShareSweepNights,
  sweepFuturePartnerSharedAllocationsWithLocksHeld,
  type SweptPartnerSharedAllocation,
} from "@/lib/bed-allocation-lifecycle";
import { sendAdminPartnerShareSweptAlert } from "@/lib/email";
import { acquireMemberLifecycleLocks } from "@/lib/member-lifecycle-lock";
import {
  DELETED_ACCOUNT_EDIT_REACTIVATE_MESSAGE,
  isDeletedAccountRecord,
} from "@/lib/deleted-account";

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
  role: z.enum(ROLE_VALUES).optional(),
  financeAccessLevel: z.enum(["NONE", "VIEWER", "MANAGER"]).optional(),
  // Role tokens: enum values for system roles/seeded bundles, definition
  // ids for custom roles. Validated against the definitions table on write.
  accessRoles: z.array(z.string().trim().min(1).max(120)).optional(),
  ageTier: z
    .enum(["ADULT", "YOUTH", "CHILD", "INFANT", "NOT_APPLICABLE"])
    .optional(),
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
  "accessRoles",
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
  "accessRoles",
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

function resolveWriteAccessRoleTokens(input: {
  accessRoles?: string[] | null;
  role?: string | null;
  financeAccessLevel?: string | null;
  canLogin?: boolean | null;
}): string[] {
  if (input.accessRoles) {
    return normalizeAssignableAccessRoleTokens(input.accessRoles, {
      canLogin: input.canLogin,
    });
  }

  return accessRolesFromCompatibilityFields({
    role: input.role,
    financeAccessLevel: input.financeAccessLevel,
    canLogin: input.canLogin,
  });
}

function sameAccessRoleSet(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
) {
  return a.length === b.length && a.every((role) => b.includes(role));
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
    // #2282: WHICH ADULT a dependant added under this member would actually
    // reach. Parentage is now recordable at any age, but being the club's
    // contact of record stays adult-only, so for a young parent the mail routes
    // PAST them to the nearest usable ancestor. That has to be on screen BEFORE
    // the admin adds the dependant, not discovered afterwards from a stored
    // pointer naming someone they never chose. Resolved with the same walk both
    // write paths use, so the page states exactly what the write will store
    // rather than a lookalike one-hop guess; a null `sourceId` means no ancestor
    // in reach can receive mail, which is the 422 those writes return.
    //
    // WHAT IT COSTS, stated accurately (#2282 review corrected an earlier
    // "adds no serial round-trip" here). It joins this `Promise.all` because it
    // needs only the route param, so it adds no round-trip to the page's own
    // critical path — but it is a WALK, not a query: one `findMany` per
    // generation, plus a `findUnique` for any row carrying a stored pointer,
    // bounded by the four-generation cap. The summary read below is a further
    // `await` AFTER this block for the uncommon case where the source is
    // somebody else. Bounded and not an N+1, but every admin member-detail view
    // now pays a walk that used to run only on writes.
    dependentEmailSourceResolution,
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
        accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
        ageTier: true,
        active: true,
        // Member profile photo (MP4, epic #171) — surfaced so an admin can
        // view/manage it on the member-detail page; spread through `...member`
        // into the response body below.
        photoImageId: true,
        photoUpdatedAt: true,
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
        // Per-member billing family selection (#1932, E6).
        billingFamilyGroupId: true,
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
        seasonalMembershipAssignments: {
          orderBy: { seasonYear: "desc" },
          include: {
            membershipType: {
              select: {
                id: true,
                key: true,
                name: true,
                description: true,
                isActive: true,
                isBuiltIn: true,
                bookingBehavior: true,
                subscriptionBehavior: true,
                sortOrder: true,
                // #2106: drives whether the age-tier picker offers/forces N/A.
                allowedAgeTiers: { select: { ageTier: true } },
              },
            },
          },
        },
        committeeAssignments: {
          orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }],
          select: committeeAssignmentSelect,
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
    resolveInheritedEmailSourceId(prisma, id),
  ]);

  if (!member) {
    return jsonResult({ error: "Member not found" }, { status: 404 });
  }

  const [
    deleteEligibility,
    deleteLifecycleActionRequests,
    xeroContactCreateRecoveryState,
    xeroContactLifecycleBlocker,
  ] = await Promise.all([
    getMemberDeleteEligibility({
      memberId: id,
      currentAdminMemberId,
    }),
    getMemberDeleteLifecycleRequests(id),
    getMemberContactCreateRecoveryState({
      memberId: id,
      xeroContactId: member.xeroContactId,
    }),
    // #2623 T7: the SAME reader member merge and account deletion refuse on.
    // The create-recovery state above deliberately reports nothing once the
    // member is linked, so on its own it let a linked-but-still-blocked member
    // look completely clean here while both lifecycle operations refused them.
    findMemberContactChangeMergeBlocker(id),
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

  // Club billing mode drives whether the per-member billing-family selector is
  // editable on the member detail family card (#1932, E6).
  const familyBillingMode = await getFamilyBillingMode();

  // #2282: the summary for the adult resolved above. Only a second read when
  // the source is somebody else — the ordinary case, an adult who is their own
  // source, is answered from the row already in hand.
  const dependentEmailSourceId = dependentEmailSourceResolution.sourceId;
  const dependentEmailSource = dependentEmailSourceId
    ? dependentEmailSourceId === member.id
      ? {
          id: member.id,
          firstName: member.firstName,
          lastName: member.lastName,
          email: member.email,
        }
      : await prisma.member.findUnique({
          where: { id: dependentEmailSourceId },
          select: { id: true, firstName: true, lastName: true, email: true },
        })
    : null;

  // ONE read of the club's current season for this whole payload, from the
  // club's PERSISTED zone rather than the container's month (CT-4, #2870;
  // INV-CONFIG-002). Two separate reads could straddle midnight in the club's
  // zone and describe two different seasons three lines apart on one screen,
  // which is the shape group D found on the admin dashboard.
  const currentSeasonYear = clubSeasonYear(
    await readClubTimeZoneOutsideRequest(),
  );

  return jsonResult({
    ...member,
    dependentEmailSource,
    familyBillingMode,
    accessRoles: resolveAccessRoleTokens(member),
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
    currentSeasonYear,
    // #2106: age-exemption of the member's CURRENT-season membership type, so
    // the edit dialog can force/allow/omit the N/A age tier. null when the
    // member has no current-season assignment.
    currentSeasonAgeExemption: (() => {
      const current = (member.seasonalMembershipAssignments ?? []).find(
        (assignment) => assignment.seasonYear === currentSeasonYear,
      );
      if (!current) return null;
      return membershipTypeAgeExemption(
        (
          (current.membershipType as { allowedAgeTiers?: Array<{ ageTier: AgeTier }> })
            .allowedAgeTiers ?? []
        ).map((tier) => tier.ageTier),
      );
    })(),
    seasonalMembershipAssignments: (
      member.seasonalMembershipAssignments ?? []
    ).map((assignment) => serializeSeasonalMembershipAssignment(assignment)),
    committeeAssignments: (member.committeeAssignments ?? []).map((assignment) =>
      serializeCommitteeAssignment(assignment),
    ),
    bookings,
    promoCodes: assignedPromoCodes,
    auditLogs: auditLogsWithActors,
    xeroContactGroups,
    xeroContactGroupsLoaded,
    xeroContactCreateRecoveryState,
    xeroContactCreateRecoveryPending:
      xeroContactCreateRecoveryState === "PROVIDER_CREATED_LINK_PENDING",
    xeroContactLifecycleBlocker,
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
  currentAdminAccessRoles: AccessRoleInput["accessRoles"];
  request: NextRequest;
  data: UpdateMemberInput;
}): Promise<JsonRouteResult> {
  const {
    id,
    currentAdminMemberId,
    currentAdminAccessRoles,
    request: req,
    data,
  } = params;
  // The club's PERSISTED zone (CT-4, #2870), read ONCE for this whole request
  // and threaded from here. The restore season below and the linked-guest date
  // bound further down both derive from this binding rather than re-reading it,
  // so nothing on this path can judge one member against two different days
  // (#3123). The runtime reader is the right one here because the file already
  // uses it, and two readers in one function would be worse than one extra
  // settings query.
  const clubZone = await readClubTimeZoneOutsideRequest();
  const clubCurrentSeasonYear = clubSeasonYear(clubZone);
  // The club's today, derived from that one zone and computed ONCE, as the
  // UTC-midnight `@db.Date` encoding (`INV-DATE-026`). Every consumer below
  // takes this value: the linked-guest bound, the partner-share lock prefix,
  // the sweep and the hosting fan-out. Three of those run inside the
  // transaction further down, holding the global cohort key, the affected
  // lodge keys and the member lifecycle keys, where `INV-LOCK-004` forbids
  // resolving the club timezone at all — and computing the day twice on one
  // path could straddle club midnight even when the zone is already in hand.
  const clubTodayDateOnly = dateOnlyInstantOf(clubToday(clubZone));
  const [existing, roleDefinitions, currentSeasonTypeExemption] =
    await Promise.all([
      prisma.member.findUnique({
        where: { id },
        include: { accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT } },
      }),
      loadAccessRoleDefinitions(prisma),
      // #2106: the member's current-season membership type decides whether N/A
      // is forced (FORCED), hand-pickable (ALLOWED) or rejected (DISALLOWED).
      loadMemberCurrentSeasonTypeExemption(prisma, id, clubCurrentSeasonYear),
    ]);
  if (!existing) {
    return jsonResult({ error: "Member not found" }, { status: 404 });
  }

  if (data.accessRoles !== undefined) {
    const unknownTokens = findUnknownAccessRoleTokens(
      data.accessRoles,
      roleDefinitions,
    );
    if (unknownTokens.length > 0) {
      return jsonResult(
        { error: `Unknown access role: ${unknownTokens.join(", ")}` },
        { status: 400 },
      );
    }
  }

  if (id === currentAdminMemberId) {
    if (data.role !== undefined && data.role !== "ADMIN") {
      return jsonResult(
        { error: "You cannot demote your own admin account" },
        { status: 400 },
      );
    }

    if (
      data.accessRoles !== undefined &&
      !normalizeAssignableAccessRoleTokens(data.accessRoles, {
        canLogin: data.canLogin ?? existing.canLogin,
      }).includes("ADMIN")
    ) {
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

  // #2620: an approved deletion request anonymises the member in place and
  // stamps NEITHER archivedAt nor cancelledAt, so the archived/cancelled
  // refusal below never covered an erased account — yet everything else it
  // needs to sign in (canLogin, googleSub, emailVerified, the second factor and
  // the access roles) survives anonymisation, leaving `active: false` as the
  // only barrier. Checked first, and named separately, because deletion is
  // terminal in a way an archive is not.
  //
  // Keyed on a real TRANSITION rather than the submitted value, matching the
  // no-op-echo handling below and `enablesLogin` further down: the edit dialog
  // re-submits the current active/canLogin on every save, and a deleted row
  // still carries `canLogin: true` today, so a blunt `data.canLogin === true`
  // test would refuse ordinary contact upkeep on an anonymised record while
  // catching nothing extra.
  if (
    isDeletedAccountRecord(existing) &&
    ((data.active === true && !existing.active) ||
      (data.canLogin === true && !existing.canLogin))
  ) {
    return jsonResult(
      { error: DELETED_ACCOUNT_EDIT_REACTIVATE_MESSAGE },
      { status: 409 },
    );
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

  // Whether this edit actually transitions the target OUT of active/login,
  // not merely echoing an already-false value. The edit dialog re-submits the
  // current active/canLogin on every save (including contact-only edits and a
  // dormant, already-de-logined ex-admin), so guard only on a real
  // deactivate/de-login — mirroring the #1012 no-op-echo handling.
  const deactivatesTarget = data.active === false && existing.active;
  const deLoginsTarget = data.canLogin === false && existing.canLogin;

  // Privileged-target guard (issue #1604): only a Full Admin may deactivate or
  // disable login for an account that holds (or dormantly stores) a privileged
  // access role. Mirrors the #1012 role gate and stops a scoped admin (e.g. the
  // seeded Membership Officer) from de-activating admin-holding accounts. Own
  // account deactivate/de-login is already blocked above.
  if (
    (deactivatesTarget || deLoginsTarget) &&
    id !== currentAdminMemberId &&
    !isFullAdmin({ accessRoles: currentAdminAccessRoles }) &&
    memberHoldsPrivilegedRole(existing)
  ) {
    return jsonResult(
      { error: PRIVILEGED_TARGET_GUARD_MESSAGE },
      { status: 403 },
    );
  }

  // Full Admin gate on privileged-member email changes (issue #1026): a
  // scoped admin must not edit the login email of a member who holds a
  // privileged access role — an email change plus a public forgot-password
  // request hands the account (and its roles) to the new address. Editing
  // your own email stays allowed: it grants nothing you do not already
  // have. Uses effective (canLogin-aware) roles, so contact upkeep on
  // archived/cancelled ex-admins is unaffected; activating such an account
  // is already Full-Admin-only via the #1012 role gate.
  if (
    data.email !== undefined &&
    data.email.toLowerCase().trim() !== existing.email &&
    id !== currentAdminMemberId &&
    !isFullAdmin({ accessRoles: currentAdminAccessRoles }) &&
    hasPrivilegedAccess(existing)
  ) {
    return jsonResult(
      { error: "Only a Full Admin can change a privileged member's email" },
      { status: 403 },
    );
  }

  // Check login-email uniqueness whenever this edit claims the address as a
  // login identity — either by changing the email of a login-capable member, or
  // by switching login ON (#2385). The second case used to be missed here: the
  // Account & Access form posts canLogin/active/roles and NO email
  // (`buildAccountPayload`, src/lib/admin-member-edit-groups.ts), so a
  // canLogin false → true save short-circuited a guard that required a
  // *changed* email and went on to attempt the write. The admin still got the
  // 409 — the partial unique index rejected it and the catch at the end of this
  // function translated that P2002 — so this is not a fix for a silent failure;
  // it stops a save that cannot succeed from being attempted at all, and lets
  // that catch be narrowed to email collisions only. An already-login-capable
  // member re-saving an unchanged email still skips the query: they already
  // hold the address.
  const effectiveCanLogin =
    data.canLogin !== undefined ? data.canLogin : existing.canLogin;
  // Normalised exactly as the write below stores it (`updateData.email`), so
  // the value checked here is the value the unique index will see.
  const requestedEmail = data.email?.toLowerCase().trim();
  const emailIsChanging = Boolean(
    requestedEmail && requestedEmail !== existing.email,
  );
  const enablesLogin = effectiveCanLogin && !existing.canLogin;
  if (effectiveCanLogin && (emailIsChanging || enablesLogin)) {
    const loginEmail = requestedEmail ?? existing.email;
    const emailTaken = await prisma.member.findFirst({
      where: {
        email: loginEmail,
        canLogin: true,
        id: { not: id },
      },
    });
    if (emailTaken) {
      return jsonResult(
        { error: MEMBER_LOGIN_EMAIL_TAKEN_MESSAGE },
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
  if (data.active !== undefined) updateData.active = data.active;
  if (data.canLogin !== undefined) updateData.canLogin = data.canLogin;
  const shouldSyncAccessRoles =
    data.accessRoles !== undefined ||
    data.role !== undefined ||
    data.financeAccessLevel !== undefined ||
    data.canLogin !== undefined;
  const requestedAccessRoles = shouldSyncAccessRoles
    ? resolveWriteAccessRoleTokens({
        accessRoles: data.accessRoles,
        role: data.role ?? existing.role,
        financeAccessLevel:
          data.financeAccessLevel ?? existing.financeAccessLevel,
        canLogin: effectiveCanLogin,
      })
    : null;
  // The member edit dialog echoes back role/accessRoles/financeAccessLevel/
  // canLogin even for contact-only edits, and for a canLogin=false member the
  // echoed accessRoles are always [] while a stale privileged legacy
  // role/financeAccessLevel may still be stored (archive and cancellation
  // clear canLogin but not the role fields). Treat an echo with no
  // role-field delta and an unchanged effective role set as carrying no role
  // intent: skip the Full Admin gate (a scoped admin's contact edit is not a
  // role write) and leave the stored role fields and access-role rows
  // untouched (deriving them from the echo would silently demote the dormant
  // role to USER). Any canLogin/role/financeAccessLevel delta — including
  // activating a dormant ADMIN by enabling login — still runs the gate.
  const roleSubmissionIsNoOp =
    shouldSyncAccessRoles &&
    (data.role === undefined || data.role === existing.role) &&
    (data.financeAccessLevel === undefined ||
      data.financeAccessLevel === existing.financeAccessLevel) &&
    (data.canLogin === undefined || data.canLogin === existing.canLogin) &&
    (data.accessRoles === undefined ||
      sameAccessRoleSet(
        requestedAccessRoles ?? [],
        resolveAccessRoleTokens(existing),
      ));
  const nextAccessRoles = roleSubmissionIsNoOp ? null : requestedAccessRoles;
  if (shouldSyncAccessRoles && !roleSubmissionIsNoOp) {
    // Full Admin gate (issue #1012): compare both the effective roles
    // (canLogin-aware) and the stored role fields (canLogin-blind) so a
    // scoped admin can neither change live privileged access nor park a
    // dormant elevated role/financeAccessLevel for later activation.
    // Unchanged submissions pass, so scoped admins can still edit
    // name/contact details and toggle login for ordinary members.
    const storedAfter =
      data.accessRoles !== undefined
        ? normalizeAssignableAccessRoleTokens(data.accessRoles, {
            canLogin: true,
          })
        : accessRolesFromCompatibilityFields({
            role: data.role ?? existing.role,
            financeAccessLevel:
              (data.role ?? existing.role) === "LODGE"
                ? "NONE"
                : (data.financeAccessLevel ?? existing.financeAccessLevel),
            canLogin: true,
          });
    const requiresFullAdmin =
      accessRoleChangeRequiresFullAdmin(
        resolveAccessRoleTokens(existing),
        nextAccessRoles ?? [],
      ) ||
      accessRoleChangeRequiresFullAdmin(
        storedAccessRolesForFullAdminGate(existing),
        storedAfter,
      );
    if (
      requiresFullAdmin &&
      !isFullAdmin({ accessRoles: currentAdminAccessRoles })
    ) {
      return jsonResult(
        { error: "Only a Full Admin can change member access roles" },
        { status: 403 },
      );
    }
  }
  if (roleSubmissionIsNoOp) {
    // No role intent: keep the stored role/financeAccessLevel and
    // access-role rows exactly as they are.
  } else if (data.accessRoles !== undefined) {
    updateData.role = legacyRoleFromAccessRoles(nextAccessRoles ?? []);
    // Derived from the merged matrix so definition-backed (custom or edited)
    // roles with finance access are reflected in the compatibility field.
    updateData.financeAccessLevel = financeAccessLevelFromMatrix(
      getAdminPermissionMatrix({
        accessRoles: accessRoleAssignmentRowsFromTokens(
          nextAccessRoles ?? [],
          roleDefinitions,
        ),
        canLogin: true,
      }),
    );
  } else {
    if (data.role !== undefined) updateData.role = data.role;
    const effectiveRole = data.role ?? existing.role;
    if (effectiveRole === "LODGE") {
      updateData.financeAccessLevel = "NONE";
    } else if (data.financeAccessLevel !== undefined) {
      updateData.financeAccessLevel = data.financeAccessLevel;
    }
  }
  if (data.forcePasswordChange !== undefined)
    updateData.forcePasswordChange = data.forcePasswordChange;
  if (data.requiresInduction !== undefined)
    updateData.requiresInduction = data.requiresInduction;
  if (data.inheritEmailFromId !== undefined) {
    // #2716: the CHOICE and the effective pointer are written together, always.
    // The admin's pick here is a hand-picked source (`inheritParentEmail` is not
    // touched by this edit), so it is exempt from the one-hop parent test but
    // not from the deliverability test: the reconciliation below re-derives the
    // pointer from the choice and will clear it the day that mailbox goes away.
    updateData.inheritEmailFromId = data.inheritEmailFromId?.trim() || null;
    updateData.inheritEmailChoiceId = updateData.inheritEmailFromId;
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

  // Handle DOB. The resulting age tier is resolved by the shared enforcement
  // helper below (#2106) so org force, a FORCED/ALLOWED/DISALLOWED membership
  // type, an explicit manual N/A, and DOB-derived restore apply in one order.
  const dobProvided =
    data.dateOfBirth !== undefined && data.dateOfBirth !== "";
  if (data.dateOfBirth !== undefined) {
    if (dobProvided) {
      // `parseCalendarDate`, not `new Date` + `isNaN` (#3082 fix round). The old
      // pair accepted `1990-02-31` and stored 3 March, and accepted
      // `0000-05-05`, which then throws a `RangeError` out of `computeAge`
      // below — a 500 where this branch already had the right answer, 422.
      const day = parseCalendarDate(data.dateOfBirth as string);
      if (day === null) {
        return jsonResult({ error: "Invalid date of birth" }, { status: 422 });
      }
      updateData.dateOfBirth = dateOnlyInstantOf(day);
    } else {
      updateData.dateOfBirth = null;
    }
  }

  // Age-tier enforcement (#2106), generalising the #1440 org block. The member
  // must hold a real person tier unless org/FORCED-type force N/A or an admin
  // hand-picks N/A on an ALLOWED type. The person-tier fallback recomputes from
  // the (new) DOB when the DOB changed OR when un-forcing a previously-N/A
  // member, and otherwise keeps the current person tier so ordinary contact
  // edits never bump a tier.
  {
    const tokensAfterUpdate =
      nextAccessRoles ?? resolveAccessRoleTokens(existing);
    const legacyRoleAfterUpdate = (updateData.role ??
      existing.role) as string;
    const isOrg = isOrganisationMember({
      accessRoleTokens: tokensAfterUpdate,
      legacyRole: legacyRoleAfterUpdate,
    });

    const restoringFromNotApplicable = existing.ageTier === "NOT_APPLICABLE";
    // One reference point for both branches, from the CLUB's current season
    // (CT-4, #2870): an age tier decides a price band, so the two branches must
    // never be able to judge the same member against two different seasons.
    const restoreSeasonStart = getSeasonStartDate(clubSeasonYear(clubZone));
    let restorePersonTier: AgeTier;
    if (dobProvided) {
      restorePersonTier = await computeAgeTier(
        updateData.dateOfBirth as Date,
        restoreSeasonStart,
      );
    } else if (restoringFromNotApplicable) {
      restorePersonTier = existing.dateOfBirth
        ? await computeAgeTier(existing.dateOfBirth, restoreSeasonStart)
        : "ADULT";
    } else {
      restorePersonTier =
        existing.ageTier === "NOT_APPLICABLE" ? "ADULT" : existing.ageTier;
    }

    // #2106 (MINOR-6): honour an explicit tier pick even when a DOB change rides
    // along in the same save — the resolver validates the pick (a manual N/A is
    // only accepted on an ALLOWED type), and the DOB-derived tier remains the
    // `restorePersonTier` fallback when no explicit tier is submitted. Previously
    // a DOB edit silently discarded an accompanying explicit pick.
    const requestedAgeTier = data.ageTier ?? undefined;

    const resolved = resolveEnforcedAgeTier({
      isOrganisation: isOrg,
      typeExemption: currentSeasonTypeExemption,
      requestedAgeTier,
      currentAgeTier: existing.ageTier,
      restorePersonTier,
    });
    if (!resolved.ok) {
      return jsonResult({ error: resolved.error }, { status: 422 });
    }
    updateData.ageTier = resolved.ageTier;

    // #2106 owner decision (MAJOR-5a): when this edit flips a non-N/A member TO
    // N/A (a manual N/A pick or an org grant), block it while the member is a
    // linked guest on someone else's future booking — N/A members are not
    // bookable guests. Same query shape as the seasonal-assignment save; the
    // admin must remove those guest links first. Applies to the current season's
    // "now" only, mirroring the other N/A-flip sites.
    if (
      existing.ageTier !== "NOT_APPLICABLE" &&
      resolved.ageTier === "NOT_APPLICABLE"
    ) {
      const linkedGuestBookings = await loadFutureLinkedGuestBookingsForMember(
        prisma,
        id,
        clubTodayDateOnly,
      );
      if (linkedGuestBookings.length > 0) {
        return jsonResult(
          {
            error: LINKED_GUEST_NOT_APPLICABLE_BLOCK_MESSAGE,
            linkedGuestBookings: summarizeFutureLinkedGuestBookings(
              linkedGuestBookings,
              formatDateOnly,
            ),
          },
          { status: 409 },
        );
      }
    }
  }

  // #1756: deactivation — or an ADULT → minor/N-A tier correction (the same
  // defect class: the pair no longer satisfies mayShareDoubleBed) — breaks the
  // double-bed sharing precondition, so the member's FUTURE shared-double
  // placements are swept inside the update transaction below. Computed here,
  // after the DOB/org blocks have finalised updateData.ageTier.
  const tierLeavesAdult =
    existing.ageTier === "ADULT" &&
    typeof updateData.ageTier === "string" &&
    updateData.ageTier !== "ADULT";
  let sweptShares: SweptPartnerSharedAllocation[] = [];

  try {
    const existingAuditRecord = {
      ...(existing as unknown as Record<string, unknown>),
      accessRoles: resolveAccessRoleTokens(existing),
    };
    const auditUpdateData = {
      ...updateData,
      ...(nextAccessRoles ? { accessRoles: nextAccessRoles } : {}),
    };
    const changedFields = getChangedFields(
      existingAuditRecord,
      auditUpdateData,
      ADMIN_MEMBER_AUDIT_FIELDS,
    );
    const accessChanges = buildAccessChanges(
      existingAuditRecord,
      auditUpdateData,
      changedFields,
    );
    const auditAction = getAdminMemberAuditAction(
      existingAuditRecord,
      auditUpdateData,
    );
    const updated = await prisma.$transaction(async (tx) => {
      if (deactivatesTarget || tierLeavesAdult) {
        await acquireFuturePartnerSharedAllocationLocks(tx, [id], clubTodayDateOnly);
        await acquireMemberLifecycleLocks(tx, [id]);
      }
      // Last-admin guard (issue #1604): counted inside the mutation
      // transaction so it sees this transaction's read view. Only a real
      // deactivate/de-login can strand the club; role demotion of another
      // admin always leaves the actor as an admin and is out of scope here.
      if (
        (deactivatesTarget || deLoginsTarget) &&
        (await wouldRemoveLastFullAdmin(tx, id))
      ) {
        throw new AdminAccountGuardError(LAST_FULL_ADMIN_GUARD_MESSAGE);
      }

      const updatedMember = await tx.member.update({
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
          accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
        },
      });

      if (
        existing.active !== updatedMember.active ||
        existing.ageTier !== updatedMember.ageTier
      ) {
        await enqueueHostingCoverageReevaluationForMember(
          id,
          tx,
          clubTodayDateOnly,
          {
            cause: "SYSTEM_CHANGE",
            actorMemberId: currentAdminMemberId,
          },
        );
      }

      // #2716: an admin edit is the single richest way to move a member across
      // the line between "can receive mail" and "cannot" — it can add, change or
      // REMOVE an address, flip the age tier, and set or clear a hand-picked
      // inheritance source, all in one write. Re-resolving here, inside the same
      // transaction, is what makes that a guarantee rather than a best effort: a
      // rolled-back edit rolls the re-resolution back with it, and a committed
      // one cannot commit without it. Unconditional rather than gated on which
      // fields changed — the function recomputes what should be true instead of
      // asking what happened, and a gate is one more thing that can be wrong.
      await reconcileEmailInheritanceForMemberChange(tx, [id], {
        trigger: "source-member-change",
        actorMemberId: currentAdminMemberId,
      });

      // #1756: sweep the member's future shared-double placements in the same
      // transaction as the deactivate / tier change; the removed second
      // occupants return to the awaiting-allocation queue (audited against
      // both bookings inside the sweep) and admins are alerted post-commit.
      if (deactivatesTarget || tierLeavesAdult) {
        sweptShares = await sweepFuturePartnerSharedAllocationsWithLocksHeld({
          memberId: id,
          reason: deactivatesTarget
            ? "member_deactivated"
            : "member_age_tier_changed",
          db: tx,
          today: clubTodayDateOnly,
        });
      }

      if (nextAccessRoles) {
        const assignmentRows = accessRoleAssignmentRowsFromTokens(
          nextAccessRoles,
          roleDefinitions,
        );
        await tx.memberAccessRole.deleteMany({ where: { memberId: id } });
        if (assignmentRows.length > 0) {
          await tx.memberAccessRole.createMany({
            data: assignmentRows.map((row) => ({
              memberId: id,
              role: row.role,
              roleDefinitionId: row.roleDefinitionId,
              assignedByMemberId: currentAdminMemberId,
            })),
            skipDuplicates: true,
          });
        }
      }

      // `admin`, and now SETTLED rather than held (#2755, `INV-PRIV-012`).
      //
      // #2730 left this as the weakest `admin` in the tree because the comparison
      // was inside the platform and it lost: the identical acts performed from
      // the bulk screen wrote `account` (`member.bulk-deactivate` /
      // `-reactivate`) and `security` (`member.bulk-set-role`), so one business
      // act was filed three ways according to which SCREEN the officer opened —
      // initiator reasoning wearing a different hat.
      //
      // #2755 closed it by moving the OTHER TWO here, not by moving this one. The
      // rule is that category follows the business domain affected, and editing,
      // activating, deactivating or re-roling somebody's member record is one
      // domain: the administration of that record. `account` and `security` are
      // both member-visible and all three rows reach the subject member's own
      // timeline — this writer by passing `subjectMemberId`, the two bulk writers
      // by `buildMemberAuditLogWhere`'s null-subject `targetId` leg — so unifying
      // on either would have published an officer's edits of a member's record to
      // that member. Whether a member should see a given event is meant to become
      // a separate explicit declaration at the writing site, denied by default:
      // #2695 DECIDED that and it is NOT BUILT YET, so today the category is the
      // only lever there is.
      //
      // THE RULE IS SCOPED TO THOSE SIX ACTIONS, not to "an officer acted". Other
      // officer-driven writers file MEMBER-VISIBLE categories on purpose — the
      // member-photo pair (#2581 chose `account` for the on-behalf branch
      // deliberately, and the photo editor renders on THIS very screen in
      // `mode="admin"`) and the cancellation-review writers. Do not "finish the
      // job" by sweeping those into `admin`: that withdraws rows from members'
      // timelines, `OFFICER_DRIVEN_MEMBER_VISIBLE_WRITERS_2755` fails CI when it
      // happens, and it needs the owner's decision. `/api/profile` likewise stays
      // `account`: a member editing their OWN record
      // (`member.profile.updated`) has its actor as its subject, so it is
      // self-service rather than administration, and filing it `admin` would hide
      // a member's own action from them.
      //
      // Do not "finish the job" by moving this site to a member-visible category.
      // Audit rows are append-only, so publishing administrative activity to
      // members is not quietly reversible.
      await tx.auditLog.create(
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
      );

      return {
        ...updatedMember,
        accessRoles: nextAccessRoles ?? resolveAccessRoleTokens(updatedMember),
      };
    });

    if (
      existing.active !== updated.active ||
      existing.ageTier !== updated.ageTier
    ) {
      await settleHostingCoverageAfterCommit({ limit: 50 });
    }

    if (sweptShares.length > 0) {
      // Post-commit, fire-and-forget: the sweep already committed with the
      // member update, so a failed alert only loses the nudge.
      sendAdminPartnerShareSweptAlert({
        memberName: `${existing.firstName} ${existing.lastName}`.trim(),
        partnerName: partnerShareSweepCounterpartNames(sweptShares, id),
        reason: describePartnerSharedSweepReason(
          deactivatesTarget ? "member_deactivated" : "member_age_tier_changed",
        ),
        nights: partnerShareSweepNights(sweptShares),
      }).catch((err) => {
        logger.error(
          { err, memberId: id, sweptCount: sweptShares.length },
          "Failed to send partner share sweep alert",
        );
      });
    }

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
    // Grouping-relevant changes (E8, #1934; #2149): an age-tier flip, or — ONLY
    // for a member with no current-season membership assignment — a role change
    // whose role-default membership type key differs. Under #2149 the membership
    // type resolved assignment-first is the sole authority for grouping, so when
    // an explicit current-season assignment exists the role default is NOT the
    // effective type and a role change re-groups nothing (e.g. USER->ADMIN on an
    // assigned member must not re-sync). Only when there is no assignment does
    // the role default become the effective type (USER->SCHOOL re-groups under
    // type-driven modes). `currentSeasonTypeExemption` is non-null iff such an
    // assignment exists. The sync itself is a safe no-op when neither applies.
    const memberHasCurrentSeasonAssignment =
      currentSeasonTypeExemption !== null;
    const roleDefaultTypeChanged =
      !memberHasCurrentSeasonAssignment &&
      existing.role !== updated.role &&
      defaultMembershipTypeKeyForRole(existing.role) !==
        defaultMembershipTypeKeyForRole(updated.role);
    const needsContactGroupSync = Boolean(
      updated.xeroContactId &&
        (existing.ageTier !== updated.ageTier || roleDefaultTypeChanged),
    );

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
    if (isHostingCoverageParticipantRetry(error)) {
      return jsonResult(HOSTING_COVERAGE_RETRY_BODY, { status: 409 });
    }
    if (error instanceof AdminAccountGuardError) {
      return jsonResult(
        { error: error.message },
        { status: error.statusCode },
      );
    }

    // Backstop for the race the pre-check above cannot close (#2385): the
    // uniqueness query runs before the transaction, so a concurrent write can
    // claim the address in between. The partial unique index
    // `Member_email_login_unique` is what actually makes two login-capable
    // members on one address impossible; this only translates its rejection
    // into the same 409 the pre-check returns, so the loser of the race gets
    // the same explanation rather than a 500. Narrowed from "any P2002 here
    // means the email is taken" (#2385): a collision on some other unique
    // column now falls through to the generic failure below rather than sending
    // the admin off to fix an address that is fine.
    if (isLoginEmailUniqueConflict(error)) {
      return jsonResult(
        { error: MEMBER_LOGIN_EMAIL_TAKEN_MESSAGE },
        { status: 409 },
      );
    }

    logger.error({ err: error, memberId: id }, "Failed to update member");
    return jsonResult({ error: "Failed to update member" }, { status: 500 });
  }
}
