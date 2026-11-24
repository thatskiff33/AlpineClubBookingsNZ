/**
 * What each AI app booking action returns (ALP-794, `INV-MCP-006`): the shapes
 * `catalogue-bookings.ts` and the booking routes' projections both read
 * (`INV-SSOT`). Split from `connection-shapes.ts`, as the booking actions are
 * from `catalogue.ts`, so each module stays within its size budget; the rules
 * in that module's header apply here unchanged.
 *
 * Types only from the route modules: nothing here reaches the database.
 */
import type { BookingChangeRequest, RefundRequest } from "@prisma/client";

import type { ChangeRequestEstimate } from "@/lib/booking-change-request-guests";
import type { DeleteBookingResult } from "@/lib/booking-delete";
import type { CreatedExceptionRequest } from "@/lib/booking-exception-request-service";
import type { PolicyExceptionViolation } from "@/lib/booking-policy-exceptions";
import {
  completeConnectionShapeFor,
  connectionShapeFor,
  type CompleteConnectionShapeFor,
  type ConnectionShape,
  type EveryFieldOf,
} from "@/lib/connection-projection";
import type { MemberExceptionProposal, MemberExceptionRequestItem } from "@/lib/member-exception-requests";
import type { PriceBreakdown } from "@/lib/policies/pricing";
import type { AvailablePromoCode } from "@/lib/promo";

/** Free beds each night of one stay, and the lodge's capacity they are out of. */
export const STAY_AVAILABILITY_CONNECTION_SHAPE = completeConnectionShapeFor<{
  lodgeCapacity: number;
  minAvailable: number;
  nightDetails: Array<{ date: string; occupiedBeds: number; availableBeds: number }>;
}>({
  lodgeCapacity: true,
  minAvailable: true,
  nightDetails: { date: true, occupiedBeds: true, availableBeds: true },
});

/**
 * Whether a stay meets the minimum-stay rules, each broken rule in words, and
 * the cancellation schedule. Not the rule's internal scope or requirement
 * evidence, which an officer reviews.
 */
export const BOOKING_RULES_CONNECTION_SHAPE = connectionShapeFor<{
  valid: boolean;
  message: string | null;
  cancellationSchedule: string[] | null;
  violations: PolicyExceptionViolation[];
}>({
  valid: true,
  message: true,
  cancellationSchedule: true,
  violations: { reasonCode: true, message: true, affectedNights: true, capacityMode: true },
});

/** For `list_lodge_rooms` and `list_requestable_rooms`: the rooms a member may ask for. */
export const LODGE_ROOMS_CONNECTION_SHAPE = completeConnectionShapeFor<{
  enabled: boolean;
  rooms: Array<{ id: string; name: string; bedCount: number }>;
}>({
  enabled: true,
  rooms: { id: true, name: true, bedCount: true },
});

/** The member's own visible promo codes, as the booking page lists them. */
export const MEMBER_PROMO_CODES_CONNECTION_SHAPE: ConnectionShape = {
  promoCodes: completeConnectionShapeFor<AvailablePromoCode>({
    code: true,
    description: true,
    type: true,
    percentOff: true,
    valueCents: true,
    freeNightsPerIndividual: true,
    lifetimeFreeNightsCap: true,
    fixedNightlyPriceCents: true,
    fixedNightlyMode: true,
  }),
};

export const BOOKING_NOTE_CONNECTION_SHAPE = completeConnectionShapeFor<{ id: string; notes: string | null }>({
  id: true,
  notes: true,
});

export const ARRIVAL_TIME_CONNECTION_SHAPE = completeConnectionShapeFor<{
  id: string;
  expectedArrivalTime: string | null;
}>({
  id: true,
  expectedArrivalTime: true,
});

export const REQUESTED_ROOM_CONNECTION_SHAPE = completeConnectionShapeFor<{
  id: string;
  requestedRoomId: string | null;
  requestedRoom: { id: string; name: string; active: boolean } | null;
}>({
  id: true,
  requestedRoomId: true,
  requestedRoom: { id: true, name: true, active: true },
});

/**
 * One change request on a booking: what was asked, in the request's own
 * summary, and the decision. Never the stored payment snapshot (Stripe and
 * Xero ids), the frozen proposal, its hash or evidence, or who reviewed it.
 */
