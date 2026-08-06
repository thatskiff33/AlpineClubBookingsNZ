import { createHmac, timingSafeEqual } from "crypto";
import type {
  AgeTier,
  BookingStatus,
  MembershipAssignmentSource,
  MembershipTypeBookingBehavior,
  MembershipTypeSubscriptionBehavior,
  Prisma,
  SubscriptionStatus,
} from "@prisma/client";
import { capacityHoldingBookingFilter } from "@/lib/booking-status";
import {
  formatDateOnly,
  getTodayDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import {
  buildStructuredAuditLogCreateArgs,
  type StructuredAuditEvent,
} from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { getSeasonYear } from "@/lib/utils";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import {
  isOrganisationMember,
  resolveAccessRoleTokens,
} from "@/lib/access-roles";
import { membershipTypeAgeExemption } from "@/lib/membership-types";
import { reconcileSeasonSubscriptionForAssignment } from "@/lib/member-subscription-defaults";
import { resolveEnforcedAgeTier } from "@/lib/age-tier-enforcement";
import {
  acquireFuturePartnerSharedAllocationLocks,
  describePartnerSharedSweepReason,
  partnerShareSweepCounterpartNames,
  partnerShareSweepNights,
  sweepFuturePartnerSharedAllocationsWithLocksHeld,
  type SweptPartnerSharedAllocation,
} from "@/lib/bed-allocation-lifecycle";
import { sendAdminPartnerShareSweptAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { acquireMemberLifecycleLocks } from "@/lib/member-lifecycle-lock";
import {
  reconcileMembersXeroContactGroups,
  triggerMemberXeroContactGroupSync,
} from "@/lib/xero-contact-groups";

// test seam
export const SEASONAL_MEMBERSHIP_ASSIGNMENT_CHANGED_ACTION =
  "admin.member.seasonal_membership_type_changed";
// test seam
export const SEASONAL_MEMBERSHIP_ASSIGNMENTS_ROLLED_FORWARD_ACTION =
  "admin.membership_type_assignments.rolled_forward";
// test seam — the post-copy tier-reconcile summary audit (#2106, MAJOR-4).
export const SEASONAL_MEMBERSHIP_ROLL_FORWARD_TIERS_RECONCILED_ACTION =
  "admin.membership_type_assignments.roll_forward_tiers_reconciled";
// test seam — the bulk membership-type change summary audit (#2107). Each member
// still gets its own critical per-member audit inside saveSeasonalMembershipAssignment;
// this important-severity row records the aggregate run outcome.
export const SEASONAL_MEMBERSHIP_BULK_ASSIGNMENT_ACTION =
  "admin.member.seasonal_membership_type_bulk_changed";

// Bounded member-id sample carried in the bulk summary audit metadata (the route
// already caps ids at 100, so this never truncates a valid request).
const BULK_ASSIGNMENT_MEMBER_ID_LIMIT = 100;

// #2106 (MAJOR-3): the post-copy tier reconcile runs in transactions of at most
// this many members so no single transaction spans the whole membership.
const ROLL_FORWARD_RECONCILE_CHUNK_SIZE = 25;
// Bounded per-member reconcile sample carried in the summary audit metadata.
const ROLL_FORWARD_RECONCILE_SAMPLE_LIMIT = 50;

const BOOKING_SUMMARY_LIMIT = 10;
const SUBSCRIPTION_HISTORY_LIMIT = 5;
const PREVIEW_TOKEN_VERSION = 1;

const membershipTypeSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: true,
  subscriptionBehavior: true,
  sortOrder: true,
} satisfies Prisma.MembershipTypeSelect;

const assignmentInclude = {
  membershipType: { select: membershipTypeSelect },
} satisfies Prisma.SeasonalMembershipAssignmentInclude;

const assignmentWithMemberInclude = {
  member: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      active: true,
      archivedAt: true,
      cancelledAt: true,
      // #2106: fields the roll-forward tier reconciliation needs when the
      // target season is current.
      ageTier: true,
      dateOfBirth: true,
      role: true,
      canLogin: true,
      accessRoles: { select: { role: true } },
    },
  },
  membershipType: {
    select: {
      ...membershipTypeSelect,
      allowedAgeTiers: { select: { ageTier: true } },
    },
  },
} satisfies Prisma.SeasonalMembershipAssignmentInclude;

type SeasonalMembershipReadClient =
  | typeof prisma
  | Prisma.TransactionClient;

type MembershipTypeSummary = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isBuiltIn: boolean;
  bookingBehavior: MembershipTypeBookingBehavior;
  subscriptionBehavior: MembershipTypeSubscriptionBehavior;
  sortOrder: number;
};

type SeasonalAssignmentWithType = {
  id: string;
  memberId: string;
  seasonYear: number;
  membershipTypeId: string;
  applyFrom: Date | null;
  assignedByMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
  membershipType: MembershipTypeSummary;
};

type BookingPreviewRecord = {
  id: string;
  checkIn: Date;
  checkOut: Date;
  status: BookingStatus;
  finalPriceCents: number;
  waitlistPosition?: number | null;
  waitlistOfferedAt?: Date | null;
  waitlistOfferExpiresAt?: Date | null;
  _count: { guests: number };
};

type SubscriptionPreviewRecord = {
  id: string;
  seasonYear: number;
  status: SubscriptionStatus;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  paidAt: Date | null;
};

type SerializedMembershipTypeSummary = ReturnType<
  typeof serializeMembershipTypeSummary
>;

type SerializedSeasonalMembershipAssignment = ReturnType<
  typeof serializeSeasonalMembershipAssignment
>;

type SeasonalMembershipBookingSummary = ReturnType<
  typeof summarizeBookings
>;

type LinkedGuestBookingSummary = ReturnType<
  typeof summarizeLinkedGuestBookings
>;

type SeasonalMembershipChangePreview = {
  memberId: string;
  seasonYear: number;
  generatedAt: string;
  applyFrom: string | null;
  previousAssignment: SerializedSeasonalMembershipAssignment | null;
  newMembershipType: SerializedMembershipTypeSummary;
  resultingBookingBehavior: MembershipTypeBookingBehavior;
  resultingSubscriptionBehavior: MembershipTypeSubscriptionBehavior;
  behaviorChanged: boolean;
  bookingBehaviorChanged: boolean;
  subscriptionBehaviorChanged: boolean;
  // #2106: age tier this change resolves to for the member (org/type force,
  // manual-N/A, or DOB-derived). Carried inside the HMAC token so a
  // tier-relevant drift between preview and save is stale-detected.
  currentAgeTier: AgeTier;
  resultingAgeTier: AgeTier;
  ageTierChanged: boolean;
  // Bookings on which the member is a linked guest of SOMEONE ELSE, still in the
  // future. A flip to N/A is blocked while any exist (N/A members are not
  // bookable guests); the admin must remove these links first.
  linkedGuestBookings: LinkedGuestBookingSummary;
  affectedCounts: {
    futureConfirmedBookings: number;
    draftBookings: number;
    waitlistRecords: number;
  };
  futureConfirmedBookings: SeasonalMembershipBookingSummary;
  draftBookings: SeasonalMembershipBookingSummary;
  waitlistRecords: SeasonalMembershipBookingSummary;
  currentSeasonSubscription: {
    seasonYear: number;
    status: SubscriptionStatus | "NO_RECORD";
    hasInvoice: boolean;
    xeroInvoiceNumber: string | null;
    paidAt: string | null;
  };
  subscriptionHistory: {
    totalRecords: number;
    statusCounts: Partial<Record<SubscriptionStatus, number>>;
    recent: Array<{
      seasonYear: number;
      status: SubscriptionStatus;
      hasInvoice: boolean;
      xeroInvoiceNumber: string | null;
      paidAt: string | null;
    }>;
  };
  previewToken: string;
};

