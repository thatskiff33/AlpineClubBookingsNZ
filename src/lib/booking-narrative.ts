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
 * purity is load-bearing rather than stylistic: `payment-link-context.ts` is
 * one of the two callers, and until #2956 split it out it sat inside
 * `payment-link.ts`, which is reachable from `src/instrumentation.node.ts`, so
 * `server-only` — which is what reading the persisted zone here would drag in —
 * would have killed it at import. The split moved that caller and kept its
 * outside-request reader; changing which client reads the club's zone is an
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
import {
  FINANCIAL_REVIEW_NOTHING_MOVED,
  FINANCIAL_REVIEW_NOTHING_TO_DO,
  FINANCIAL_REVIEW_AMOUNT_PREDATES_THE_CHANGE,
  FINANCIAL_REVIEW_NOT_IN_THAT_FIGURE,
  FINANCIAL_REVIEW_WILL_BE_IN_TOUCH,
  FINANCIAL_REVIEW_WILL_BE_IN_TOUCH_OR_ASK,
  FINANCIAL_REVIEW_WORKING_IT_OUT,
} from "@/lib/booking-financial-review-copy";

export type BookingNarrativeState =
  | "payable"
  | "expired_payable"
  | "paid"
  | "bumped"
  | "cancelled_pre_payment"
  | "cancelled_post_payment"
  | "declined"
  | "under_review"
  /**
   * #3033 (epic #2797): the stay change SAVED and the money for it did not.
   *
   * Named apart from `under_review` on purpose. That one is the ADMIN BOOKING
   * APPROVAL queue — a booking waiting for an officer to allow it at all — and
   * reusing it here would have told a member with a confirmed stay that their
   * booking was awaiting approval, which is a different and more alarming
   * claim than the true one.
   */
  | "financial_review_pending"
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
  /**
   * #3033: this booking has an OPEN financial review — a stay or guest change
   * that saved while the refund or credit for it could not be worked out from
   * stored history (epic #2797).
   *
   * ARRIVES AS DATA, like `club` above, and for the same load-bearing reason:
   * this module is pure and was reachable from `src/instrumentation.node.ts`
   * through `payment-link.ts` (now `payment-link-context.ts`, #2956), so reading
   * it from the database here would drag `server-only` in and kill the module
   * at import. The caller reads it with
   * `bookingHasOpenFinancialReview` and hands the answer over.
   *
   * Defaults to false, so a caller that does not know stays on the wording it
   * has always produced rather than making a claim about money it has not
   * checked.
   */
  financialReviewPending?: boolean;
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
 * #3033 (epic #2797, owner decision D1): the stay change saved; the money for it
 * is being worked out by the club.
 *
 * Every sentence here is written against this issue's four rules, and each rule
 * is visible in the wording rather than assumed:
 *
 *  - the change is confirmed FIRST, in the headline and the opening clause,
 *    because that is the part the member acted on and it is settled;
 *  - the adjustment is described as something the club is working out, never as
 *    something that has happened. No verb here is in the past tense about money;
 *  - NO AMOUNT APPEARS AT ALL. Not `$0`, not an estimate, not the booking's
 *    `finalPriceCents` — which a parked edit writes back UNCHANGED, so it is the
 *    total from BEFORE the change while the dates around it are the new ones, so
 *    printing it would put a stale, authoritative-looking figure beside a
 *    sentence saying the figure is unknown;
 *  - nothing internal and nothing about the member: no cause, no diagnostic
 *    category, no "corrupt", "missing", "inconsistent" or "we could not find" —
 *    the wording is about the club doing a check, which is what is true, and
 *    the evidence vocabulary stays on the admin screen where it belongs.
 *
 * No `club` binding is taken because no instant is rendered: the only dates are
 * the stay's own lodge nights, which are calendar days and take no zone.
 *
 * ## What still reaches this, after #3194
 *
 * The FALLBACK arm of the review branch. A payable booking composes
 * {@link buildPayableWithFinancialReviewNarrative} and a paid one composes
 * {@link buildPaidWithFinancialReviewNarrative}, so what is left here is a
 * booking that is neither — DRAFT, WAITLISTED, WAITLIST_OFFERED — where these
 * sentences are the whole of what there is to say and are a far better answer
 * than the resolver's `unknown` fallback. The rules above still govern every
 * word of it; the two compositions state, each in its own docblock, why a figure
 * the member is genuinely owed an answer about survives beside them.
 */
function buildFinancialReviewPendingNarrative(
  booking: NarrativeBooking,
): BookingNarrative {
  return {
    state: "financial_review_pending",
    headline: "Your booking change is saved",
    message: `Thanks ${booking.firstName} — the change to your booking has been saved, and your stay is now ${dateRange(booking)}. ${FINANCIAL_REVIEW_WORKING_IT_OUT} ${FINANCIAL_REVIEW_NOTHING_MOVED}`,
    nextStep: `${FINANCIAL_REVIEW_NOTHING_TO_DO} ${FINANCIAL_REVIEW_WILL_BE_IN_TOUCH_OR_ASK}`,
  };
}