const BOOKING_CHANGE_REQUEST_SHAPE = connectionShapeFor<
  BookingChangeRequest & { requestedChanges: { requested: { summary: string; requestedEffectiveDate: string | null } } }
>({
  id: true,
  bookingId: true,
  kind: true,
  status: true,
  reason: true,
  requestedChanges: { requested: { summary: true, requestedEffectiveDate: true } },
  adminNotes: true,
  memberMessage: true,
  reviewedAt: true,
  cancelledAt: true,
  holdExpiresAt: true,
  createdAt: true,
  updatedAt: true,
});

export const BOOKING_CHANGE_REQUEST_CONNECTION_SHAPE: ConnectionShape = BOOKING_CHANGE_REQUEST_SHAPE;

export const BOOKING_CHANGE_REQUEST_LIST_CONNECTION_SHAPE: ConnectionShape = {
  changeRequests: BOOKING_CHANGE_REQUEST_SHAPE,
};

/** Every field of either estimate answer: a field the estimate gains must be decided here. */
export const CHANGE_REQUEST_ESTIMATE_CONNECTION_SHAPE: ConnectionShape = {
  estimate: completeConnectionShapeFor<EveryFieldOf<ChangeRequestEstimate>>({
    outcome: true,
    guests: { priceCents: true, nights: true },
    totalCents: true,
    excludesMemberGuests: true,
    message: true,
  }),
};

/** The proposal as the officer will see it, frozen: the dates, the party and each guest's nights. */
const MEMBER_EXCEPTION_PROPOSAL_SHAPE = {
  lodgeId: true,
  checkIn: true,
  checkOut: true,
  guests: { firstName: true, lastName: true, ageTier: true, isMember: true, nights: true },
  guestNights: true,
  baseCheckIn: true,
  baseCheckOut: true,
  baseGuestNights: true,
} as const satisfies CompleteConnectionShapeFor<MemberExceptionProposal>;

/** A new exception request: its id, the rules it asks to set aside and the frozen proposal. Not its hash. */
export const CREATED_EXCEPTION_REQUEST_CONNECTION_SHAPE = connectionShapeFor<CreatedExceptionRequest>({
  id: true,
  status: true,
  reasonCodes: true,
  aggregateCapacityMode: true,
  capacityHeld: true,
  proposal: MEMBER_EXCEPTION_PROPOSAL_SHAPE,
});

/**
 * The member's own exception requests, as their request area shows them. The
 * member DTO is already the privacy boundary (#2562, no officer note), so the
 * shape is complete: a field the DTO gains must be decided here.
 */
export const MEMBER_EXCEPTION_REQUEST_LIST_CONNECTION_SHAPE: ConnectionShape = {
  exceptionRequests: completeConnectionShapeFor<MemberExceptionRequestItem>({
    id: true,
    source: true,
    status: true,
    createdAt: true,
    reviewedAt: true,
    proposal: MEMBER_EXCEPTION_PROPOSAL_SHAPE,
    rules: { reasonCode: true, message: true, affectedNights: true },
    memberMessage: true,
    decisionExplanation: true,
    capacityHeld: true,
    capacityMode: true,
    lastConflictReason: true,
    lastConflictAt: true,
    bookingId: true,
    createdBookingId: true,
    createdBookingHoldsCapacity: true,
    createdBookingAwaitsPayment: true,
    supersededByRequestId: true,
    canWithdraw: true,
    canReplace: true,
  }),
};

export const WITHDRAWN_EXCEPTION_REQUEST_CONNECTION_SHAPE = completeConnectionShapeFor<{ id: string; status: string }>({
  id: true,
  status: true,
});

/** A refund appeal and its outcome. Not the member or officer ids on the row. */
const REFUND_APPEAL_SHAPE = connectionShapeFor<RefundRequest>({
  id: true,
  bookingId: true,
  status: true,
  reason: true,
  requestedAmountCents: true,
  approvedAmountCents: true,
  adminNotes: true,
  reviewedAt: true,
  createdAt: true,
});

export const REFUND_APPEAL_CONNECTION_SHAPE: ConnectionShape = REFUND_APPEAL_SHAPE;

export const REFUND_APPEAL_LIST_CONNECTION_SHAPE: ConnectionShape = { refundReviews: REFUND_APPEAL_SHAPE };

/**
 * A stay's price, each guest's share and nights, the member's credit, and
 * whether the booking would wait for a non-member hold or a paid-up adult.
 * Not the rate membership type ids or the guests' member ids.
 */