type RollForwardExceptionCode =
  | "missing_prior_assignment"
  | "inactive_membership_type";

type SeasonalMembershipRollForwardException = {
  code: RollForwardExceptionCode;
  memberId: string;
  memberName: string;
  memberEmail: string;
  membershipTypeId?: string;
  membershipTypeName?: string;
};

type JsonRouteResult = {
  body: unknown;
  init?: ResponseInit;
};

function jsonResult(body: unknown, init?: ResponseInit): JsonRouteResult {
  return { body, init };
}

function serializeMembershipTypeSummary(type: MembershipTypeSummary) {
  return {
    id: type.id,
    key: type.key,
    name: type.name,
    description: type.description,
    isActive: type.isActive,
    isBuiltIn: type.isBuiltIn,
    bookingBehavior: type.bookingBehavior,
    subscriptionBehavior: type.subscriptionBehavior,
    sortOrder: type.sortOrder,
  };
}

export function serializeSeasonalMembershipAssignment(
  assignment: SeasonalAssignmentWithType,
) {
  return {
    id: assignment.id,
    memberId: assignment.memberId,
    seasonYear: assignment.seasonYear,
    membershipTypeId: assignment.membershipTypeId,
    applyFrom: assignment.applyFrom
      ? formatDateOnly(assignment.applyFrom)
      : null,
    assignedByMemberId: assignment.assignedByMemberId,
    createdAt: assignment.createdAt.toISOString(),
    updatedAt: assignment.updatedAt.toISOString(),
    membershipType: serializeMembershipTypeSummary(assignment.membershipType),
  };
}

function serializeBookingSummary(booking: BookingPreviewRecord) {
  return {
    id: booking.id,
    checkIn: formatDateOnly(booking.checkIn),
    checkOut: formatDateOnly(booking.checkOut),
    status: booking.status,
    finalPriceCents: booking.finalPriceCents,
    guestCount: booking._count.guests,
    waitlistPosition: booking.waitlistPosition ?? null,
    waitlistOfferedAt: booking.waitlistOfferedAt?.toISOString() ?? null,
    waitlistOfferExpiresAt:
      booking.waitlistOfferExpiresAt?.toISOString() ?? null,
  };
}

function summarizeBookings(bookings: BookingPreviewRecord[]) {
  return {
    count: bookings.length,
    truncatedCount: Math.max(0, bookings.length - BOOKING_SUMMARY_LIMIT),
    list: bookings.slice(0, BOOKING_SUMMARY_LIMIT).map(serializeBookingSummary),
  };
}

type LinkedGuestPreviewRecord = {
  id: string;
  bookingId: string;
  stayStart: Date;
  stayEnd: Date;
  booking: {
    id: string;
    memberId: string | null;
    checkIn: Date;
    checkOut: Date;
  };
};

function summarizeLinkedGuestBookings(guests: LinkedGuestPreviewRecord[]) {
  return {
    count: guests.length,
    truncatedCount: Math.max(0, guests.length - BOOKING_SUMMARY_LIMIT),
    list: guests.slice(0, BOOKING_SUMMARY_LIMIT).map((guest) => ({
      bookingGuestId: guest.id,
      bookingId: guest.bookingId,
      ownerMemberId: guest.booking.memberId,
      checkIn: formatDateOnly(guest.booking.checkIn),
      checkOut: formatDateOnly(guest.booking.checkOut),
      stayStart: formatDateOnly(guest.stayStart),
      stayEnd: formatDateOnly(guest.stayEnd),
    })),
  };
}

function summarizeSubscriptionHistory(records: SubscriptionPreviewRecord[]) {
  const statusCounts: Partial<Record<SubscriptionStatus, number>> = {};
  for (const record of records) {
    statusCounts[record.status] = (statusCounts[record.status] ?? 0) + 1;
  }

  return {
    totalRecords: records.length,
    statusCounts,
    recent: records.slice(0, SUBSCRIPTION_HISTORY_LIMIT).map((record) => ({
      seasonYear: record.seasonYear,
      status: record.status,
      hasInvoice: Boolean(record.xeroInvoiceId || record.xeroInvoiceNumber),
      xeroInvoiceNumber: record.xeroInvoiceNumber,
      paidAt: record.paidAt?.toISOString() ?? null,
    })),
  };
}

function getPreviewSecret() {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (secret) {
    return secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_SECRET or NEXTAUTH_SECRET is required for seasonal membership preview tokens",
    );
  }
  return "seasonal-membership-preview-local-secret";
}

function normalizeApplyFromInput(value: string | null | undefined):
  | { ok: true; date: Date | null; serialized: string | null }
  | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, date: null, serialized: null };
  }

  if (!isDateOnlyString(value)) {
    return { ok: false, error: "Invalid apply-from date" };
  }

  return { ok: true, date: parseDateOnly(value), serialized: value };
}

function previewTokenPayload(preview: Omit<SeasonalMembershipChangePreview, "previewToken">) {
  return {
    version: PREVIEW_TOKEN_VERSION,
    memberId: preview.memberId,
    seasonYear: preview.seasonYear,
    applyFrom: preview.applyFrom,
    previousMembershipTypeId:
      preview.previousAssignment?.membershipTypeId ?? null,
    newMembershipTypeId: preview.newMembershipType.id,
    resultingBookingBehavior: preview.resultingBookingBehavior,
    resultingSubscriptionBehavior: preview.resultingSubscriptionBehavior,
    // #2106: bind the resolved age tier into the token so a tier-relevant drift
    // (e.g. the type's allowed tiers or the member's org role changed between
    // preview and save) invalidates the stale preview.
    resultingAgeTier: preview.resultingAgeTier,
    affectedCounts: preview.affectedCounts,
    behaviorChanged: preview.behaviorChanged,
    bookingBehaviorChanged: preview.bookingBehaviorChanged,
    subscriptionBehaviorChanged: preview.subscriptionBehaviorChanged,
  };
}

function buildSeasonalMembershipPreviewToken(
  preview: Omit<SeasonalMembershipChangePreview, "previewToken">,
): string {
  return createHmac("sha256", getPreviewSecret())
    .update(JSON.stringify(previewTokenPayload(preview)))
    .digest("hex");
}

