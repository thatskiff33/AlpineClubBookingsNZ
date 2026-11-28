/**
 * One narrative resolver shared by the public payment-link page
 * (`/pay/[token]`) and the admin/member booking-history view so guests and
 * admins read identical wording (issue #740).
 *
 * Given a booking and its durable BookingEvents (plus, on the payment-link
 * page, the link's own expiry/used/revoked state), it returns a state and a
 * rich, plain-language sentence with real amounts and club-time dates, and a
 * concrete self-service next step — never a generic "contact the booking
 * officer" fallback.
 *
 * This module is pure: it reads only the facts handed to it (no database, no
 * `now()` it cannot override, and no timezone it reads for itself) so it is
 * trivially testable and produces the same wording wherever it runs. That
 * purity is load-bearing rather than stylistic: caller
 * `payment-link-context.ts` sat inside `payment-link.ts` until #2956 split it
 * out, and that is reachable from `src/instrumentation.node.ts` — so the
 * `server-only` that reading the persisted zone here would drag in would have
 * killed it at import. Which client reads the club's zone is an
 * `INV-CONFIG-002` decision, not a refactor, so this module stays pure.
 *
 * ## Two kinds of date, in the same sentence (#3123)
 *
 * Money is formatted with `formatCents`. Dates come in two kinds and the file
 * treats them differently on purpose:
 *
 * - A **lodge night** (`checkIn` / `checkOut`) is a stored `@db.Date` calendar
 *   day. 1 August 2026 is 1 August everywhere on earth, so it takes **no zone
 *   at all** — `storedNight` decodes the encoding and renders it zone-free, and
 *   `dateRange` therefore has no `club` argument. That absence is the point.
 * - An **event stamp** (`BookingEvent.occurredAt`) is a real moment with no
 *   calendar day of its own, so it is projected through the club's persisted
 *   zone via `club.instantDate`. It used to go through `formatNZDate`, which
 *   read the container's `APP_TIME_ZONE`: for a club behind Greenwich that told
 *   a member the wrong day about their own payment.
 *
 * The binding arrives as data on the input (`club`), supplied by the caller.
 */
import { BookingEventType } from "@prisma/client";
import { formatCents } from "@/lib/utils";
import {
  requireStoredCalendarDay,
  type BoundClubTime,
  formatStayDate,
} from "@/lib/club-time";
import type { BumpEventSnapshot } from "@/lib/booking-events";
import { isRefundOutsideBookingSettlement } from "@/lib/refund-event-outside-settlement";
import { isManualSettlementMarkerEvent } from "@/lib/manual-settlement-reversal-event";
import type { ClubFormat } from "@/lib/club-format";
import { nothingToPayNarrative } from "@/lib/booking-narrative-nothing-to-pay";
import type { BookingAmountOwed } from "@/lib/booking-payment-state";
import { buildCancelledPostPaymentNarrative, capacityRacePaidEvent, type FailedLaterCardRefund, type PaidAnotherWayClose } from "@/lib/booking-narrative-cancelled-post-payment";
import type { CardRefundState, CardShortfallTaskStatuses } from "@/lib/manual-refund-task-settlement-rules";

export type BookingNarrativeState =
  | "payable"
  | "expired_payable"
  | "paid"
  | "bumped"
  | "cancelled_pre_payment"
  | "cancelled_post_payment"
  | "declined"
  | "under_review"
  | "nothing_to_pay" // #3955: the booking owes nothing (at or below zero)
  | "unknown";

export interface BookingNarrative {
  state: BookingNarrativeState;
  /** Short title for the card/banner heading. */
  headline: string;
  /** The rich, plain-language sentence(s) describing what happened. */
  message: string;
  /** A concrete self-service next step. */
  nextStep: string;
}

export interface NarrativeEvent {
  type: BookingEventType;
  occurredAt: Date;
  amountCents: number | null;
  reason: string | null;
  snapshot: unknown;
}

export interface NarrativeBooking {
  status: string;
  finalPriceCents: number;
  /** `INV-PAY-119` (#3955, #3991, #4058): `readBookingAmountOwed`'s reading — `owedCents` decides whether anything is owed, `dueCents` is quoted. Required: no bare-price fallback. */
  amountOwed: BookingAmountOwed;
  checkIn: Date;
  checkOut: Date;
  firstName: string;
  adminReviewStatus: string | null;
  adminReviewNotes: string | null;
  adminReviewReason: string | null;
}

