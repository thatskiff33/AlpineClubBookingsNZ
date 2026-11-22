/**
 * What the Bookings & Beds review-queue officer actions return (ALP-719,
 * `INV-MCP-006`): change and exception requests, booking reviews, the
 * waitlist, occupancy and promo codes. The catalogue entry and the route's
 * `connectionJson` both read these (`INV-SSOT`).
 *
 * Where a route builds its answer inline, the answer's type is declared here
 * and the route builds its answer as that type, so a shape cannot name a field
 * the route does not send. Types only from the route modules: nothing here
 * reaches the database.
 *
 * Left out on purpose, for the connection only (the admin screens still get
 * them): email addresses of members and booking owners, the ids of the
 * officers who reviewed a request, the controls only a website decision uses
 * (the officer's guest and promo entry, the request `version`, a proposal's
 * hash), each promo code's per-member allocation rows (the redemptions report
 * answers usage), and the internals of an email delivery attempt.
 */
import type {
  AdminReviewStatus,
  Booking,
  BookingGuest,
  BookingStatus,
  Lodge,
  Member,
  PolicyExceptionCapacityMode,
  Prisma,
  PromoCode,
  PromoCodeAssignment,
  PromoRedemption,
  PromoRedemptionAllocation,
} from "@prisma/client";

import type { AdminListPage } from "@/lib/admin-list-page";
import type { OccupancyMonth } from "@/lib/admin-occupancy";
import type { includeRequestDetail } from "@/lib/booking-change-request-admin-decision";
import type {
  RequestedGuestNights,
  StoredLockedPeriodRequest,
  storedRequestPromoFacts,
} from "@/lib/booking-change-request-stored";
import type { UnifiedExceptionQueueItem } from "@/lib/booking-exception-request-service";
import type { ExceptionProposalSnapshot, FrozenPolicyExceptionEvidence } from "@/lib/booking-exception-requests";
import type { BookingReviewReasonCode } from "@/lib/booking-review";
import { connectionShapeFor, type ConnectionShapeFor } from "@/lib/connection-projection";
import type { WaitlistOfferEmailDelivery } from "@/lib/waitlist-offer-email-visibility";

// ── Occupancy ───────────────────────────────────────────────────────────────

const OCCUPANCY_BOOKING_SHAPE = {
  id: true,
  reference: true,
  ownerName: true,
  checkIn: true,
  checkOut: true,
  guestCount: true,
  status: true,
} as const;

export const ADMIN_OCCUPANCY_CONNECTION_SHAPE = connectionShapeFor<OccupancyMonth>({
  month: true,
  startDate: true,
  endDate: true,
  nights: { date: true, guestCount: true, bookings: OCCUPANCY_BOOKING_SHAPE },
  bookings: OCCUPANCY_BOOKING_SHAPE,
});

// ── Shared pieces ───────────────────────────────────────────────────────────

/** A person named on a request or booking, by name only. */
const PERSON_NAME_FIELDS = { firstName: true, lastName: true } as const;

/** A guest on a booking, as the review screens list them. */
type QueueGuest = Pick<BookingGuest, "id" | "firstName" | "lastName" | "ageTier" | "isMember">;

const QUEUE_GUEST_FIELDS = { firstName: true, lastName: true, ageTier: true, isMember: true } as const;

const LIST_PAGE_FIELDS = { page: true, pageSize: true, total: true, totalPages: true } as const;

// ── Locked-period change requests ───────────────────────────────────────────

/** `GET /api/admin/booking-change-requests/[id]`: one request as stored, with its people and booking. */
export type AdminChangeRequestDetail = Prisma.BookingChangeRequestGetPayload<{ include: typeof includeRequestDetail }>;

/** One row of `GET /api/admin/booking-change-requests`. */
export type AdminChangeRequestQueueRow = Omit<AdminChangeRequestDetail, "booking"> & {
  booking: Omit<AdminChangeRequestDetail["booking"], "memberId">;
  executesOnApproval: boolean;
  acceptsOfficerGuests: boolean;
  acceptsOfficerPromo: boolean;
  officerPromoBase: { bookerCodes: string[]; multiPromoCodes: boolean } | null;
  promoCorrection: ReturnType<typeof storedRequestPromoFacts>["promoCorrection"];
  requestedGuestNights: RequestedGuestNights[];
};