function verifySeasonalMembershipPreviewToken(
  preview: Omit<SeasonalMembershipChangePreview, "previewToken">,
  token: string,
): boolean {
  const expected = buildSeasonalMembershipPreviewToken(preview);
  const expectedBuffer = Buffer.from(expected);
  const tokenBuffer = Buffer.from(token);

  return (
    expectedBuffer.length === tokenBuffer.length &&
    timingSafeEqual(expectedBuffer, tokenBuffer)
  );
}

export async function getSeasonalMembershipChangePreview(params: {
  memberId: string;
  seasonYear: number;
  membershipTypeId: string;
  applyFrom?: string | null;
  now?: Date;
  db?: SeasonalMembershipReadClient;
}): Promise<JsonRouteResult> {
  const db = params.db ?? prisma;
  const today = params.now ?? getTodayDateOnly();
  const normalizedApplyFrom = normalizeApplyFromInput(params.applyFrom);
  if (!normalizedApplyFrom.ok) {
    return jsonResult({ error: normalizedApplyFrom.error }, { status: 400 });
  }

  const [member, newMembershipType, previousAssignment] = await Promise.all([
    db.member.findUnique({
      where: { id: params.memberId },
      select: {
        id: true,
        ageTier: true,
        dateOfBirth: true,
        role: true,
        canLogin: true,
        accessRoles: { select: { role: true } },
      },
    }),
    db.membershipType.findUnique({
      where: { id: params.membershipTypeId },
      select: {
        ...membershipTypeSelect,
        allowedAgeTiers: { select: { ageTier: true } },
      },
    }),
    db.seasonalMembershipAssignment.findUnique({
      where: {
        memberId_seasonYear: {
          memberId: params.memberId,
          seasonYear: params.seasonYear,
        },
      },
      include: assignmentInclude,
    }),
  ]);

  if (!member) {
    return jsonResult({ error: "Member not found" }, { status: 404 });
  }

  if (!newMembershipType) {
    return jsonResult({ error: "Membership type not found" }, { status: 404 });
  }

  if (!newMembershipType.isActive) {
    return jsonResult(
      { error: "Archived membership types cannot be newly assigned" },
      { status: 409 },
    );
  }

  const bookingSelect = {
    id: true,
    checkIn: true,
    checkOut: true,
    status: true,
    finalPriceCents: true,
    waitlistPosition: true,
    waitlistOfferedAt: true,
    waitlistOfferExpiresAt: true,
    _count: { select: { guests: true } },
  } satisfies Prisma.BookingSelect;

  const [
    futureConfirmedBookings,
    draftBookings,
    waitlistRecords,
    subscriptions,
    linkedGuestBookings,
  ] = await Promise.all([
    db.booking.findMany({
      where: {
        memberId: params.memberId,
        deletedAt: null,
        checkOut: { gt: today },
        // Capacity-holding population (issue #1254): holding statuses plus
        // request-converted PENDING holds.
        ...capacityHoldingBookingFilter(),
      },
      orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
      select: bookingSelect,
    }),
    db.booking.findMany({
      where: {
        memberId: params.memberId,
        deletedAt: null,
        checkOut: { gt: today },
        status: "DRAFT",
      },
      orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
      select: bookingSelect,
    }),
    db.booking.findMany({
      where: {
        memberId: params.memberId,
        deletedAt: null,
        checkOut: { gt: today },
        status: { in: ["WAITLISTED", "WAITLIST_OFFERED"] },
      },
      orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
      select: bookingSelect,
    }),
    db.memberSubscription.findMany({
      where: { memberId: params.memberId },
      orderBy: [{ seasonYear: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        seasonYear: true,
        status: true,
        xeroInvoiceId: true,
        xeroInvoiceNumber: true,
        paidAt: true,
      },
    }),
    // #2106: future bookings where the member is a linked guest on SOMEONE
    // ELSE'S booking. N/A members are not bookable guests, so a flip to N/A is
    // blocked until these links are removed; the preview lists them.
    db.bookingGuest.findMany({
      where: {
        memberId: params.memberId,
        isMember: true,
        stayEnd: { gt: today },
        booking: {
          deletedAt: null,
          memberId: { not: params.memberId },
        },
      },
      orderBy: [{ stayStart: "asc" }],
      select: {
        id: true,
        bookingId: true,
        stayStart: true,
        stayEnd: true,
        booking: {
          select: {
            id: true,
            memberId: true,
            checkIn: true,
            checkOut: true,
          },
        },
      },
    }),
  ]);

  const currentSubscription = subscriptions.find(
    (subscription) => subscription.seasonYear === params.seasonYear,
  );

  // #2106: resolve the age tier this change lands the member on. The assignment
  // save never submits a tier, so the resulting tier is org force > new-type
  // force > a preserved ALLOWED-type manual N/A > the current person tier (or a
  // DOB-derived restore when un-forcing a previously-N/A member).
  const currentAgeTier: AgeTier = member.ageTier ?? "ADULT";
  const newTypeExemption = membershipTypeAgeExemption(
    (newMembershipType.allowedAgeTiers ?? []).map((tier) => tier.ageTier),
  );
  const isOrg = isOrganisationMember({
    accessRoleTokens: resolveAccessRoleTokens(member),
    legacyRole: member.role,
  });
  const restorePersonTier: AgeTier =
    currentAgeTier !== "NOT_APPLICABLE"
      ? currentAgeTier
      : member.dateOfBirth
        ? await computeAgeTier(
            member.dateOfBirth,
            getSeasonStartDate(getSeasonYear()),
          )
        : "ADULT";
  const resolvedAgeTier = resolveEnforcedAgeTier({
    isOrganisation: isOrg,
    typeExemption: newTypeExemption,
    currentAgeTier,
    restorePersonTier,
  });
  const resultingAgeTier: AgeTier = resolvedAgeTier.ok
    ? resolvedAgeTier.ageTier
    : currentAgeTier;

  const previousMembershipType = previousAssignment?.membershipType ?? null;
  const bookingBehaviorChanged = previousMembershipType
    ? previousMembershipType.bookingBehavior !==
      newMembershipType.bookingBehavior
    : true;
  const subscriptionBehaviorChanged = previousMembershipType
    ? previousMembershipType.subscriptionBehavior !==
      newMembershipType.subscriptionBehavior
    : true;

  const previewWithoutToken: Omit<
    SeasonalMembershipChangePreview,
    "previewToken"
  > = {
    memberId: params.memberId,
    seasonYear: params.seasonYear,
    generatedAt: new Date().toISOString(),
    applyFrom: normalizedApplyFrom.serialized,
    previousAssignment: previousAssignment
      ? serializeSeasonalMembershipAssignment(
          previousAssignment as SeasonalAssignmentWithType,
        )
      : null,
    newMembershipType: serializeMembershipTypeSummary(newMembershipType),
    resultingBookingBehavior: newMembershipType.bookingBehavior,
    resultingSubscriptionBehavior: newMembershipType.subscriptionBehavior,
    behaviorChanged: bookingBehaviorChanged || subscriptionBehaviorChanged,
    bookingBehaviorChanged,
    subscriptionBehaviorChanged,
    currentAgeTier,
    resultingAgeTier,
    ageTierChanged: resultingAgeTier !== currentAgeTier,
    linkedGuestBookings: summarizeLinkedGuestBookings(
      linkedGuestBookings as LinkedGuestPreviewRecord[],
    ),
    affectedCounts: {
      futureConfirmedBookings: futureConfirmedBookings.length,
      draftBookings: draftBookings.length,
      waitlistRecords: waitlistRecords.length,
    },
    futureConfirmedBookings: summarizeBookings(
      futureConfirmedBookings as BookingPreviewRecord[],
    ),
    draftBookings: summarizeBookings(draftBookings as BookingPreviewRecord[]),
    waitlistRecords: summarizeBookings(
      waitlistRecords as BookingPreviewRecord[],
    ),
    currentSeasonSubscription: {
      seasonYear: params.seasonYear,
      status: currentSubscription?.status ?? "NO_RECORD",
      hasInvoice: Boolean(
        currentSubscription?.xeroInvoiceId ||
          currentSubscription?.xeroInvoiceNumber,
      ),
      xeroInvoiceNumber: currentSubscription?.xeroInvoiceNumber ?? null,
      paidAt: currentSubscription?.paidAt?.toISOString() ?? null,
    },
    subscriptionHistory: summarizeSubscriptionHistory(
      subscriptions as SubscriptionPreviewRecord[],
    ),
  };

  return jsonResult({
    preview: {
      ...previewWithoutToken,
      previewToken: buildSeasonalMembershipPreviewToken(previewWithoutToken),
    },
  });
}

export async function saveSeasonalMembershipAssignment(params: {
  memberId: string;
  seasonYear: number;
  membershipTypeId: string;
  applyFrom?: string | null;
  adminMemberId: string;
  reason: string;
  previewToken: string;
  // #2108: attribution for the assignment write. Defaults to ADMIN so existing
  // callers are unchanged; the Xero member import passes IMPORT.
  source?: MembershipAssignmentSource;
  request?: StructuredAuditEvent["request"];
  db?: typeof prisma;
  // #2107: the bulk wrapper suppresses the per-member synchronous Xero
  // contact-group sync (up to 100 live round-trips in one request) and performs
  // ONE deferred batched reconcile after its loop instead. Default false keeps
  // the single-member save path unchanged.
  skipXeroContactGroupSync?: boolean;
}): Promise<JsonRouteResult> {
  const reason = params.reason.trim();
  const source: MembershipAssignmentSource = params.source ?? "ADMIN";
  if (!reason) {
    return jsonResult({ error: "Admin reason is required" }, { status: 400 });
  }

  const db = params.db ?? prisma;
  const previewResult = await getSeasonalMembershipChangePreview({
    memberId: params.memberId,
    seasonYear: params.seasonYear,
    membershipTypeId: params.membershipTypeId,
    applyFrom: params.applyFrom,
    db,
  });
  if (previewResult.init?.status && previewResult.init.status >= 400) {
    return previewResult;
  }

  const preview = (previewResult.body as { preview: SeasonalMembershipChangePreview })
    .preview;

  if (
    !verifySeasonalMembershipPreviewToken(
      preview,
      params.previewToken,
    )
  ) {
    return jsonResult(
      {
        error:
          "Membership type change preview is missing or stale. Preview the change again before saving.",
      },
      { status: 409 },
    );
  }

  const assignmentUnchanged =
    preview.previousAssignment?.membershipTypeId === params.membershipTypeId &&
    (preview.previousAssignment.applyFrom ?? null) === preview.applyFrom;
  const tierChanged = preview.ageTierChanged;
  const flipsToNotApplicable =
    preview.resultingAgeTier === "NOT_APPLICABLE" &&
    preview.currentAgeTier !== "NOT_APPLICABLE";

  // Owner decision (#2106): a flip to N/A is blocked while the member is a
  // linked guest on someone else's future booking. N/A members are not bookable
  // guests, so the admin must remove those links first. The preview lists them.
  if (flipsToNotApplicable && preview.linkedGuestBookings.count > 0) {
    return jsonResult(
      {
        error:
          "This change would make the member age-exempt (N/A), but they are still a linked guest on future bookings owned by other members. Remove those guest links before making the member N/A.",
        linkedGuestBookings: preview.linkedGuestBookings,
      },
      { status: 409 },
    );
  }

  // No-op suppression: genuinely unchanged saves (same type, same apply-from and
  // no age-tier drift to repair) write nothing and emit no audit row (#2106
  // keeps this while removing the tier-reconciliation bypass).
  if (assignmentUnchanged && !tierChanged) {
    return jsonResult({
      assignment: preview.previousAssignment,
      preview,
      changed: false,
    });
  }

  const nextApplyFromDate = preview.applyFrom
    ? parseDateOnly(preview.applyFrom)
    : null;
  // #1756: an ADULT → N/A flip (org/type force) breaks the double-bed sharing
  // precondition, so the member's future shared-double placements are swept in
  // the same transaction; admins are alerted post-commit.
  const tierLeavesAdult =
    preview.currentAgeTier === "ADULT" &&
    preview.resultingAgeTier !== "ADULT";
  let sweptShares: SweptPartnerSharedAllocation[] = [];

  const assignment = await db.$transaction(async (tx) => {
    if (tierLeavesAdult) {
      await acquireFuturePartnerSharedAllocationLocks(tx, [params.memberId]);
      await acquireMemberLifecycleLocks(tx, [params.memberId]);
    }
    let saved: SeasonalAssignmentWithType;
    if (assignmentUnchanged && preview.previousAssignment) {
      // Tier-only repair: the assignment itself is unchanged, so re-read it for
      // the response/entity id without rewriting the row.
      saved = (await tx.seasonalMembershipAssignment.findUniqueOrThrow({
        where: {
          memberId_seasonYear: {
            memberId: params.memberId,
            seasonYear: params.seasonYear,
          },
        },
        include: assignmentInclude,
      })) as SeasonalAssignmentWithType;
    } else {
      saved = (await tx.seasonalMembershipAssignment.upsert({
        where: {
          memberId_seasonYear: {
            memberId: params.memberId,
            seasonYear: params.seasonYear,
          },
        },
        update: {
          membershipTypeId: params.membershipTypeId,
          applyFrom: nextApplyFromDate,
          assignedByMemberId: params.adminMemberId,
          source,
        },
        create: {
          memberId: params.memberId,
          seasonYear: params.seasonYear,
          membershipTypeId: params.membershipTypeId,
          applyFrom: nextApplyFromDate,
          assignedByMemberId: params.adminMemberId,
          source,
        },
        include: assignmentInclude,
      })) as SeasonalAssignmentWithType;
    }

    // #2106: reconcile the member's stored age tier with the resolved value
    // (force N/A, restore a person tier, or preserve a manual N/A).
    if (tierChanged) {
      await tx.member.update({
        where: { id: params.memberId },
        data: { ageTier: preview.resultingAgeTier },
      });
      if (tierLeavesAdult) {
        sweptShares = await sweepFuturePartnerSharedAllocationsWithLocksHeld({
          memberId: params.memberId,
          reason: "member_age_tier_changed",
          db: tx,
        });
      }
    }

    // #2149 F1: a REQUIRED-type season assignment supersedes any stale
    // creation-seeded NOT_REQUIRED row for the SAME season, so an operational
    // account (ADMIN/LODGE) that is later made a paying member stops reading
    // "Not Required" while the booking gate treats it as owing. Idempotent and
    // status-guarded (never touches a paid/invoiced/covered/manual row), it runs
    // in this transaction so the row flips atomically with the assignment and
    // makes no provider calls. BASED_ON_AGE_TIER / NOT_REQUIRED types are left
    // untouched (the #2041 NOT_REQUIRED-row dominance already keeps them
    // consistent).
    await reconcileSeasonSubscriptionForAssignment(tx, {
      memberId: params.memberId,
      seasonYear: params.seasonYear,
      subscriptionBehavior: saved.membershipType.subscriptionBehavior,
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: SEASONAL_MEMBERSHIP_ASSIGNMENT_CHANGED_ACTION,
        actor: { memberId: params.adminMemberId },
        subject: { memberId: params.memberId },
        entity: { type: "SeasonalMembershipAssignment", id: saved.id },
        category: "admin",
        severity: "critical",
        outcome: "success",
        summary: "Seasonal membership type changed",
        metadata: {
          seasonYear: params.seasonYear,
          adminReason: reason,
          previousMembershipType: preview.previousAssignment?.membershipType,
          newMembershipType: preview.newMembershipType,
          previousApplyFrom: preview.previousAssignment?.applyFrom ?? null,
          newApplyFrom: preview.applyFrom,
          affectedCounts: preview.affectedCounts,
          bookingBehaviorChanged: preview.bookingBehaviorChanged,
          subscriptionBehaviorChanged: preview.subscriptionBehaviorChanged,
          behaviorChanged: preview.behaviorChanged,
          resultingBookingBehavior: preview.resultingBookingBehavior,
          resultingSubscriptionBehavior: preview.resultingSubscriptionBehavior,
          // #2106: old/new age tier surfaced on this critical record.
          previousAgeTier: preview.currentAgeTier,
          newAgeTier: preview.resultingAgeTier,
          ageTierChanged: preview.ageTierChanged,
          partnerSharedAllocationsSwept: sweptShares.length,
        },
        request: params.request,
      }),
    );

    return saved;
  });

  if (sweptShares.length > 0) {
    // Post-commit, fire-and-forget: the sweep committed with the assignment, so
    // a failed alert only loses the nudge.
    const swept = sweptShares;
    void (async () => {
      try {
        const memberRecord = await db.member.findUnique({
          where: { id: params.memberId },
          select: { firstName: true, lastName: true },
        });
        await sendAdminPartnerShareSweptAlert({
          memberName: memberRecord
            ? `${memberRecord.firstName} ${memberRecord.lastName}`.trim()
            : params.memberId,
          partnerName: partnerShareSweepCounterpartNames(swept, params.memberId),
          reason: describePartnerSharedSweepReason("member_age_tier_changed"),
          nights: partnerShareSweepNights(swept),
        });
      } catch (err) {
        logger.error(
          { err, memberId: params.memberId, sweptCount: swept.length },
          "Failed to send partner share sweep alert",
        );
      }
    })();
  }

  // Best-effort Xero contact-group re-sync on a membership-type change (E8,
  // #1934). Grouping resolves at the CURRENT season year, so only a change to
  // the current season's assignment can alter a member's effective grouping —
  // future-season edits are left for their own trigger/bulk run. Non-fatal,
  // idempotent, and a no-op unless grouping is enabled.
  if (params.seasonYear === getSeasonYear() && !params.skipXeroContactGroupSync) {
    await triggerMemberXeroContactGroupSync(params.memberId, {
      createdByMemberId: params.adminMemberId,
      reason: "seasonal_membership_assignment",
    });
  }

  return jsonResult({
    assignment: serializeSeasonalMembershipAssignment(
      assignment as SeasonalAssignmentWithType,
    ),
    preview,
    changed: true,
  });
}

