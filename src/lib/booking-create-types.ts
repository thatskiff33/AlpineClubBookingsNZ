/**
 * Shared types and structured errors for the booking-creation service.
 *
 * These declarations were extracted verbatim from `booking-create.ts` so the
 * orchestrators and the promo/guest helper modules can share them without a
 * circular dependency. `@/lib/booking-create` re-exports the public members so
 * existing importers keep working unchanged.
 */
import { AgeTier, BookingStatus, type Booking, type BookingGuest } from "@prisma/client";
import type { GroupDiscountConfig } from "@/lib/pricing";
import type { BookingPaymentMethod } from "@/lib/booking-payment-methods";
import type { InternetBankingPaymentSettingsValues } from "@/lib/internet-banking-settings";
import type { GuestNightInput } from "@/lib/booking-guest-stay-ranges";

export type BookingWithGuests = Booking & { guests: BookingGuest[] };

/**
 * Maximum rolling lookback (in NZ date-only days) for an admin retroactive
 * booking (#1695): the check-in may be at most this many days before today.
 * Enforced at the route AND re-checked in the service (defence in depth).
 */
export const RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS = 365;

export interface BookingGuestInput {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string;
  stayStart?: Date | null;
  stayEnd?: Date | null;
  // Explicit included nights (issue #713). When present, the guest stays
  // exactly these nights (which may be non-contiguous) and stayStart/stayEnd
  // are the derived min/max envelope.
  nights?: ReadonlyArray<GuestNightInput> | null;
}

interface BaseInput {
  effectiveMemberId: string;
  isOnBehalf: boolean;
  sessionUserId: string;
  checkIn: Date;
  checkOut: Date;
  guests: BookingGuestInput[];
  notes?: string;
  promoCodeStr?: string;
  promoGuestIndexes?: number[];
  // Work party (working bee) event the booker is attending. Mutually
  // exclusive with promoCodeStr; resolves to the event's internal promo.
  workPartyEventId?: string;
  expectedArrivalTime?: string;
  requestedRoomId?: string;
  // "Only book if my guests can come": cancel the whole booking instead of the
  // default partial bump when non-member guests lose capacity.
  cancelIfGuestsBumped?: boolean;
  groupDiscount?: GroupDiscountConfig;
  memberReviewJustification?: string;
  // Group booking (shareable join code): when set, the created (primary)
  // booking is linked to the organiser's booking via parentBookingId, so a
  // joiner's stay is grouped with the event. Existing callers leave this
  // undefined, which persists null exactly as before.
  parentBookingId?: string;
  // Group booking, ORGANISER_PAYS mode: when true the created booking is
  // flagged organiserSettled, so the joiner is never billed for it and cannot
  // pay it themselves; the organiser settles the group total. Only the
  // group-join path sets this; everyone else leaves it undefined (false).
  organiserSettled?: boolean;
  // Lodge the booking is for (multi-lodge phase 8). Must name an active
  // lodge when set; omitted resolves to the club's default lodge, so
  // single-lodge callers keep working unchanged.
  lodgeId?: string;
}

export type DraftBookingInput = BaseInput;

export interface ConfirmedBookingInput extends BaseInput {
  applyCreditCents?: number;
  status: BookingStatus;
  shouldBePending: boolean;
  holdDays: number;
  paymentMethod?: BookingPaymentMethod;
  internetBankingSettings?: InternetBankingPaymentSettingsValues;
  // Retroactive booking (#1695). Honoured only for on-behalf creates: the
  // check-in may fall in the past (up to RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS),
  // over-capacity nights become warn-and-confirm, and the member email is a
  // per-create choice. Absent/false keeps the member flow byte-identical.
  allowPastDates?: boolean;
  confirmOverCapacity?: boolean;
  notifyMember?: boolean;
  /**
   * Internal inherited-stay marker (#1695 H1 fix): set ONLY by callers that
   * join an existing, already-validated stay envelope — group join (whole-stay
   * unit, #1387) and cross-lodge waitlist confirm — which legitimately reach a
   * past check-in once the parent stay is in progress. Skips the service's
   * past-date rejection without any retroactive semantics (no capacity
   * warn-and-confirm, no email choice). Never exposed via the API.
   */
  allowPastCheckIn?: boolean;
  /**
   * When set, the group roster row is written in the same transaction as the
   * child booking (#1039 item 2): a concurrent duplicate join aborts here and
   * rolls the booking back instead of leaving an orphaned booking or a
   * duplicate roster row. A row left by a cancelled/bumped join is reused.
   */
  groupJoin?: { groupBookingId: string; joinerMemberId: string };
  /**
   * Cross-lodge waitlist confirm, in-transaction duplicate-stay guard (#1587
   * item 2). When set, the same duplicate-stay query the confirm ran in its
   * pre-flight phase is re-run under the offered lodge's held capacity lock,
   * just before the booking row is created; a match throws
   * DuplicateStayConflictError so the transaction rolls back instead of
   * committing a second booking for the same stay. The member, lodge, and
   * date range are taken from this input's resolved values — only the entry to
   * exclude is carried here, so the guard can never disagree with the booking
   * being created. Only the cross-lodge confirm path sets this; every other
   * caller leaves it undefined and the guard is skipped.
   *
   * The member-night conflict check excludes the same entry (#1628/#1609):
   * the replaced WAITLIST_OFFERED booking may list the confirming member as a
   * guest and must not count against the booking replacing it.
   */
  duplicateStayGuard?: { excludeBookingId: string };
}