/**
 * #3033: the same booking still owes its ORDINARY payment, and also has money
 * held for review.
 *
 * The first shape of this branch sat above `PAYABLE_STATUSES` and returned the
 * review narrative outright, which was a real contradiction and not a
 * theoretical one. `PAYABLE_STATUSES` covers CONFIRMED, and a CONFIRMED-unpaid
 * booking renders the member's **Complete Payment** card
 * (`isPaymentOwedBookingStatus`) — so the banner said "there is nothing you need
 * to do about that change" directly beside a card asking for money. The
 * in-code argument for the placement only ever considered PAID.
 *
 * Composed rather than gated to PAID, because both facts are true and the
 * member needs both: the booking's stored price is still due and this link can
 * still take it, and separately an adjustment for a change is unpriced. That
 * stored price is the PRE-change one — a parked edit writes it back unchanged —
 * which is why the review half opens with
 * `FINANCIAL_REVIEW_AMOUNT_PREDATES_THE_CHANGE` rather than with the sentence
 * the paid composition uses (#3194 fix round). Gating the review branch to PAID
 * would have fixed the contradiction by removing the disclosure, which is the
 * opposite of what this issue is for — the member would pay, and hear nothing
 * about the money they may be owed.
 *
 * EVERY SENTENCE OF THE REVIEW HALF IS NOW SHARED (#3194). The bridging
 * sentence — "not part of that figure", a fact about the relationship between
 * the two amounts — was this module's own literal while this was the only place
 * that needed it, and so was the closing "we'll be in touch". The public
 * payment-link page needs the same five sentences beside a payment card it
 * renders itself, so they moved to `booking-financial-review-copy.ts` and both
 * surfaces compose from there. This function's output is byte-identical to what
 * it produced before the move; `financialReviewNoteBesideAnAmount` is the other
 * composition, and a test pins the two against each other sentence for sentence.
 * The clauses read correctly in either precisely because they name what they are
 * about rather than relying on where they sit.
 */
/**
 * #3194 (epic #2797): the booking is PAID, and it ALSO has money held for
 * review.
 *
 * ## The defect this closes
 *
 * #3033 put the review branch above the paid branch, and that was right about
 * the half it was aiming at: the paid next step is "Nothing more to do — we'll
 * see you at the lodge", which is the false reassurance the whole epic exists to
 * remove. But returning the review narrative OUTRIGHT threw away the other half
 * with it. `buildPaidNarrative` is the only place a member is ever told "we've
 * received your payment of $360.00 on 12 Aug", and on the public payment-link
 * page that narrative is the ENTIRE page: a member who paid by internet banking
 * and opened the link to check the club had received it got no answer at all, on
 * the one page whose whole purpose is that payment.
 *
 * That is the same mistake #3033's own review caught one branch over, where
 * gating the review to PAID would have "fixed the contradiction by removing the
 * disclosure" — see `buildPayableWithFinancialReviewNarrative`. Both facts are
 * true, so both are said, and the banned sentence is the only thing dropped.
 *
 * ## Why an amount appears here, and why it is not the amount under review
 *
 * The epic's rule is that the REVIEWED change's amount never appears, because
 * nobody knows it. The figure kept here is money the club has ALREADY RECEIVED,
 * read off a durable payment event — a settled historical fact, not a guess, and
 * not the post-edit `finalPriceCents` that
 * {@link buildFinancialReviewPendingNarrative} refuses. Saying it out loud is
 * the point of this branch. `FINANCIAL_REVIEW_NOT_IN_THAT_FIGURE` then states
 * the relationship between the two amounts explicitly. The payable narrative
 * needs a DIFFERENT sentence beside its "$120.00 is due" — that figure is the
 * booking's stored total, which a parked edit leaves at its pre-change value, so
 * it is stale as well as incomplete (#3194 fix round).
 *
 * It is composed even on the no-payment-was-required arm, where the "figure" is
 * nothing at all. That reads a little loosely, and it is still the right
 * sentence: it is what introduces "that change" for every clause after it, and a
 * member told no payment was required is precisely the one who needs to hear
 * that an unpriced change sits outside that.
 *
 * ## Why the next step is REPLACED rather than appended
 *
 * The payable composition appends, because "pay by card or internet banking
 * below" stays true beside a review. The paid next step does not: it opens with
 * "Nothing more to do", which is the sentence #3194 is named after. Its closing
 * pointer to the bookings page goes with it, deliberately — the two surfaces
 * that render this are the member's own booking page and a public link they are
 * not signed in on, so it is the least useful sentence on either, and keeping it
 * would have meant a third next-step shape to hold in agreement.
 *
 * The result is that both review compositions end identically, which is a
 * property worth having rather than a coincidence.
 */