export const BOOKING_QUOTE_CONNECTION_SHAPE = connectionShapeFor<
  PriceBreakdown & {
    availableCreditCents: number;
    deferredGuestPortionCents: number | null;
    groupDiscountApplied: boolean;
    subscriptionMemberRateNotice: string | null;
    paidUpAdultMemberMissing: boolean;
    nonMemberHoldDecision: {
      enabled: boolean;
      holdDays: number;
      daysUntilCheckIn: number;
      shouldBePending: boolean;
      status: string;
    };
  }
>({
  guests: { ageTier: true, isMember: true, nights: true, priceCents: true, perNightCents: true, nightDates: true },
  totalPriceCents: true,
  availableCreditCents: true,
  deferredGuestPortionCents: true,
  groupDiscountApplied: true,
  subscriptionMemberRateNotice: true,
  paidUpAdultMemberMissing: true,
  nonMemberHoldDecision: {
    enabled: true,
    holdDays: true,
    daysUntilCheckIn: true,
    shouldBePending: true,
    status: true,
  },
});

/** One code's outcome, alone or as one of several. */
const PROMO_CODE_OUTCOME_FIELDS = {
  code: true,
  valid: true,
  error: true,
  description: true,
  type: true,
  discountCents: true,
  promoAdjustmentCents: true,
  freeNightsUsed: true,
  eligibleGuestCount: true,
  remainingFreeNights: true,
  selectedGuestIndexes: true,
  requiresGuestSelection: true,
  selectableGuestIndexes: true,
} as const;

/**
 * Every field of the three answers (`check_promo_code` answers with one):
 * one code, several codes, or a code that needs the guests chosen. Not the
 * promo code's internal row, assignments or lodges.
 */
export const PROMO_CHECK_CONNECTION_SHAPE: ConnectionShape = {
  ...PROMO_CODE_OUTCOME_FIELDS,
  workPartyEvent: { id: true, name: true, discountPercent: true },
  codes: PROMO_CODE_OUTCOME_FIELDS,
  totalPriceCents: true,
  finalPriceCents: true,
};

/**
 * What an edit to a booking would cost or give back, and whether it can be
 * saved: the figures, every reason the save would refuse it (a full night, a
 * refused promo code, an organiser-billing refusal), and the line items. Not
 * the settlement options, which the website's save step works through with the
 * member.
 */
export const BOOKING_CHANGE_QUOTE_CONNECTION_SHAPE: ConnectionShape = {
  newTotalPriceCents: true,
  newDiscountCents: true,
  newPromoAdjustmentCents: true,
  newFinalPriceCents: true,
  priceDiffCents: true,
  changeFeeCents: true,
  netChargeCents: true,
  unpaidAskOffsetCents: true,
  askLeftCents: true,
  appliedCreditGiveBackCents: true,
  availableCreditCents: true,
  capacityAvailable: true,
  capacityFullNights: true,
  minimumStayValid: true,
  minimumStayViolations: { reasonCode: true, message: true, affectedNights: true },
  chargeRefusal: true,
  priceChangeRefusal: true,
  promoStillValid: true,
  promoValidation: { valid: true, error: true, code: true, discountCents: true, promoAdjustmentCents: true },
  promoCoverage: { promoCode: true, excludedNames: true, message: true },
  subscriptionMemberRateNotice: true,
  groupDiscountEditNotice: true,
  itemizedChanges: { label: true, amountCents: true },
};

/** Every field of the three accept answers, with the `id` of the booking to pay for. */
export const WAITLIST_OFFER_ACCEPTED_CONNECTION_SHAPE = completeConnectionShapeFor<{
  id: string;
  success: boolean;
  status: string;
  newBookingId: string;
  requiresPayment: boolean;
  requiresSetup: boolean;
  subscriptionMemberRateNotice: string | null;
}>({
  id: true,
  success: true,
  status: true,
  newBookingId: true,
  requiresPayment: true,
  requiresSetup: true,
  subscriptionMemberRateNotice: true,
});

export const DRAFT_DELETED_CONNECTION_SHAPE = completeConnectionShapeFor<
  Extract<DeleteBookingResult, { status: 200 }>["data"]
>({
  success: true,
  mode: true,
  bookingId: true,
  message: true,
});