/**
 * Thrown inside the booking transaction when the joiner already has a live
 * join in this group; the group route maps it to a 409 and the transaction
 * rollback discards the duplicate child booking.
 */
export class GroupJoinConflictError extends Error {
  constructor() {
    super("You have already joined this group");
    this.name = "GroupJoinConflictError";
  }
}

/**
 * Thrown inside the booking transaction when the in-transaction duplicate-stay
 * guard (#1587 item 2) finds the member already holds an overlapping stay at
 * the offered lodge. The cross-lodge confirm maps it to the same DUPLICATE_STAY
 * rejection its pre-flight guard uses; the transaction rollback discards the
 * would-be duplicate booking.
 */
export class DuplicateStayConflictError extends Error {
  constructor() {
    super("You already have a booking at this lodge for these dates");
    this.name = "DuplicateStayConflictError";
  }
}

export type ConfirmedBookingOutcome =
  | { type: "created"; booking: BookingWithGuests; bumpedBookingIds: string[]; isZeroDollarConfirmed: boolean }
  | { type: "capacityExceeded"; fullNights: string[] };

export type WaitlistedBookingInput = BaseInput & {
  // Cross-lodge waitlist opt-in (ADR-004): other lodges the member would
  // also accept a bed at. Each must name an active lodge the member is
  // eligible to book; the primary lodge and duplicates are dropped.
  alternateLodgeIds?: string[];
  // Per-create email choice (#1695): an on-behalf create that falls back to
  // the waitlist honours the admin's choice for the waitlist confirmation
  // email too. Absent = notify; member self-flow always notifies.
  notifyMember?: boolean;
};

export interface WaitlistedBookingResult {
  booking: BookingWithGuests;
  position: number;
}

/**
 * Thrown when promo code validation fails inside the booking transaction.
 * The route handler turns this into a 400 response.
 */
export class BookingPromoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingPromoError";
  }
}

/**
 * Thrown when the no-adult rule trips for a member-created booking but the
 * caller did not supply `memberReviewJustification`. Members must explain
 * why they are booking minors without an adult before the booking can be
 * persisted for admin review.
 */
export class BookingReviewJustificationRequiredError extends Error {
  constructor() {
    super(
      "A reason is required when booking minors without an adult guest. Please explain so an admin can review."
    );
    this.name = "BookingReviewJustificationRequiredError";
  }
}

/**
 * Thrown when the requested lodge is unknown/inactive or the requested room
 * belongs to a different lodge. The route handler turns this into a 400.
 */
export class BookingLodgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingLodgeError";
  }
}

/**
 * Thrown when an admin retroactive create (#1695) would settle a past stay's
 * outstanding balance on the card PAYMENT_PENDING path (#1709). A finished stay
 * has no future arrival to gate a card hold on, so a card obligation for it has
 * nothing to release it and could linger forever. Option A (issue #1709): a
 * retroactive create must settle via internet banking, account credit, or a
 * $0/comp booking — a fully-covered ($0 effective) booking is allowed because
 * it settles immediately to PAID and never opens a card obligation. The route
 * maps this to a 400 with code `RETROACTIVE_CARD_NOT_ALLOWED`.
 */
export class RetroactiveCardPaymentError extends Error {
  constructor() {
    super(
      "A retroactive booking with an outstanding balance can't be paid by card. Use internet banking, apply account credit, or record it as a $0/comp booking.",
    );
    this.name = "RetroactiveCardPaymentError";
  }
}