export type AdminChangeRequestQueueAnswer = AdminListPage & {
  data: AdminChangeRequestQueueRow[];
  memberGuestFind: { openSearchEnabled: boolean } | null;
};

/**
 * The stored request (a JSON column) as the officer's card reads it: the
 * executor's schema, plus the member's one-line `summary` the card heads it
 * with. The shapes are checked against this reading of the column.
 */
type StoredRequestedChanges = StoredLockedPeriodRequest & { requested: { summary?: string | null } };

type WithStoredChanges<T> = Omit<T, "requestedChanges"> & { requestedChanges: StoredRequestedChanges };

const CHANGE_REQUEST_FIELDS = {
  id: true,
  bookingId: true,
  kind: true,
  status: true,
  requestedChanges: {
    requested: {
      summary: true,
      checkIn: true,
      checkOut: true,
      addGuests: {
        firstName: true,
        lastName: true,
        ageTier: true,
        isMember: true,
        stayStart: true,
        stayEnd: true,
        nights: true,
      },
    },
  },
  reason: true,
  adminNotes: true,
  internalNotes: true,
  createdAt: true,
  reviewedAt: true,
  requestedBy: PERSON_NAME_FIELDS,
  reviewedBy: PERSON_NAME_FIELDS,
  linkedModification: { id: true, modificationType: true, priceDiffCents: true, changeFeeCents: true },
  booking: {
    id: true,
    checkIn: true,
    checkOut: true,
    status: true,
    finalPriceCents: true,
    // The owner: a member (whose id opens their record) or an organisation.
    member: { id: true, ...PERSON_NAME_FIELDS },
    organisation: { name: true },
    payment: { status: true, amountCents: true, refundedAmountCents: true, xeroInvoiceNumber: true },
  },
} as const satisfies ConnectionShapeFor<WithStoredChanges<AdminChangeRequestDetail>>;

export const ADMIN_CHANGE_REQUEST_CONNECTION_SHAPE =
  connectionShapeFor<WithStoredChanges<AdminChangeRequestDetail>>(CHANGE_REQUEST_FIELDS);

export const ADMIN_CHANGE_REQUEST_QUEUE_CONNECTION_SHAPE = connectionShapeFor<
  Omit<AdminChangeRequestQueueAnswer, "data"> & { data: WithStoredChanges<AdminChangeRequestQueueRow>[] }
>({
  ...LIST_PAGE_FIELDS,
  data: {
    ...CHANGE_REQUEST_FIELDS,
    executesOnApproval: true,
    promoCorrection: { codes: true, onlyChange: true },
    requestedGuestNights: {
      name: true,
      runs: { firstNight: true, lastNight: true },
      nightCount: true,
      added: true,
      unchanged: true,
      fillsGaps: true,
    },
  },
});

// ── Booking-policy exception requests ───────────────────────────────────────

/** `GET /api/admin/booking-exception-requests`. */
export type AdminExceptionRequestQueueAnswer = { data: UnifiedExceptionQueueItem[] } & AdminListPage;

export const ADMIN_EXCEPTION_REQUEST_QUEUE_CONNECTION_SHAPE = connectionShapeFor<AdminExceptionRequestQueueAnswer>({
  ...LIST_PAGE_FIELDS,
  data: {
    source: true,
    id: true,
    status: true,
    createdAt: true,
    bookingId: true,
    lodgeId: true,
    requestedBy: PERSON_NAME_FIELDS,
    reviewedBy: PERSON_NAME_FIELDS,
    reviewedAt: true,
    memberMessage: true,
    aggregateCapacityMode: true,
    reasonCodes: true,
    policyRefs: { reasonCode: true, policyId: true, policyVersion: true, capacityMode: true },
    hostingConsequence: true,
    affectedNights: true,
    proposedCheckIn: true,
    proposedCheckOut: true,
    proposedGuestCount: true,
    adminNotes: true,
    internalNotes: true,
    createdBookingId: true,
    attemptCount: true,
    conflictCount: true,
    lastConflictAt: true,
    lastConflictReason: true,
    supersededByRequestId: true,
    summary: true,
  },
});

/** One guest of the party an approval would create or leave behind (#2526 review). */
export interface AdminExceptionRequestProposedGuest {
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  nights: string[];
  /** True when this guest is a MEMBER being attached to the booking. */
  isMemberGuest: boolean;
  /**
   * True when that member is OUTSIDE the requester's family group — the case the
   * member's own booking path either refuses outright or turns into a consent
   * request. Null when there is no member id to judge.
   */
  beyondFamily: boolean | null;
}