function buildPaidWithFinancialReviewNarrative(
  booking: NarrativeBooking,
  events: NarrativeEvent[],
  club: BoundClubTime,
): BookingNarrative {
  const paid = buildPaidNarrative(booking, events, club);

  return {
    state: "financial_review_pending",
    // The paid headline is kept for the same reason the payable one is: the
    // most urgent fact about this booking is still the one the member came to
    // check, and "Your booking change is saved" above a payment they are trying
    // to confirm would bury it.
    headline: paid.headline,
    // #3194 fix round: this one KEEPS "not part of that figure", and the payable
    // composition beside it does not. The figure here is money the club has
    // already received, read off a durable payment event — a parked edit cannot
    // make that out of date, so there is nothing stale to disclose. The figure
    // there is the booking's stored total, which a parked edit leaves at its
    // pre-change value.
    message: `${paid.message} ${FINANCIAL_REVIEW_NOT_IN_THAT_FIGURE} ${FINANCIAL_REVIEW_WORKING_IT_OUT} ${FINANCIAL_REVIEW_NOTHING_MOVED}`,
    nextStep: `${FINANCIAL_REVIEW_NOTHING_TO_DO} ${FINANCIAL_REVIEW_WILL_BE_IN_TOUCH}`,
  };
}

function buildPayableWithFinancialReviewNarrative(
  booking: NarrativeBooking,
  link: NarrativeLinkState | null | undefined,
  now: Date,
): BookingNarrative {
  const payable = buildPayableNarrative(booking, link, now);

  return {
    state: "financial_review_pending",
    // The payable headline is kept: an unpaid booking's most urgent fact is
    // still that it is unpaid, and "Your booking change is saved" at the top of
    // a screen asking for payment would bury it.
    headline: payable.headline,
    // #3194 fix round: the STALE-amount sentence, not "not part of that figure".
    // `payable.message` has just said "$120.00 is due", and that is
    // `booking.finalPriceCents` — which a parked edit writes back UNCHANGED while
    // saving the new dates. So the amount above this clause is the price from
    // before the member's change, and saying only that the change's amount sits
    // outside it leaves them believing the rest of it is settled. See
    // `FINANCIAL_REVIEW_AMOUNT_PREDATES_THE_CHANGE`.
    message: `${payable.message} ${FINANCIAL_REVIEW_AMOUNT_PREDATES_THE_CHANGE} ${FINANCIAL_REVIEW_WORKING_IT_OUT} ${FINANCIAL_REVIEW_NOTHING_MOVED}`,
    nextStep: `${payable.nextStep} ${FINANCIAL_REVIEW_NOTHING_TO_DO} ${FINANCIAL_REVIEW_WILL_BE_IN_TOUCH}`,
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
  financialReviewPending = false,
}: ResolveBookingNarrativeInput): BookingNarrative {
  const ordered = sortedByOccurredAt(events);
  const status = booking.status;

  /*
    #3033 reordered the three status branches below AHEAD of the paid branch,
    which is behaviour-neutral: every one of them tests `booking.status` for a
    different single value, so at most one can ever match and the order between
    them cannot change an outcome. What the reorder buys is a place to put the
    financial-review branch where it outranks the LIVE states without outranking
    a cancellation.

    That placement is the whole decision. A cancelled, bumped or declined
    booking keeps its own narrative even while a review is open: those sentences
    describe what happened to the booking, which is the more important truth,
    and the review's own wording assumes a stay that is still going ahead.

    A PAYABLE or a PAID booking keeps its facts and has the review's ADDED to
    them, rather than swapped for them. #3033 composed the payable case and
    replaced the paid one; #3194 made the paid case a composition too, because
    replacing it dropped the confirmation that the member's money arrived — the
    only thing the public payment-link page had to say. What both compositions
    drop is the one sentence that was actually false, and each carries the
    argument for its own shape.
  */
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

  if (financialReviewPending) {
    /*
      A payable booking keeps its payment facts and GAINS the review ones
      (#3033). It does not swap one for the other: see
      `buildPayableWithFinancialReviewNarrative` for why replacing them told a
      CONFIRMED-unpaid member there was nothing to do beside a card asking them
      to pay.
    */
    if (PAYABLE_STATUSES.has(status)) {
      return buildPayableWithFinancialReviewNarrative(booking, link, now);
    }
    /*
      And a PAID booking keeps its payment facts and gains the review ones, for
      the same reason (#3194). #3033 replaced them, which removed "nothing more
      to do" and the confirmation that the money arrived along with it — on the
      public payment link, the only thing that page had to say.
    */
    if (status === "PAID" || status === "COMPLETED") {
      return buildPaidWithFinancialReviewNarrative(booking, ordered, club);
    }
    return buildFinancialReviewPendingNarrative(booking);
  }

  if (status === "PAID" || status === "COMPLETED") {
    return buildPaidNarrative(booking, ordered, club);
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
