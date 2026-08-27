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
 * purity is load-bearing rather than stylistic: `payment-link.ts` is one of the
 * two callers and is reachable from `src/instrumentation.node.ts`, so
 * `server-only` — which is what reading the persisted zone here would drag in —
 * would kill it at import.
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
  calendarDateOfDateOnlyInstant,
  formatClubDate,
  requireStoredCalendarDay,
  type BoundClubTime,
} from "@/lib/club-time";
import type {
  CancellationEventSnapshot,
  BumpEventSnapshot,
} from "@/lib/booking-events";
import { isDuplicateCaptureRefundEvent } from "@/lib/duplicate-capture-refund-event";
import { isManualSettlementMarkerEvent } from "@/lib/manual-settlement-reversal-event";

export type BookingNarrativeState =
  | "payable"
  | "expired_payable"
  | "paid"
  | "bumped"
  | "cancelled_pre_payment"
  | "cancelled_post_payment"
  | "declined"
  | "under_review"
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
function storedNight(value: Date): string {
  return formatClubDate(
    calendarDateOfDateOnlyInstant(
      requireStoredCalendarDay(value, {
        subject: "A booking narrative's lodge night",
        instead:
          "A real timestamp rendered as a bare day is a projection: use club.instantDate, " +
          "which reads it in the club's persisted zone.",
      }),
    ),
  );
}

/** The stay window. Takes no `club` binding, because a calendar day has no zone. */
function dateRange(booking: NarrativeBooking): string {
  return `${storedNight(booking.checkIn)} to ${storedNight(booking.checkOut)}`;
}

function asCancellationSnapshot(
  value: unknown
): CancellationEventSnapshot | null {
  if (value && typeof value === "object") {
    return value as CancellationEventSnapshot;
  }
  return null;
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
  club: BoundClubTime
): BookingNarrative {
  const paidEvent =
    events.find(
      (e) => PAID_EVENT_TYPES.includes(e.type) && (e.amountCents ?? 0) > 0
    ) ?? events.find((e) => PAID_EVENT_TYPES.includes(e.type));
  const amountCents = paidEvent?.amountCents ?? 0;
  const range = dateRange(booking);

  if (amountCents > 0 && paidEvent) {
    return {
      state: "paid",
      headline: "Payment received",
      message: `Thanks ${booking.firstName} — we've received your payment of ${formatCents(amountCents)} on ${club.instantDate(paidEvent.occurredAt)}. Your stay from ${range} is confirmed.`,
      nextStep:
        "Nothing more to do — we'll see you at the lodge. You can view the full booking details any time from your bookings page.",
    };
  }

  return {
    state: "paid",
    headline: "Booking confirmed",
    message: `Thanks ${booking.firstName} — your stay from ${range} is confirmed. No payment was required.`,
    nextStep:
      "Nothing more to do — we'll see you at the lodge. You can view the full booking details any time from your bookings page.",
  };
}

function buildCancelledPostPaymentNarrative(
  booking: NarrativeBooking,
  paidEvent: NarrativeEvent,
  cancelEvent: NarrativeEvent | undefined,
  settlementEvent: NarrativeEvent | undefined,
  club: BoundClubTime
): BookingNarrative {
  const snapshot = asCancellationSnapshot(cancelEvent?.snapshot);
  const paidAmountCents = paidEvent.amountCents ?? snapshot?.paidAmountCents ?? 0;
  const settledAmountCents =
    settlementEvent?.amountCents ?? snapshot?.settledAmountCents ?? 0;
  const retainedAmountCents =
    snapshot?.retainedAmountCents ??
    Math.max(paidAmountCents - settledAmountCents, 0);

  const paidOn = club.instantDate(paidEvent.occurredAt);
  const cancelOn = cancelEvent
    ? club.instantDate(cancelEvent.occurredAt)
    : paidOn;
  const opening = `You cancelled this booking on ${cancelOn} after paying ${formatCents(paidAmountCents)} on ${paidOn}.`;

  let settlementClause: string;
  if (settledAmountCents > 0 && settlementEvent) {
    const settledOn = club.instantDate(settlementEvent.occurredAt);
    const verb =
      settlementEvent.type === BookingEventType.CREDITED
        ? "added to your account credit"
        : "refunded";
    settlementClause =
      retainedAmountCents > 0
        ? `${formatCents(settledAmountCents)} was ${verb} on ${settledOn} and ${formatCents(retainedAmountCents)} was retained`
        : `${formatCents(settledAmountCents)} was ${verb} on ${settledOn}`;
  } else if (snapshot?.refundMethod === "manual" && settledAmountCents > 0) {
    // B5 (#2262): a cash / off-Xero settlement is handed back by a person, so
    // there is no settlement event YET — one is written when the club marks the
    // hand-back complete. Saying "no refund was due" here would be a lie about
    // the member's money.
    settlementClause =
      retainedAmountCents > 0
        ? `${formatCents(settledAmountCents)} is being refunded to you by the club directly (you paid in cash or by bank transfer, so there is no card payment to reverse) and ${formatCents(retainedAmountCents)} was retained`
        : `${formatCents(settledAmountCents)} is being refunded to you by the club directly — you paid in cash or by bank transfer, so there is no card payment to reverse`;
  } else {
    settlementClause = `no refund was due and the full ${formatCents(retainedAmountCents)} was retained`;
  }

  return {
    state: "cancelled_post_payment",
    headline: "Booking cancelled",
    message: `${opening} Under the cancellation policy in effect at the time, ${settlementClause}. No further payment is required.`,
    nextStep:
      "If you'd like to stay another time, you can book again from the bookings page whenever you're ready.",
  };
}

