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
import type { CalendarDate } from "@/lib/club-time";
import type { GuestNightInput } from "@/lib/booking-guest-stay-ranges";
import type { MemberGuestConsentGuestFields } from "@/lib/member-guest-add-policy";
import type { PrismaTransactionClient } from "@/lib/db-transaction";
import type { SubscriptionLockoutMode } from "@/lib/membership-lockout-settings";

export type BookingWithGuests = Booking & { guests: BookingGuest[] };

/**
 * Maximum rolling lookback (in NZ date-only days) for an admin retroactive
 * booking (#1695): the check-in may be at most this many days before today.
 * Enforced at the route AND re-checked in the service (defence in depth).
 */
export const RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS = 365;

export interface BookingGuestInput extends MemberGuestConsentGuestFields {
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
  // The two member-guest fields come from MemberGuestConsentGuestFields
  // ("+ Add Member Guest", epic #2305, MG2 #2307): `memberGuestConsent` is the
  // five consent columns this row must be created with, and
  // `crossFamilyMemberGuest` is D-8's marker. Both are absent on every path that
  // does not add a member from beyond the booker's family, so a guest built by
  // any other flow is byte-identical to what it was before MG2. The import is
  // type-only: nothing at runtime is pulled into this types module.
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
  /**
   * The club's subscription-lockout mode, as this REQUEST already resolved it
   * (#2543).
   *
   * Declared on the shared base for the same reason `appliedCreditCents` is: all
   * three create services price, so all three need it, and a field that exists on
   * only one of them is a field one call site silently stops passing. The route
   * resolves the mode once to decide whether to run its HARD_BLOCK refusal and
   * the paid-up-adult requirement; handing the same value to pricing is what
   * stops an admin's mid-request save from letting the gate branch on one regime
   * and the price be computed under the other, and it removes a settings read
   * from inside the transaction that holds the per-lodge capacity lock. Omitted,
   * the pricing gate falls back to reading it, which is correct but neither of
   * those things.
   */
  subscriptionLockoutMode?: SubscriptionLockoutMode;
  memberReviewJustification?: string;
  /**
   * The explicit reason an ADMIN gave for booking a party the adult-member
   * hosting policy would otherwise send to review (#2364, epic decision D-R4).
   *
   * Absent on every member-created booking: the reconciler then opens the
   * hosting review as PENDING, which is the whole point — a member cannot
   * approve their own exception. Present only when an admin acting on somebody's
   * behalf has confirmed, in words, that they are accepting it, and it is
   * persisted with the admin's id so "who let this through, and why" is
   * answerable later. An admin who supplies nothing is REFUSED rather than
   * silently auto-approved, which is what D-R4 forbids.
   */
  adultMemberHostingReason?: string;
  /**
   * This create is EXECUTING A MEMBER'S ALREADY-REVIEWED proposal — an approved
   * booking-policy exception (#2526) — rather than an admin composing a booking.
   *
   * `isOnBehalf` is true either way (an officer really is acting for the member),
   * but only the SECOND case entitles the actor to decide rules on the member's
   * behalf. The officer reviewed the reason codes on the request's card; adult
   * supervision is not one of them, so with this set the supervision review opens
   * PENDING with the member's own words instead of being auto-approved in the
   * officer's name. Absent for every other caller, which keeps on-behalf creates
   * byte-identical.
   */
  reviewedMemberProposal?: boolean;
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
  // Lodge the booking is for (multi-lodge phase 8). Required at every service
  // boundary (INV-CAP-034); runtime validation also refuses unchecked JS/`any`
  // callers before the permissive read resolver can choose a default lodge.
  lodgeId: string;
  /**
   * Account credit, in integer cents, that the member asked to put towards this
   * booking.
   *
   * Deliberately declared on the SHARED base (#2265) rather than on the
   * confirmed input alone. It used to live only on `ConfirmedBookingInput`,
   * which let the route's two hand-built argument objects diverge: the draft
   * branch simply never passed the field, the type system had nothing to say
   * about it, and a member's credit election was silently discarded every time
   * they saved a draft. Both services now accept it, and
   * `issue-2265-booking-create-money-parity.test.ts` pins that both call sites keep
   * passing it.
   *
   * The two services consume it differently, and that difference is the whole
   * point of the design:
   *  - `createConfirmedBooking` APPLIES it — the credit is consumed into the
   *    MemberCredit ledger at create time, but only for a booking that is
   *    actually reaching PAYMENT_PENDING.
   *  - `createDraftBooking` only REMEMBERS it, on `Booking.creditElectionCents`.
   *    A draft may be abandoned or expire, so no balance is tied up; the
   *    election is applied (clamped to the live balance and price) when the
   *    booking reaches PAYMENT_PENDING at the pay step.
   */
  applyCreditCents?: number;
}