export type BulkSeasonalMembershipOutcome =
  | "changed"
  | "unchanged"
  | "stale"
  | "blocked_linked_guests"
  | "error";

export type BulkSeasonalMembershipMemberResult = {
  memberId: string;
  /** Display name so the outcomes view never has to render a raw id. */
  name: string;
  outcome: BulkSeasonalMembershipOutcome;
  /** HTTP-ish status the per-member save returned (undefined ⇒ 200/no-op). */
  status?: number;
  /** Error/blocked message surfaced back to the UI so the admin can act. */
  error?: string;
  /** The linked-guest block detail when outcome is `blocked_linked_guests`. */
  linkedGuestBookings?: LinkedGuestBookingSummary;
};

/**
 * Telemetry for the single deferred, best-effort Xero contact-group reconcile
 * that runs after the loop (surfaced to the UI so an admin sees when the
 * nightly reconcile still has to finish the group sync).
 */
export type BulkSeasonalMembershipXeroReconcile = {
  /** Members whose grouping actually changed and were handed to the reconcile. */
  attempted: number;
  /** Members whose Xero group membership was successfully synced in-request. */
  succeeded: number;
  /** True when the per-day Xero API budget cut the in-request reconcile short. */
  haltedByDailyLimit: boolean;
};

/**
 * #2107: thin bulk wrapper over {@link saveSeasonalMembershipAssignment}. Applies
 * the same membership-type change (shared reason, per-member HMAC preview token)
 * to many members, one call per member, and NEVER lets one member's failure
 * abort the rest:
 *
 * - a stale/missing preview token (409) is isolated as `stale`;
 * - an N/A-flip blocked by future linked-guest bookings (409) is isolated as
 *   `blocked_linked_guests`, carrying the block detail for the UI's "Preview
 *   again"/remove-links affordance;
 * - any other 4xx/5xx is isolated as `error`;
 * - a genuine no-op save writes nothing and is `unchanged` (no per-member audit,
 *   inherited from the single save);
 * - a real change is `changed` and its member id is collected for the deferred
 *   Xero reconcile.
 *
 * Each member still gets its own CRITICAL per-member audit row inside the single
 * save; this wrapper adds ONE important-severity summary audit for the run. The
 * per-member synchronous Xero contact-group sync is SUPPRESSED
 * (`skipXeroContactGroupSync`); after the loop a single deferred, best-effort
 * batched reconcile runs for the changed members when the target IS the current
 * season (grouping resolves at the current season only, matching the single
 * save).
 */