interface NarrativeLinkState {
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

export interface ResolveBookingNarrativeInput {
  booking: NarrativeBooking;
  events: NarrativeEvent[];
  /**
   * The club's persisted timezone, bound. Supplied by the caller because this
   * module is pure — see the file header. Every real instant this resolver
   * renders (payment, cancellation, settlement, release stamps) is read in it;
   * the lodge nights are calendar days and are not.
   */
  club: BoundClubTime;
  /** The payment link's own state, when resolving for `/pay/[token]`. */
  link?: NarrativeLinkState | null;
  now?: Date;
  /**
   * #3991: the viewer cannot see the booking OWNER's account credit (the
   * booking page's `canSeeOwnerCredit` is false — a linked guest). The
   * narrative then names no credit: a credit-covered booking says only that
   * nothing is left to pay, and a cancellation settled as credit drops the
   * "added to your account credit" figure. Amounts the viewer already sees
   * stay. Defaults to false: the payment-link page's reader is the payer.
   */
  ownerCreditHidden?: boolean;
  /** #4097 (`INV-PAY-129`): a card cancel's shortfall tasks, by part, read by the caller. Absent reads as still owed. */
  cardShortfallStatuses?: CardShortfallTaskStatuses;
  /** #4047: positive, pending or incomplete extra collection evidence on this surface. */
  additionalCollectionPending?: boolean;
  /** #4125: where a card cancel's refund stands on its recovery row, read by the caller. Absent reads as on its way. */
  cardRefundState?: CardRefundState;
  /** #4145: closed "Paid another way", what its record says was paid back, left unpaid, and owed. */
  cardRefundClose?: PaidAnotherWayClose;
  /** #4145: a capacity race's rows' plans together - its card refund's most, where the snapshot froze the full charge. */
  cardRefundPlanCents?: number;
  /** #4166: the cancel's card refunds an event recorded that Stripe failed later, each by its own row. */
  cardRefundFailedLater?: readonly FailedLaterCardRefund[];
}

const PAID_EVENT_TYPES: BookingEventType[] = [
  BookingEventType.MEMBER_PAID,
  BookingEventType.NON_MEMBER_CONFIRMED,
];

const PAYABLE_STATUSES = new Set([
  "PENDING",
  "PAYMENT_PENDING",
  "CONFIRMED",
]);

function sortedByOccurredAt(events: NarrativeEvent[]): NarrativeEvent[] {
  return [...events].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()
  );
}

/**
 * One lodge night, rendered from its stored `@db.Date` encoding — **zone-free**.
 *
 * `requireStoredCalendarDay` is what makes a mis-wired real timestamp throw here
 * instead of rendering a plausible wrong night: for a club east of Greenwich a
 * `createdAt` flooded through this path would be silently right for most of the
 * day and silently wrong for the rest, which is the hardest kind of wrong to
 * notice. Same composition as `emailCalendarDay`, deliberately.
 */
function storedNight(value: Date, format: ClubFormat): string {
  return formatStayDate(
    requireStoredCalendarDay(value, {
      subject: "A booking narrative's lodge night",
      instead:
        "A real timestamp rendered as a bare day is a projection: use club.instantDate, " +
        "which reads it in the club's persisted zone.",
    }),
    format,
  );
}

/** The stay window. No `club` binding (a calendar day has no zone), but a format (#3566). */
function dateRange(booking: NarrativeBooking, format: ClubFormat): string {
  return `${storedNight(booking.checkIn, format)} to ${storedNight(booking.checkOut, format)}`;
}

function asBumpSnapshot(value: unknown): BumpEventSnapshot | null {
  if (value && typeof value === "object") {
    return value as BumpEventSnapshot;
  }
  return null;
}

function buildPaidNarrative(
  booking: NarrativeBooking,
  events: NarrativeEvent[],
  club: BoundClubTime, format: ClubFormat,
  additionalCollectionPending = false,
): BookingNarrative {
  const paidEvent =
    events.find(
      (e) => PAID_EVENT_TYPES.includes(e.type) && (e.amountCents ?? 0) > 0
    ) ?? events.find((e) => PAID_EVENT_TYPES.includes(e.type));
  const amountCents = paidEvent?.amountCents ?? 0;
  const range = dateRange(booking, format);

  if (amountCents > 0 && paidEvent) {
    return {
      state: "paid",
      headline: "Payment received",
      message: `Thanks ${booking.firstName} — we've received your payment of ${formatCents(amountCents, format)} on ${club.instantDate(paidEvent.occurredAt)}. Your stay from ${range} is confirmed.`,
      nextStep: additionalCollectionPending ? "See the additional-payment information below." :
        "Nothing more to do — we'll see you at the lodge. You can view the full booking details any time from your bookings page.",
    };
  }

  return {
    state: "paid",
    headline: "Booking confirmed",
    message: `Thanks ${booking.firstName} — your stay from ${range} is confirmed.${additionalCollectionPending ? "" : " No payment was required."}`,
    nextStep: additionalCollectionPending ? "See the additional-payment information below." :
      "Nothing more to do — we'll see you at the lodge. You can view the full booking details any time from your bookings page.",
  };
}