type ExceptionActor = Pick<Member, "id" | "firstName" | "lastName">;

/** `GET /api/admin/booking-exception-requests/[id]`: either flavour of request. */
export interface AdminExceptionRequestDetailAnswer {
  source: "MODIFICATION" | "NEW_BOOKING";
  id: string;
  status: string;
  version: number;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewedBy: ExceptionActor | null;
  requestedBy: (ExceptionActor & Pick<Member, "email">) | null;
  memberMessage: string | null;
  adminNotes: string | null;
  internalNotes: string | null;
  proposalHash: string | null;
  aggregateCapacityMode: PolicyExceptionCapacityMode | null;
  conflictCount: number;
  lastConflictAt: Date | null;
  lastConflictReason: string | null;
  supersededByRequestId: string | null;
  proposal: ExceptionProposalSnapshot | null;
  proposedGuests: AdminExceptionRequestProposedGuest[];
  evidence: FrozenPolicyExceptionEvidence | null;
  /** The live booking a change request is about; null for a new booking. */
  booking:
    | (Pick<Booking, "id" | "checkIn" | "checkOut" | "status" | "finalPriceCents" | "lodgeId"> & {
        member: Pick<Member, "id" | "firstName" | "lastName" | "email"> | null;
      })
    | null;
  /** The lodge a new booking would be at; null for a change request. */
  lodge: Pick<Lodge, "id" | "name"> | null;
  createdBookingId: string | null;
}

/**
 * Exactly one of `booking` (a change request) and `lodge` (a new booking) is
 * filled; the other is null.
 */
export const ADMIN_EXCEPTION_REQUEST_DETAIL_CONNECTION_SHAPE = connectionShapeFor<AdminExceptionRequestDetailAnswer>({
  source: true,
  id: true,
  status: true,
  createdAt: true,
  reviewedAt: true,
  reviewedBy: PERSON_NAME_FIELDS,
  requestedBy: PERSON_NAME_FIELDS,
  memberMessage: true,
  adminNotes: true,
  internalNotes: true,
  aggregateCapacityMode: true,
  conflictCount: true,
  lastConflictAt: true,
  lastConflictReason: true,
  supersededByRequestId: true,
  proposal: { kind: true, lodgeId: true, proposed: { checkIn: true, checkOut: true } },
  proposedGuests: {
    firstName: true,
    lastName: true,
    ageTier: true,
    isMember: true,
    nights: true,
    isMemberGuest: true,
    beyondFamily: true,
  },
  evidence: {
    capacityMode: true,
    reasonCodes: true,
    affectedNights: true,
    violations: { reasonCode: true, message: true, affectedNights: true, capacityMode: true },
  },
  booking: {
    id: true,
    checkIn: true,
    checkOut: true,
    status: true,
    finalPriceCents: true,
    lodgeId: true,
    member: PERSON_NAME_FIELDS,
  },
  lodge: { id: true, name: true },
  createdBookingId: true,
});

// ── Booking reviews ─────────────────────────────────────────────────────────

/** One row of `GET /api/admin/booking-reviews`: the booking with its review facts. */
export type AdminBookingReviewRow = Booking & {
  member: Pick<Member, "id" | "firstName" | "lastName" | "email"> | null;
  adminReviewedBy: Pick<Member, "id" | "firstName" | "lastName"> | null;
  guests: QueueGuest[];
  reviewReasonCodes: BookingReviewReasonCode[];
  reviewReasons: string[];
};

export type AdminBookingReviewQueueAnswer = AdminListPage & { data: AdminBookingReviewRow[] };

export const ADMIN_BOOKING_REVIEW_QUEUE_CONNECTION_SHAPE = connectionShapeFor<AdminBookingReviewQueueAnswer>({
  ...LIST_PAGE_FIELDS,
  data: {
    id: true,
    lodgeId: true,
    checkIn: true,
    checkOut: true,
    status: true,
    finalPriceCents: true,
    createdAt: true,
    requiresAdminReview: true,
    adminReviewStatus: true,
    adminReviewReason: true,
    adminReviewNotes: true,
    adminReviewedAt: true,
    adultMemberHostingReviewStatus: true,
    adultMemberHostingReviewReason: true,
    member: { id: true, ...PERSON_NAME_FIELDS },
    adminReviewedBy: PERSON_NAME_FIELDS,
    guests: QUEUE_GUEST_FIELDS,
    reviewReasonCodes: true,
    reviewReasons: true,
  },
});