export async function bulkSaveSeasonalMembershipAssignments(params: {
  ids: string[];
  seasonYear: number;
  membershipTypeId: string;
  applyFrom?: string | null;
  adminMemberId: string;
  reason: string;
  previewTokens: Record<string, string>;
  request?: StructuredAuditEvent["request"];
  db?: typeof prisma;
}): Promise<JsonRouteResult> {
  const reason = params.reason.trim();
  if (!reason) {
    return jsonResult({ error: "Admin reason is required" }, { status: 400 });
  }

  const db = params.db ?? prisma;
  const results: BulkSeasonalMembershipMemberResult[] = [];
  const changedMemberIds: string[] = [];

  // De-duplicate ids so a repeated selection is not double-saved/double-counted.
  const uniqueIds = Array.from(new Set(params.ids));

  // Load display names up front so every per-member result carries a name and
  // the outcomes view never has to render a raw id.
  const memberRecords = await db.member.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  const nameById = new Map(
    memberRecords.map((member) => [member.id, memberDisplayName(member)]),
  );
  const nameFor = (memberId: string) => nameById.get(memberId) ?? memberId;

  for (const memberId of uniqueIds) {
    const previewToken = params.previewTokens[memberId];
    if (!previewToken) {
      // No token for a selected member: its preview is missing/stale. Treat like
      // a stale token so the UI offers "Preview again" rather than silently
      // dropping the member.
      results.push({
        memberId,
        name: nameFor(memberId),
        outcome: "stale",
        status: 409,
        error:
          "Membership type change preview is missing or stale. Preview the change again before saving.",
      });
      continue;
    }

    let saveResult: JsonRouteResult;
    try {
      saveResult = await saveSeasonalMembershipAssignment({
        memberId,
        seasonYear: params.seasonYear,
        membershipTypeId: params.membershipTypeId,
        applyFrom: params.applyFrom ?? null,
        adminMemberId: params.adminMemberId,
        reason,
        previewToken,
        request: params.request,
        db,
        // #2107: suppress the per-member sync; batch-reconcile once after the loop.
        skipXeroContactGroupSync: true,
      });
    } catch (err) {
      // A THROWN save (DB deadlock, P2025, a partner-share sweep failure) must
      // never abort the batch: isolate it as this member's `error` outcome and
      // keep processing the rest. The summary audit + response still happen.
      logger.error(
        {
          err,
          memberId,
          seasonYear: params.seasonYear,
          membershipTypeId: params.membershipTypeId,
        },
        "Bulk seasonal membership save threw for a member (isolated, continuing)",
      );
      results.push({
        memberId,
        name: nameFor(memberId),
        outcome: "error",
        error:
          err instanceof Error
            ? err.message
            : "The membership change failed unexpectedly for this member.",
      });
      continue;
    }

    const status = saveResult.init?.status;
    const body = saveResult.body as {
      changed?: boolean;
      error?: string;
      linkedGuestBookings?: LinkedGuestBookingSummary;
    };

    if (status && status >= 400) {
      if (status === 409 && body.linkedGuestBookings) {
        results.push({
          memberId,
          name: nameFor(memberId),
          outcome: "blocked_linked_guests",
          status,
          error: body.error,
          linkedGuestBookings: body.linkedGuestBookings,
        });
      } else if (status === 409) {
        results.push({
          memberId,
          name: nameFor(memberId),
          outcome: "stale",
          status,
          error: body.error,
        });
      } else {
        results.push({
          memberId,
          name: nameFor(memberId),
          outcome: "error",
          status,
          error: body.error,
        });
      }
      continue;
    }

    if (body.changed) {
      results.push({ memberId, name: nameFor(memberId), outcome: "changed", status });
      changedMemberIds.push(memberId);
    } else {
      results.push({ memberId, name: nameFor(memberId), outcome: "unchanged", status });
    }
  }

  const outcomeCounts = results.reduce<Record<BulkSeasonalMembershipOutcome, number>>(
    (counts, entry) => {
      counts[entry.outcome] += 1;
      return counts;
    },
    { changed: 0, unchanged: 0, stale: 0, blocked_linked_guests: 0, error: 0 },
  );

  // One important-severity summary audit for the whole run (the per-member
  // critical rows live inside each single save).
  await db.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: SEASONAL_MEMBERSHIP_BULK_ASSIGNMENT_ACTION,
      actor: { memberId: params.adminMemberId },
      entity: {
        type: "SeasonalMembershipAssignment",
        id: `bulk:${params.seasonYear}:${params.membershipTypeId}`,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Seasonal membership type changed in bulk",
      metadata: {
        seasonYear: params.seasonYear,
        membershipTypeId: params.membershipTypeId,
        applyFrom: params.applyFrom ?? null,
        adminReason: reason,
        requestedCount: uniqueIds.length,
        outcomeCounts,
        memberIds: uniqueIds.slice(0, BULK_ASSIGNMENT_MEMBER_ID_LIMIT),
      },
      request: params.request,
    }),
  );

  // Deferred, batched Xero contact-group reconcile for the members that actually
  // changed — a single connection check, only current-season changes alter
  // grouping at "now" (mirrors the single save). Post-commit and best-effort.
  //
  // Latency posture (#2107): saves run sequentially and this reconcile runs
  // in-request as a best-effort pass — deliberately NOT backgrounded. Every
  // membership change is already committed before we get here, so the reconcile
  // only reconciles Xero *group* membership: it is safe to re-run, and a client
  // timeout mid-reconcile cannot lose a committed change (the nightly reconcile
  // finishes any group sync the daily API budget or a timeout left undone).
  let xeroReconcile: BulkSeasonalMembershipXeroReconcile | null = null;
  if (changedMemberIds.length > 0 && params.seasonYear === getSeasonYear()) {
    const reconcileResult = await reconcileMembersXeroContactGroups(
      changedMemberIds,
      {
        createdByMemberId: params.adminMemberId,
        reason: "seasonal_membership_assignment_bulk",
      },
    );
    xeroReconcile = {
      attempted: changedMemberIds.length,
      succeeded: reconcileResult.processed,
      haltedByDailyLimit: reconcileResult.haltedByDailyLimit,
    };
  }

  return jsonResult({
    seasonYear: params.seasonYear,
    membershipTypeId: params.membershipTypeId,
    requestedCount: uniqueIds.length,
    outcomeCounts,
    results,
    xeroReconcile,
  });
}

