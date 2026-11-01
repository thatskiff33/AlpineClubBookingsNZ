import { additionalAskCause } from "@/lib/additional-ask-cause";
import { bookingOwner } from "@/lib/booking-owner";
import { prisma } from "@/lib/prisma";
import { bookingMoneyReconciliationForViewer } from "@/lib/booking-money-reconciliation-audience";
import type { BoundClubTime } from "@/lib/club-time";
import type { ClubFormat } from "@/lib/club-format";
import { buildBookingHistoryItems } from "@/lib/booking-history";
import { loadRateMembershipLabelResolver } from "@/lib/rate-membership-label";
import {
  resolveBookingNarrative,
  type NarrativeEvent,
} from "@/lib/booking-narrative";
import {
  asDuplicateCaptureRefundSnapshot,
  isDuplicateCaptureRefundEvent,
} from "@/lib/duplicate-capture-refund-event";
import { settlementMarkerTimelineEntries } from "@/lib/manual-settlement-reversal-event";
import { bookingHasOpenFinancialReview } from "@/lib/booking-financial-review-visibility";
import { readBookingAmountOwed } from "@/lib/booking-amount-owed";
import { readCancelledCardRefund, readCardShortfallTaskStatuses } from "@/lib/cancel-card-refund-shortfall-status";
import type { BookingDetailRecord } from "./load-booking-detail";
import type { BookingDetailViewer } from "./booking-detail-viewer";

/**
 * WHAT HAS HAPPENED TO THIS BOOKING (#2958): the audit rows and lifecycle
 * events it reads, the open-financial-review flag (read ONCE here — #3033 — and
 * returned so the admin tools reuse it rather than query again), the
 * plain-language narrative shared with the public payment-link page, and the
 * transaction-history timeline. The admin-only rows are withheld at the data
 * feed, on `canSeeAdminTools`, exactly as before; the builders this calls are
 * the canonical ones.
 *
 * Moved verbatim from `page.tsx`, comments included.
 */