function buildCancelledNarrative(
  booking: NarrativeBooking,
  events: NarrativeEvent[],
  club: BoundClubTime, format: ClubFormat, ownerCreditHidden: boolean,
  cardShortfallStatuses: CardShortfallTaskStatuses = {},
  cardRefundState?: CardRefundState,
  cardRefundClose?: PaidAnotherWayClose,
  cardRefundPlanCents?: number,
  cardRefundFailedLater?: readonly FailedLaterCardRefund[],
): BookingNarrative {
  // A booking held for admin review that was rejected is cancelled via the
  // shared cancel flow; surface it as "declined" with the admin's reason.
  if (booking.adminReviewStatus === "REJECTED") {
    const reason = (booking.adminReviewNotes ?? booking.adminReviewReason)?.trim();
    return {
      state: "declined",
      headline: "Booking request declined",
      message: reason
        ? `This booking request was declined: ${reason}`
        : "This booking request was declined.",
      nextStep:
        "You can adjust the booking — for example, include an adult guest in a youth-only party — and submit it again from the bookings page.",
    };
  }

  // #2262 — the admin-only settlement markers (a mark-paid REVERSAL, the
  // reciprocal fence firing on an inbound Xero PAID, and #3638's
  // second-instrument conflict) are stored as CANCELLED
  // events, because there is no neutral event type for "the settlement was
  // un-recorded" / "these two records disagree". NONE cancels the booking.
  // Excluding them here means a booking that hits one and is LATER genuinely
  // cancelled shows the member the REAL cancellation's date, not the marker's.
  const cancelEvent = events.find(
    (e) =>
      e.type === BookingEventType.CANCELLED && !isManualSettlementMarkerEvent(e)
  );

  // A provisional booking whose dates filled up before its guests were
  // confirmed is released (status BUMPED, or CANCELLED carrying a BUMPED event)
  // rather than member-cancelled — no fault, no payment.
  const bumpEvent = events.find((e) => e.type === BookingEventType.BUMPED);
  if (booking.status === "BUMPED" || bumpEvent) {
    const bump = asBumpSnapshot(bumpEvent?.snapshot);
    const releasedAt = bumpEvent?.occurredAt ?? cancelEvent?.occurredAt;
    const releasedClause = releasedAt
      ? ` on ${club.instantDate(releasedAt)}`
      : "";
    const message = bump?.flagged
      ? `These dates filled up before your guests could be confirmed. Because you asked us to only hold the booking if your whole party could come, it was released${releasedClause}. No payment was taken.`
      : `These dates filled up before your guests were confirmed, so this booking was released${releasedClause}. No payment was taken.`;
    return {
      state: "bumped",
      headline: "These dates filled up",
      message,
      nextStep:
        "You're welcome to try again — check current availability and book these dates again.",
    };
  }

  const paidEvent = events.find(
    (e) => PAID_EVENT_TYPES.includes(e.type) && (e.amountCents ?? 0) > 0
  ) ?? capacityRacePaidEvent(cancelEvent); // #4125: that settle records no MEMBER_PAID.

  if (paidEvent) {
    // #2008 / #3340 / #3827: a refund that settles something OTHER than the
    // booking (a duplicate capture, a superseded intent, an edit's refund sent
    // back by hand while the booking was live) must NEVER be picked up as this
    // cancellation's settlement clause, which would falsely claim the member
    // was refunded. `isRefundOutsideBookingSettlement` is the one list.
    const settlementEvents = events.filter(
      (e) =>
        (e.type === BookingEventType.REFUNDED ||
          e.type === BookingEventType.CREDITED) &&
        !isRefundOutsideBookingSettlement(e)
    );
    return buildCancelledPostPaymentNarrative(
      paidEvent,
      cancelEvent, settlementEvents, club, format, ownerCreditHidden, cardShortfallStatuses, cardRefundState, cardRefundClose, cardRefundPlanCents, cardRefundFailedLater,
    );
  }

  const cancelOn = cancelEvent
    ? club.instantDate(cancelEvent.occurredAt)
    : null;
  return {
    state: "cancelled_pre_payment",
    headline: "Booking cancelled",
    message: cancelOn
      ? `This booking for ${dateRange(booking, format)} was cancelled on ${cancelOn}. No payment had been taken, so there is nothing to refund.`
      : `This booking for ${dateRange(booking, format)} was cancelled. No payment had been taken, so there is nothing to refund.`,
    nextStep:
      "If you'd like to stay another time, you can book again from the bookings page whenever you're ready.",
  };
}