export type DraftBookingInput = BaseInput;

export interface ConfirmedBookingInput extends BaseInput {
  /**
   * The CLUB's calendar day (`INV-CONFIG-002`), resolved by the caller before
   * it opened ANY transaction. REQUIRED, with no default.
   *
   * WHY THE CALLER RESOLVES IT (`INV-LOCK-004`, #3123 review).
   * `createConfirmedBooking` is transaction-AWARE: it runs inside `input.tx`
   * when one is supplied — the atomic approve-and-execute path, which by then
   * already holds `pg_advisory_xact_lock(1)` and the per-lodge capacity key —
   * and opens its own `prisma.$transaction` otherwise. So NO position inside
   * that function is outside a transaction on every path, and a
   * `clubTimeSettings` read there would take a second pooled connection under
   * the caller's locks. The day arrives as a value instead.
   *
   * ONE day serves every decision in the create: the retroactive / past-date
   * envelope, the promotion's validity window inside `resolvePromoInTransaction`
   * (which additionally holds `FOR UPDATE` on the promo row by the time it needs
   * the day), and the person-night guard's self-removal window. The route runs
   * the same past-date rules before calling, so passing ITS day makes the two
   * halves structurally incapable of disagreeing across club midnight — a
   * property that used to rest on both sides happening to call the same helper.
   */
  todayAtClub: CalendarDate;
  status: BookingStatus;
  shouldBePending: boolean;
  holdDays: number;
  paymentMethod?: BookingPaymentMethod;
  internetBankingSettings?: InternetBankingPaymentSettingsValues;
  // Retroactive booking (#1695). Honoured only for on-behalf creates: the
  // check-in may fall in the past (up to RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS)
  // and the member email is a per-create choice. Absent/false keeps the member
  // flow byte-identical. Over-capacity warn-and-confirm covers every on-behalf
  // create, past or future (#1767).
  allowPastDates?: boolean;
  confirmOverCapacity?: boolean;
  notifyMember?: boolean;
  /**
   * Set ONLY by the POST /api/bookings route when the caller opted into the
   * waitlist fallback (#1767). Suppresses the on-behalf over-capacity
   * warn-and-confirm so the capacityExceeded outcome still reaches the
   * route's waitlist fall-through instead of aborting with a 409 confirm
   * prompt. Never exposed as an API field.
   */
  waitlistIntent?: boolean;
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
  /**
   * Caller-supplied transaction (#2525). When present, the service runs its
   * DB work inside this transaction instead of opening its own, so an atomic
   * approve-and-execute can release a policy-exception reservation, claim the
   * request status, and create the booking in ONE transaction — no
   * mark-approved-then-call-service gap. Post-commit provider work (email, Xero)
   * is NOT fired inline in this mode; the service returns a `deferredPostCommit`
   * thunk on the "created" outcome for the caller to run after ITS commit.
   * Absent for every existing caller, which keeps the self-contained-transaction
   * behaviour byte-identical.
   */
  tx?: PrismaTransactionClient;
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
  | {
      type: "created";
      booking: BookingWithGuests;
      bumpedBookingIds: string[];
      isZeroDollarConfirmed: boolean;
      /**
       * Present ONLY in tx-mode (#2525): the post-commit provider work (member
       * emails, Xero invoice/credit queueing, booking events, admin alert) the
       * service deferred because the caller owns the commit. The caller MUST run
       * it after committing. Absent in standalone mode, where the service already
       * ran those effects itself before returning.
       */
      deferredPostCommit?: () => Promise<void>;
    }
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