export async function loadBookingDetailHistory({
  booking,
  club,
  viewer,
  format,
  additionalCollectionPending = false,
}: {
  booking: BookingDetailRecord;
  club: BoundClubTime;
  viewer: BookingDetailViewer;
  /** The club's format (#3565), resolved once by the page and threaded here. */
  format: ClubFormat;
  additionalCollectionPending?: boolean;
}) {
  const { canSeeAdminTools, canSeeOwnerCredit } = viewer;
  const bookingAuditLogs = await prisma.auditLog.findMany({
    where: {
      targetId: booking.id,
      action: {
        in: [
          "booking.payment.confirmed",
          "booking.payment.failed",
          "booking.modification.payment.confirmed",
          "booking.modification.payment.failed",
          // #2397: the cash / off-Xero settlement of an outstanding price
          // increase, so the extra is never absorbed silently.
          "booking-payment.manual-payment.additional-settled",
          // #2265 (#2319 door 2): the settle-time note telling the member their
          // saved credit choice was not applied and is still on their account.
          "booking.credit_election.unapplied",
          "booking.cancel",
          "booking.delete.draft",
          "booking.delete.cancelled.soft",
          // #3232 D3, ADMIN VIEWERS ONLY, and the data feed is what is gated
          // rather than the render (the #2008 duplicate-capture pattern above).
          // `details` on these rows is whoever's explanation applies — a member's
          // recorded decision about their own two bookings, or an officer's
          // PRIVATE override reason, which the booking's own member must never
          // read. An officer needs it here because this is the page the queue's
          // "Review booking" button sends them to.
          ...(canSeeAdminTools
            ? ([
                "booking.hostingCoverage.incidentOpened",
                "booking.hostingCoverage.incidentUpdated",
              ] as const)
            : []),
        ],
      },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      action: true,
      details: true,
      createdAt: true,
    },
  });

  // Durable lifecycle events (issue #740) drive the same plain-language
  // narrative shown on the public payment-link page, so guests and admins read
  // identical wording for every booking state.
  const bookingEvents = await prisma.bookingEvent.findMany({
    where: { bookingId: booking.id },
    orderBy: { occurredAt: "asc" },
    select: {
      id: true,
      type: true,
      occurredAt: true,
      amountCents: true,
      reason: true,
      snapshot: true,
    },
  });
  /*
    #3033: money held for review on this booking. Read HERE, once, and handed to
    the pure narrative resolver as data — the resolver is reachable from
    instrumentation and a database read inside it would break it at import.

    Read for every viewer, member and admin alike, because the member-facing
    banner is the whole point: this is not admin-gated information, it is what
    the member is owed after their change saved.
  */
  const financialReviewPending = await bookingHasOpenFinancialReview(booking.id);

  /*
    #3991 (`INV-PAY-119`): what this booking owes — the price plus a change fee
    recorded on the payment, less the credit applied in the ledger — read ONCE
    for the whole page, through the same read as the payment-link page and its
    intent. The narrative quotes it, and it is returned so the pay card and the
    `{amountDue}` token are sized from this same figure rather than from the
    payment row's mirror column. At or below zero the narrative says there is
    nothing to pay.

    A viewer who cannot see the owner's account credit (`canSeeOwnerCredit`
    false — a linked guest) is not told it here either: the narrative names no
    credit (`ownerCreditHidden`) and the timeline is built for the
    `linked_guest` audience below. The amount owed is the same for everyone.
  */
  const amountOwed = await readBookingAmountOwed(booking);

  const bookingNarrative = resolveBookingNarrative({
    // The event stamps in the narrative are real instants and read in the
    // club's zone; its stay dates are @db.Date lodge nights and do not (#3123).
    club,
    financialReviewPending,
    ownerCreditHidden: !canSeeOwnerCredit,
    // #4097: a card cancel's shortfall tasks, so the narrative says where each part stands.
    cardShortfallStatuses: booking.status === "CANCELLED" ? await readCardShortfallTaskStatuses(booking.id) : {},
    additionalCollectionPending,
    // #4125: a card cancel's refund with no REFUNDED event - still being sent, made, or stalled;
    // #4145: closed "Paid another way", what the officer paid back.
    ...(booking.status === "CANCELLED" ? await readCancelledCardRefund(booking.id) : {}),
    booking: {
      status: booking.status,
      finalPriceCents: booking.finalPriceCents,
      amountOwed,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      firstName: bookingOwner(booking).member.firstName,
      adminReviewStatus: booking.adminReviewStatus,
      adminReviewNotes: booking.adminReviewNotes,
      adminReviewReason: booking.adminReviewReason,
    },
    events: bookingEvents.map(
      (event): NarrativeEvent => ({
        type: event.type,
        occurredAt: event.occurredAt,
        amountCents: event.amountCents,
        reason: event.reason,
        snapshot: event.snapshot,
      })
    ),
  }, format);

  // #2008 — the #1992 duplicate-capture auto-refund is an ADMIN-ONLY history
  // entry: it never enters the shared member/guest narrative, and only admin
  // viewers see it on the timeline. Gating the data feed (not just the render)
  // keeps it off member-facing surfaces entirely.
  const duplicateCaptureRefunds = canSeeAdminTools
    ? bookingEvents
        .filter((event) => isDuplicateCaptureRefundEvent(event))
        .map((event) => ({
          id: event.id,
          occurredAt: event.occurredAt,
          amountCents: event.amountCents ?? 0,
          duplicatePaymentIntentId:
            asDuplicateCaptureRefundSnapshot(event.snapshot)
              ?.duplicatePaymentIntentId ?? null,
        }))
    : [];

  // #3638 — the settlement markers (#2262's reversal and reciprocal fence,
  // #3638's second instrument) are admin-only for the same reason, and gated the
  // same way: the data feed, not just the render. They are the durable record
  // an admin reconciles from, so this timeline is where they are seen.
  const settlementMarkers = canSeeAdminTools
    ? settlementMarkerTimelineEntries(bookingEvents)
    : [];

  // #3530: an edit's itemised lines name each guest's rate category with the
  // same member/non-member word the invoice line uses (#2543), which needs the
  // club's NON_MEMBER type id. Read only when some edit stored lines.
  const rateLabels = booking.modifications.some(
    (modification) => modification.priceLines !== null,
  )
    ? await loadRateMembershipLabelResolver(prisma)
    : null;

  const bookingHistory = buildBookingHistoryItems({
    createdAt: booking.createdAt,
    // #3232 D3 (owner, 4 September 2026): the incident's recorded explanation is
    // readable by anyone with booking-edit access, and by nobody else. The audit
    // query above already withholds the rows; this says the same thing to the
    // builder, so a future edit to either one cannot open the door on its own.
    // #3991: a viewer kept from the owner's credit is its own audience.
    audience: canSeeAdminTools ? "staff" : canSeeOwnerCredit ? "member" : "linked_guest",
    payment: booking.payment
      ? {
          status: booking.payment.status,
          amountCents: booking.payment.amountCents,
          refundedAmountCents: booking.payment.refundedAmountCents,
          additionalAmountCents: booking.payment.additionalAmountCents,
          additionalPaymentStatus: booking.payment.additionalPaymentStatus,
          // #2350: dates the "additional payment requested" timeline entry from
          // the obligation itself rather than the payment row's last touch.
          latestAdditionalTransactionCreatedAt:
            booking.payment.transactions[0]?.createdAt ?? null,
          askCause: additionalAskCause(booking.payment.transactions),
          createdAt: booking.payment.createdAt,
          updatedAt: booking.payment.updatedAt,
        }
      : null,
    modifications: booking.modifications,
    refundRequests: booking.refundRequests,
    auditLogs: bookingAuditLogs,
    duplicateCaptureRefunds,
    settlementMarkers,
    // #3033: the same flag the banner above is built from, so the timeline's
    // priced modification row and the banner cannot disagree about whether this
    // booking's money is settled.
    financialReviewPending,
    rateLabels,
  }, format);

  return {
    financialReviewPending,
    amountOwed,
    bookingNarrative,
    bookingHistory,
    // This is the booking's current derived state, not a durable past event.
    // Keep it officer-only at the data boundary, matching the other private
    // integrity evidence loaded above. #3278: through the shared gate, so the
    // withheld case is a named state rather than a null every reader gets to
    // interpret for itself.
    moneyReconciliation: bookingMoneyReconciliationForViewer(
      booking.moneyReconciliation,
      { canSeeAdminTools },
    ),
  };
}

export type BookingDetailHistory = Awaited<
  ReturnType<typeof loadBookingDetailHistory>
>;