function buildPayableNarrative(
  booking: NarrativeBooking,
  link: NarrativeLinkState | null | undefined,
  now: Date, format: ClubFormat, ownerCreditHidden: boolean, additionalCollectionPending = false,
): BookingNarrative {
  const range = dateRange(booking, format);
  if (booking.amountOwed.owedCents <= 0) {
    if (additionalCollectionPending) return {
      state: "nothing_to_pay", headline: "Primary booking amount covered",
      message: `The primary amount for your booking from ${range} has nothing left to pay. See the separate additional-payment information below.`,
      nextStep: "See the additional-payment information below.",
    };
    return nothingToPayNarrative(range, !ownerCreditHidden && booking.amountOwed.appliedCreditCents > 0);
  }
  const amountDue = formatCents(booking.amountOwed.dueCents, format);

  const linkUnusable =
    link != null &&
    (link.revokedAt != null ||
      link.usedAt != null ||
      link.expiresAt.getTime() < now.getTime());

  if (linkUnusable) {
    return {
      state: "expired_payable",
      headline: "Payment link expired",
      message: `This payment link has expired, but your booking for ${range} can still be paid — ${amountDue} is due.`,
      nextStep:
        "Request a fresh payment link below and we'll email you a new one straight away.",
    };
  }

  return {
    state: "payable",
    headline: "Complete your payment",
    message: `Your booking for ${range} is ready to pay — ${amountDue} is due.`,
    nextStep:
      "Pay by card or internet banking below to confirm your booking.",
  };
}

/**
 * Resolve the human narrative for a booking from its durable events. Shared by
 * the public payment-link page and the admin/member booking-history view.
 */
export function resolveBookingNarrative({
  booking,
  events,
  club,
  link,
  now = new Date(),
  ownerCreditHidden = false,
  cardShortfallStatuses = {},
  additionalCollectionPending = false,
  cardRefundState,
  cardRefundClose,
  cardRefundPlanCents,
  cardRefundFailedLater,
}: ResolveBookingNarrativeInput, format: ClubFormat): BookingNarrative {
  const ordered = sortedByOccurredAt(events);
  const status = booking.status;

  if (status === "CANCELLED" || status === "BUMPED") {
    return buildCancelledNarrative(booking, ordered, club, format, ownerCreditHidden, cardShortfallStatuses, cardRefundState, cardRefundClose, cardRefundPlanCents, cardRefundFailedLater);
  }

  if (status === "AWAITING_REVIEW") {
    if (booking.adminReviewStatus === "REJECTED") {
      return buildCancelledNarrative(booking, ordered, club, format, ownerCreditHidden, cardShortfallStatuses, cardRefundState, cardRefundClose, cardRefundPlanCents, cardRefundFailedLater);
    }
    return {
      state: "under_review",
      headline: "Awaiting review",
      message: `Your booking for ${dateRange(booking, format)} is waiting for an admin to review it before any payment is taken.`,
      nextStep:
        "No action is needed right now — we'll email you as soon as it's approved.",
    };
  }

  if (status === "PAID" || status === "COMPLETED") {
    return buildPaidNarrative(booking, ordered, club, format, additionalCollectionPending);
  }

  if (PAYABLE_STATUSES.has(status)) {
    return buildPayableNarrative(booking, link, now, format, ownerCreditHidden, additionalCollectionPending);
  }

  // DRAFT / WAITLISTED / WAITLIST_OFFERED and any unexpected state: a clear,
  // specific fallback rather than a generic error.
  return {
    state: "unknown",
    headline: "Booking link",
    message: `We couldn't find a payment due for your booking for ${dateRange(booking, format)} right now.`,
    nextStep:
      "Check the booking on your bookings page, or contact the club if something looks wrong.",
  };
}