function memberDisplayName(member: {
  firstName: string;
  lastName: string;
  email: string;
}) {
  return `${member.firstName} ${member.lastName}`.trim() || member.email;
}

export async function rollForwardSeasonalMembershipAssignments(params: {
  fromSeasonYear: number;
  toSeasonYear: number;
  adminMemberId: string;
  dryRun?: boolean;
  request?: StructuredAuditEvent["request"];
  db?: typeof prisma;
}): Promise<JsonRouteResult> {
  if (params.fromSeasonYear === params.toSeasonYear) {
    return jsonResult(
      { error: "Source and target seasons must be different" },
      { status: 400 },
    );
  }

  const db = params.db ?? prisma;
  const [sourceAssignments, targetAssignments, members] = await Promise.all([
    db.seasonalMembershipAssignment.findMany({
      where: { seasonYear: params.fromSeasonYear },
      include: assignmentWithMemberInclude,
      orderBy: [
        { member: { lastName: "asc" } },
        { member: { firstName: "asc" } },
      ],
    }),
    db.seasonalMembershipAssignment.findMany({
      where: { seasonYear: params.toSeasonYear },
      select: { memberId: true },
    }),
    db.member.findMany({
      where: { archivedAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        active: true,
        archivedAt: true,
        cancelledAt: true,
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
  ]);

  const sourceByMemberId = new Map(
    sourceAssignments.map((assignment) => [assignment.memberId, assignment]),
  );
  const targetMemberIds = new Set(
    targetAssignments.map((assignment) => assignment.memberId),
  );

  const exceptions: SeasonalMembershipRollForwardException[] = [];
  for (const member of members) {
    if (!sourceByMemberId.has(member.id) && !targetMemberIds.has(member.id)) {
      exceptions.push({
        code: "missing_prior_assignment",
        memberId: member.id,
        memberName: memberDisplayName(member),
        memberEmail: member.email,
      });
    }
  }

  const copyCandidates = sourceAssignments.filter(
    (assignment) =>
      !targetMemberIds.has(assignment.memberId) &&
      assignment.member.archivedAt === null,
  );
  for (const assignment of copyCandidates) {
    if (!assignment.membershipType.isActive) {
      exceptions.push({
        code: "inactive_membership_type",
        memberId: assignment.memberId,
        memberName: memberDisplayName(assignment.member),
        memberEmail: assignment.member.email,
        membershipTypeId: assignment.membershipTypeId,
        membershipTypeName: assignment.membershipType.name,
      });
    }
  }

  const data = copyCandidates.map((assignment) => ({
    memberId: assignment.memberId,
    seasonYear: params.toSeasonYear,
    membershipTypeId: assignment.membershipTypeId,
    applyFrom: null,
    assignedByMemberId: params.adminMemberId,
  }));

  const targetIsCurrentSeason = params.toSeasonYear === getSeasonYear();
  const rollSweptByMember: Array<{
    memberId: string;
    memberName: string;
    swept: SweptPartnerSharedAllocation[];
  }> = [];
  let copiedCount = 0;
  // #2106 (MAJOR-4): reconcile-phase tallies, populated post-copy in chunks.
  let ageTierReconciledCount = 0;
  let partnerSharesSweptCount = 0;
  const ageTierReconcileSamples: Array<{
    memberId: string;
    previousAgeTier: AgeTier;
    newAgeTier: AgeTier;
  }> = [];
  if (!params.dryRun) {
    // MAJOR-3: the assignment COPY stays in one transaction, but the
    // membership-wide per-member tier reconcile + partner-share sweep are moved
    // OUT of it. Running them inside the copy transaction put the whole
    // membership under a single ~5s transaction; instead we commit the copy,
    // then reconcile post-copy in bounded chunks so no single transaction spans
    // the membership.
    copiedCount = await db.$transaction(async (tx) => {
      const result =
        data.length > 0
          ? await tx.seasonalMembershipAssignment.createMany({
              data,
              skipDuplicates: true,
            })
          : { count: 0 };

      await tx.auditLog.create(
        buildStructuredAuditLogCreateArgs({
          action: SEASONAL_MEMBERSHIP_ASSIGNMENTS_ROLLED_FORWARD_ACTION,
          actor: { memberId: params.adminMemberId },
          entity: {
            type: "SeasonalMembershipAssignment",
            id: `${params.fromSeasonYear}->${params.toSeasonYear}`,
          },
          category: "admin",
          severity: "important",
          outcome: "success",
          summary: "Seasonal membership assignments rolled forward",
          metadata: {
            fromSeasonYear: params.fromSeasonYear,
            toSeasonYear: params.toSeasonYear,
            copiedCount: result.count,
            sourceAssignmentCount: sourceAssignments.length,
            skippedExistingCount: targetAssignments.length,
            exceptionCount: exceptions.length,
            exceptions: exceptions.slice(0, 50),
          },
          request: params.request,
        }),
      );

      return result.count;
    });

    // #2106: when rolling forward INTO the current season, the copied type
    // becomes each member's effective current-season type, so reconcile their
    // stored age tier (force N/A on FORCED types / org accounts, restore a person
    // tier otherwise) and sweep future shared-doubles for an ADULT → N/A flip
    // (#1756). Future-season roll-forwards never change the tier at "now".
    //
    // MAJOR-3: processed AFTER the copy commits, in chunks of
    // ROLL_FORWARD_RECONCILE_CHUNK_SIZE members per transaction. Each chunk
    // re-reads the member + their now-current membership type on its own tx
    // client, so a stale pre-copy read cannot misflip a tier that changed
    // between the copy and the reconcile. A chunk that throws is logged and
    // skipped — it never rolls back the committed copy or the other chunks; the
    // enforcement sites self-heal any member the failed chunk left unreconciled.
    if (targetIsCurrentSeason && copiedCount > 0) {
      const candidateMemberIds = copyCandidates.map(
        (candidate) => candidate.memberId,
      );
      for (
        let offset = 0;
        offset < candidateMemberIds.length;
        offset += ROLL_FORWARD_RECONCILE_CHUNK_SIZE
      ) {
        const chunkMemberIds = candidateMemberIds.slice(
          offset,
          offset + ROLL_FORWARD_RECONCILE_CHUNK_SIZE,
        );
        try {
          const chunkResult = await db.$transaction(async (tx) => {
            await acquireFuturePartnerSharedAllocationLocks(tx, chunkMemberIds);
            await acquireMemberLifecycleLocks(tx, chunkMemberIds);
            // Fresh reads on the tx client — never trust the pre-copy snapshot.
            const [freshMembers, freshAssignments] = await Promise.all([
              tx.member.findMany({
                where: { id: { in: chunkMemberIds } },
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                  ageTier: true,
                  dateOfBirth: true,
                  role: true,
                  accessRoles: { select: { role: true } },
                },
              }),
              tx.seasonalMembershipAssignment.findMany({
                where: {
                  seasonYear: params.toSeasonYear,
                  memberId: { in: chunkMemberIds },
                },
                select: {
                  memberId: true,
                  membershipType: {
                    select: {
                      subscriptionBehavior: true,
                      allowedAgeTiers: { select: { ageTier: true } },
                    },
                  },
                },
              }),
            ]);
            const exemptionByMemberId = new Map(
              freshAssignments.map((assignment) => [
                assignment.memberId,
                membershipTypeAgeExemption(
                  assignment.membershipType.allowedAgeTiers.map(
                    (tier) => tier.ageTier,
                  ),
                ),
              ]),
            );
            const behaviorByMemberId = new Map(
              freshAssignments.map((assignment) => [
                assignment.memberId,
                assignment.membershipType.subscriptionBehavior,
              ]),
            );

            const chunkReconciled: Array<{
              memberId: string;
              previousAgeTier: AgeTier;
              newAgeTier: AgeTier;
            }> = [];
            const chunkSwept: Array<{
              memberId: string;
              memberName: string;
              swept: SweptPartnerSharedAllocation[];
            }> = [];

            for (const member of freshMembers) {
              // No current-season assignment (a concurrent write removed/skipped
              // it) means no type force applies here — leave the tier to its own
              // enforcement site rather than un-forcing on a vanished type.
              const exemption = exemptionByMemberId.get(member.id);
              if (exemption === undefined) {
                continue;
              }
              const currentAgeTier: AgeTier = member.ageTier ?? "ADULT";
              const restorePersonTier: AgeTier =
                currentAgeTier !== "NOT_APPLICABLE"
                  ? currentAgeTier
                  : member.dateOfBirth
                    ? await computeAgeTier(
                        member.dateOfBirth,
                        getSeasonStartDate(getSeasonYear()),
                      )
                    : "ADULT";
              const resolved = resolveEnforcedAgeTier({
                isOrganisation: isOrganisationMember({
                  accessRoleTokens: resolveAccessRoleTokens(member),
                  legacyRole: member.role,
                }),
                typeExemption: exemption,
                currentAgeTier,
                restorePersonTier,
              });
              if (!resolved.ok || resolved.ageTier === currentAgeTier) {
                continue;
              }
              await tx.member.update({
                where: { id: member.id },
                data: { ageTier: resolved.ageTier },
              });
              chunkReconciled.push({
                memberId: member.id,
                previousAgeTier: currentAgeTier,
                newAgeTier: resolved.ageTier,
              });
              if (currentAgeTier === "ADULT" && resolved.ageTier !== "ADULT") {
                const swept = await sweepFuturePartnerSharedAllocationsWithLocksHeld({
                  memberId: member.id,
                  reason: "member_age_tier_changed",
                  db: tx,
                });
                if (swept.length > 0) {
                  chunkSwept.push({
                    memberId: member.id,
                    memberName: memberDisplayName(member),
                    swept,
                  });
                }
              }
            }

            // #2149 F1: a REQUIRED type copied into the CURRENT season supersedes
            // any stale creation-seeded NOT_REQUIRED row, exactly as the single
            // save path does. Idempotent + status-guarded; keyed off the copied
            // type's behaviour so BASED_ON_AGE_TIER / NOT_REQUIRED rows are left
            // to the #2041 dominance rule.
            for (const [memberId, subscriptionBehavior] of behaviorByMemberId) {
              await reconcileSeasonSubscriptionForAssignment(tx, {
                memberId,
                seasonYear: params.toSeasonYear,
                subscriptionBehavior,
              });
            }
            return { chunkReconciled, chunkSwept };
          });

          ageTierReconciledCount += chunkResult.chunkReconciled.length;
          for (const entry of chunkResult.chunkReconciled) {
            if (ageTierReconcileSamples.length < ROLL_FORWARD_RECONCILE_SAMPLE_LIMIT) {
              ageTierReconcileSamples.push(entry);
            }
          }
          for (const entry of chunkResult.chunkSwept) {
            partnerSharesSweptCount += entry.swept.length;
            rollSweptByMember.push(entry);
          }
        } catch (err) {
          logger.error(
            {
              err,
              fromSeasonYear: params.fromSeasonYear,
              toSeasonYear: params.toSeasonYear,
              chunkMemberIds,
            },
            "Roll-forward age-tier reconcile chunk failed; continuing",
          );
        }
      }

      // MAJOR-4: one summary audit row for the (post-copy) reconcile phase,
      // severity critical to match the save-path tier-change convention. Written
      // on the bare client after all chunks so it reflects the final tallies.
      await db.auditLog.create(
        buildStructuredAuditLogCreateArgs({
          action:
            SEASONAL_MEMBERSHIP_ROLL_FORWARD_TIERS_RECONCILED_ACTION,
          actor: { memberId: params.adminMemberId },
          entity: {
            type: "SeasonalMembershipAssignment",
            id: `${params.fromSeasonYear}->${params.toSeasonYear}`,
          },
          category: "admin",
          severity: "critical",
          outcome: "success",
          summary: "Roll-forward age tiers reconciled",
          metadata: {
            fromSeasonYear: params.fromSeasonYear,
            toSeasonYear: params.toSeasonYear,
            copiedCount,
            ageTierReconciledCount,
            partnerSharesSweptCount,
            ageTierReconciled: ageTierReconcileSamples,
            ageTierReconciledTruncated:
              ageTierReconciledCount > ageTierReconcileSamples.length,
          },
          request: params.request,
        }),
      );
    }

    // Best-effort Xero contact-group re-sync (E8, #1934). Roll-forward usually
    // targets a future season, which does not change any member's grouping at
    // "now"; only fire when the target IS the current season. Sequential,
    // non-fatal, and each call is a no-op unless grouping is enabled. Fire
    // only for candidates that actually hold a target-season assignment now —
    // createMany(skipDuplicates) may have skipped rows created concurrently
    // since the pre-read, and those members' grouping did not change here.
    if (copiedCount > 0 && params.toSeasonYear === getSeasonYear()) {
      const copiedRows = await db.seasonalMembershipAssignment.findMany({
        where: {
          seasonYear: params.toSeasonYear,
          memberId: { in: copyCandidates.map((candidate) => candidate.memberId) },
        },
        select: { memberId: true },
      });
      const copiedMemberIds = new Set(copiedRows.map((row) => row.memberId));
      for (const assignment of copyCandidates) {
        if (!copiedMemberIds.has(assignment.memberId)) continue;
        await triggerMemberXeroContactGroupSync(assignment.memberId, {
          createdByMemberId: params.adminMemberId,
          reason: "seasonal_membership_roll_forward",
        });
      }
    }

    // #2106: post-commit partner-share sweep alerts for ADULT → N/A roll-forward
    // flips. Fire-and-forget; the sweeps already committed with the roll-forward.
    for (const entry of rollSweptByMember) {
      sendAdminPartnerShareSweptAlert({
        memberName: entry.memberName,
        partnerName: partnerShareSweepCounterpartNames(entry.swept, entry.memberId),
        reason: describePartnerSharedSweepReason("member_age_tier_changed"),
        nights: partnerShareSweepNights(entry.swept),
      }).catch((err) => {
        logger.error(
          { err, memberId: entry.memberId, sweptCount: entry.swept.length },
          "Failed to send partner share sweep alert",
        );
      });
    }
  }

  return jsonResult({
    fromSeasonYear: params.fromSeasonYear,
    toSeasonYear: params.toSeasonYear,
    dryRun: Boolean(params.dryRun),
    sourceAssignmentCount: sourceAssignments.length,
    wouldCopyCount: data.length,
    copiedCount,
    skippedExistingCount: targetAssignments.length,
    exceptionCount: exceptions.length,
    exceptions,
  });
}