// ── Waitlist ────────────────────────────────────────────────────────────────

/** One entry of `GET /api/admin/waitlist`. */
export interface AdminWaitlistEntry {
  id: string;
  memberName: string;
  memberEmail: Member["email"];
  /** The owner's member id; null for an organisation. */
  memberId: string | null;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  guests: QueueGuest[];
  status: BookingStatus;
  waitlistPosition: number | null;
  waitlistOfferedAt: string | null;
  waitlistOfferExpiresAt: string | null;
  requiresAdminReview: boolean;
  adminReviewReason: string | null;
  adminReviewStatus: AdminReviewStatus | null;
  noEmails: boolean;
  finalPriceCents: number;
  createdAt: string;
  offerEmailDelivery: WaitlistOfferEmailDelivery | null;
}

/** The browser reads `entries`; `data` is the same list. */
export interface AdminWaitlistAnswer {
  data: AdminWaitlistEntry[];
  entries: AdminWaitlistEntry[];
  page: number;
  pageSize: number;
  total: number;
}

export const ADMIN_WAITLIST_CONNECTION_SHAPE = connectionShapeFor<AdminWaitlistAnswer>({
  page: true,
  pageSize: true,
  total: true,
  data: {
    id: true,
    memberName: true,
    memberId: true,
    checkIn: true,
    checkOut: true,
    guestCount: true,
    guests: QUEUE_GUEST_FIELDS,
    status: true,
    waitlistPosition: true,
    waitlistOfferedAt: true,
    waitlistOfferExpiresAt: true,
    requiresAdminReview: true,
    adminReviewReason: true,
    adminReviewStatus: true,
    noEmails: true,
    finalPriceCents: true,
    createdAt: true,
    offerEmailDelivery: {
      status: true,
      attempts: true,
      lastAttemptAt: true,
      retryState: true,
      needsOperatorAction: true,
    },
  },
});

// ── Promo codes ─────────────────────────────────────────────────────────────

/** A promo code with its assigned members and lodge restriction, as the create, update and read routes answer it. */
export type AdminPromoCodeView = PromoCode & {
  assignments: Array<PromoCodeAssignment & { member: Pick<Member, "id" | "firstName" | "lastName" | "email"> }>;
  lodgeIds: string[];
};

/** One code of `GET /api/admin/promo-codes`. */
export type AdminPromoCodeListRow = AdminPromoCodeView & {
  totalRedemptionCount: number;
  benefitFreeRedemptionCount: number;
};

const PROMO_CODE_FIELDS = {
  id: true,
  code: true,
  description: true,
  type: true,
  valueCents: true,
  percentOff: true,
  freeNightsPerIndividual: true,
  lifetimeFreeNightsCap: true,
  fixedNightlyPriceCents: true,
  fixedNightlyMode: true,
  maxNightlyValueCents: true,
  maxGuestsPerBooking: true,
  maxRedemptionsTotal: true,
  maxUniqueMembersTotal: true,
  maxUsesPerMember: true,
  currentRedemptions: true,
  validFrom: true,
  validUntil: true,
  bookingStartFrom: true,
  bookingStartUntil: true,
  membersOnly: true,
  memberGuestsOnly: true,
  assignedMembersOnlyOwnNights: true,
  xeroItemCode: true,
  xeroAccountCode: true,
  active: true,
  archivedAt: true,
  lodgeIds: true,
  // The member id is what `assignedMemberIds` takes back.
  assignments: { memberId: true, member: PERSON_NAME_FIELDS },
} as const satisfies ConnectionShapeFor<AdminPromoCodeView>;

/** Read, create and update answer one code. */
export const ADMIN_PROMO_CODE_CONNECTION_SHAPE = connectionShapeFor<AdminPromoCodeView>(PROMO_CODE_FIELDS);

/** The list route answers the browser a bare array; a connection gets it under `promoCodes`. */
export const ADMIN_PROMO_CODE_LIST_CONNECTION_SHAPE = connectionShapeFor<{ promoCodes: AdminPromoCodeListRow[] }>({
  promoCodes: { ...PROMO_CODE_FIELDS, totalRedemptionCount: true, benefitFreeRedemptionCount: true },
});