function buildCancelledNarrative(
  booking: NarrativeBooking,
  events: NarrativeEvent[],
  club: BoundClubTime
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

  // #2262 — the two manual-settlement admin markers (a mark-paid REVERSAL, and
  // the reciprocal fence firing on an inbound Xero PAID) are stored as CANCELLED
  // events, because there is no neutral event type for "the settlement was
  // un-recorded" / "these two records disagree". NEITHER cancels the booking.
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
  );

  if (paidEvent) {
    // #2008 — the #1992 duplicate-capture auto-refund is recorded as a REFUNDED
    // event too, but it settles a SECOND capture on an already-PAID booking and
    // leaves the booking's own settlement untouched. It must NEVER be picked up
    // here as this cancellation's settlement clause (that would falsely claim
    // the member was refunded), so it is excluded from the settlement finder.
    const settlementEvent = events.find(
      (e) =>
        (e.type === BookingEventType.REFUNDED ||
          e.type === BookingEventType.CREDITED) &&
        !isDuplicateCaptureRefundEvent(e)
    );
    return buildCancelledPostPaymentNarrative(
      booking,
      paidEvent,
      cancelEvent,
      settlementEvent,
      club
    );
  }

  const cancelOn = cancelEvent
    ? club.instantDate(cancelEvent.occurredAt)
    : null;
  return {
    state: "cancelled_pre_payment",
    headline: "Booking cancelled",
    message: cancelOn
      ? `This booking for ${dateRange(booking)} was cancelled on ${cancelOn}. No payment had been taken, so there is nothing to refund.`
      : `This booking for ${dateRange(booking)} was cancelled. No payment had been taken, so there is nothing to refund.`,
    nextStep:
      "If you'd like to stay another time, you can book again from the bookings page whenever you're ready.",
  };
}

function buildPayableNarrative(
  booking: NarrativeBooking,
  link: NarrativeLinkState | null | undefined,
  now: Date
): BookingNarrative {
  const range = dateRange(booking);
  const amountDue = formatCents(booking.finalPriceCents);

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
}: ResolveBookingNarrativeInput): BookingNarrative {
  const ordered = sortedByOccurredAt(events);
  const status = booking.status;

  if (status === "PAID" || status === "COMPLETED") {
    return buildPaidNarrative(booking, ordered, club);
  }

  if (status === "CANCELLED" || status === "BUMPED") {
    return buildCancelledNarrative(booking, ordered, club);
  }

  if (status === "AWAITING_REVIEW") {
    if (booking.adminReviewStatus === "REJECTED") {
      return buildCancelledNarrative(booking, ordered, club);
    }
    return {
      state: "under_review",
      headline: "Awaiting review",
      message: `Your booking for ${dateRange(booking)} is waiting for an admin to review it before any payment is taken.`,
      nextStep:
        "No action is needed right now — we'll email you as soon as it's approved.",
    };
  }

  if (PAYABLE_STATUSES.has(status)) {
    return buildPayableNarrative(booking, link, now);
  }

  // DRAFT / WAITLISTED / WAITLIST_OFFERED and any unexpected state: a clear,
  // specific fallback rather than a generic error.
  return {
    state: "unknown",
    headline: "Booking link",
    message: `We couldn't find a payment due for your booking for ${dateRange(booking)} right now.`,
    nextStep:
      "Check the booking on your bookings page, or contact the club if something looks wrong.",
  };
}