/** `DELETE /api/admin/promo-codes/[id]`: archived when the code was ever applied, else deleted. */
export interface AdminPromoCodeDeletedAnswer {
  success: true;
  archived: boolean;
}

export const ADMIN_PROMO_CODE_DELETED_CONNECTION_SHAPE = connectionShapeFor<AdminPromoCodeDeletedAnswer>({
  success: true,
  archived: true,
});

/** `PATCH /api/admin/promo-codes/[id]`: an archived code restored. */
export interface AdminPromoCodeRestoredAnswer {
  success: true;
}

export const ADMIN_PROMO_CODE_RESTORED_CONNECTION_SHAPE = connectionShapeFor<AdminPromoCodeRestoredAnswer>({
  success: true,
});

/** One use of a code on `GET /api/admin/promo-codes/[id]/redemptions`. */
export interface AdminPromoRedemptionRow {
  id: string;
  createdAt: string;
  /** The booking's owner: a member (with their id) or an organisation (id null). */
  member: { id: PromoRedemption["memberId"]; name: string; email: Member["email"] };
  booking: {
    id: string;
    reference: string;
    lodgeId: string;
    lodgeName: string;
    checkIn: string;
    checkOut: string;
    nights: number;
  };
  eligibleGuestCount: PromoRedemption["eligibleGuestCount"];
  discountCents: number;
  priceAdjustmentCents: number;
  freeNightsUsed: number;
  gaveBenefit: boolean;
  memberUseIndex: number;
  /** The per-member split, only on a use shared by more than one member. */
  allocations: Array<
    Pick<PromoRedemptionAllocation, "memberId" | "discountCents" | "freeNightsUsed"> & { name: string }
  >;
}

interface AdminPromoRedemptionTotals {
  redemptions: number;
  uniqueMembers: number;
  discountCents: number;
  freeNightsUsed: number;
  benefitFreeRedemptions: number;
}

export interface AdminPromoRedemptionReport {
  code: Pick<PromoCode, "id" | "code" | "description" | "type" | "active" | "internal" | "currentRedemptions"> & {
    archived: boolean;
    capUsage: { redemptions: number; uniqueMembers: number };
    caps: Pick<PromoCode, "maxRedemptionsTotal" | "maxUniqueMembersTotal" | "maxUsesPerMember" | "lifetimeFreeNightsCap">;
  };
  totals: { all: AdminPromoRedemptionTotals; filtered: AdminPromoRedemptionTotals };
  pagination: { page: number; pageSize: number; total: number };
  /** The CSV export's completeness marker; null except on the website's export. */
  export: { truncated: boolean; limit: number; rowCount: number; matchedRowCount: number } | null;
  rows: AdminPromoRedemptionRow[];
}

const PROMO_REDEMPTION_TOTAL_FIELDS = {
  redemptions: true,
  uniqueMembers: true,
  discountCents: true,
  freeNightsUsed: true,
  benefitFreeRedemptions: true,
} as const;

export const ADMIN_PROMO_REDEMPTIONS_CONNECTION_SHAPE = connectionShapeFor<AdminPromoRedemptionReport>({
  code: {
    id: true,
    code: true,
    description: true,
    type: true,
    active: true,
    archived: true,
    internal: true,
    currentRedemptions: true,
    capUsage: { redemptions: true, uniqueMembers: true },
    caps: {
      maxRedemptionsTotal: true,
      maxUniqueMembersTotal: true,
      maxUsesPerMember: true,
      lifetimeFreeNightsCap: true,
    },
  },
  totals: { all: PROMO_REDEMPTION_TOTAL_FIELDS, filtered: PROMO_REDEMPTION_TOTAL_FIELDS },
  pagination: { page: true, pageSize: true, total: true },
  rows: {
    id: true,
    createdAt: true,
    member: { id: true, name: true },
    booking: {
      id: true,
      reference: true,
      lodgeId: true,
      lodgeName: true,
      checkIn: true,
      checkOut: true,
      nights: true,
    },
    eligibleGuestCount: true,
    discountCents: true,
    priceAdjustmentCents: true,
    freeNightsUsed: true,
    gaveBenefit: true,
    memberUseIndex: true,
    allocations: { memberId: true, name: true, discountCents: true, freeNightsUsed: true },
  },
});
