import { additionalPaymentEpisodeStartedAt } from "@/lib/additional-payment-chase";
import {
  MODIFICATION_LABELS,
  describeModification,
  memberFacingNoteOf,
  type BookingHistoryModification,
} from "@/lib/booking-history-modification-narrative";
import { hasCapturedPayment } from "@/lib/booking-payment-state";
import { formatCents, formatSignedCents } from "@/lib/utils";

export type BookingHistoryTone = "default" | "success" | "warning" | "danger";

interface BookingHistoryAuditLog {
  id: string;
  action: string;
  details: string | null;
  createdAt: Date;
}

interface BookingHistoryPayment {
  status: string;
  amountCents: number;
  refundedAmountCents: number;
  additionalAmountCents: number;
  additionalPaymentStatus: string | null;
  /**
   * When the CURRENT additional-payment obligation was raised — the latest
   * ADDITIONAL PaymentTransaction's creation (#2350). The timeline dates the
   * "still awaiting payment" entry from this rather than from the payment row's
   * `updatedAt`, which moves every time anything touches the row (a reminder
   * stamp, a Xero link, a refund) and would slide the entry back to the top of
   * the timeline each time. Optional: callers that do not load the transactions
   * fall back to the payment's own creation, which is stable.
   */
  latestAdditionalTransactionCreatedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface BookingHistoryRefundRequest {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reason: string;
  requestedAmountCents: number | null;
  approvedAmountCents: number | null;
  adminNotes: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
}

export interface BookingHistoryItem {
  id: string;
  occurredAt: Date;
  category: "Booking" | "Payment" | "Refund" | "Modification";
  title: string;
  detail: string | null;
  amountDisplay: string | null;
  tone: BookingHistoryTone;
}

/**
 * A #1992 duplicate-capture auto-refund, surfaced on the booking history
 * timeline (#2008). The page passes these ONLY for admin viewers, so this entry
 * stays admin-only while every member-facing history item is unchanged.
 */
interface BookingHistoryDuplicateCaptureRefund {
  /** Stable id for the timeline item key (the BookingEvent id). */
  id: string;
  occurredAt: Date;
  amountCents: number;
  /** The refunded duplicate capture's PaymentIntent id, when known. */
  duplicatePaymentIntentId: string | null;
}

/**
 * WHO is reading this timeline (#3232 fix round).
 *
 * REQUIRED, WITH NO DEFAULT, and that is the whole value of it. One row this
 * builder renders replays an audit row's `details` verbatim, and `details` on a
 * hosting-coverage incident can be an OFFICER'S PRIVATE OVERRIDE REASON, which the
 * booking's own member must never read. Before this parameter the only thing
 * standing between a member and that text was a conditional array a hundred and
 * seventy lines away in the page that happens to call this function — a policed
 * rule rather than an unrepresentable one, on an exported pure function anybody
 * can call. A required argument makes the compiler enumerate every caller
 * (`INV-SSOT-001`, `INV-PRIV`).
 *
 * `"staff"` means the viewer holds `bookings:edit` (the page's `canSeeAdminTools`),
 * which is the readership the owner chose for that reason on 4 September 2026.
 */
export type BookingHistoryAudience = "member" | "staff";

interface BuildBookingHistoryOptions {
  createdAt: Date;
  audience: BookingHistoryAudience;
  payment: BookingHistoryPayment | null;
  modifications: BookingHistoryModification[];
  refundRequests: BookingHistoryRefundRequest[];
  auditLogs: BookingHistoryAuditLog[];
  /**
   * #1992 duplicate-capture auto-refunds (#2008). Admin-only: the page supplies
   * these only when the viewer can see admin tools, so members see nothing new.
   * Defaults to none.
   */
  duplicateCaptureRefunds?: BookingHistoryDuplicateCaptureRefund[];
  /**
   * #3033 (epic #2797): this booking has an OPEN financial review — a change
   * saved while the refund or credit for it could not be worked out from stored
   * history.
   *
   * Arrives as data, like every other option here; the page reads it once with
   * `bookingHasOpenFinancialReview` and hands the same answer to this builder
   * and to the narrative resolver, so the timeline and the banner above it
   * cannot disagree on one page load.
   *
   * Defaults to false, so a caller that has not asked renders the timeline it
   * always has rather than making a claim about money it has not checked.
   */
  financialReviewPending?: boolean;
}

function parseAuditDetails(details: string | null): Record<string, unknown> | null {
  if (!details) {
    return null;
  }

  try {
    const parsed = JSON.parse(details) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function buildBookingHistoryItems({
  createdAt,
  audience,
  payment,
  modifications,
  refundRequests,
  auditLogs,
  duplicateCaptureRefunds = [],
  financialReviewPending = false,
}: BuildBookingHistoryOptions): BookingHistoryItem[] {
  /*
    #3033: WHICH row the open review belongs to.

    The most recent modification that moved the price. A review is raised BY a
    priced edit, and the epic fences a second money-affecting edit while
    unresolved money would be its baseline, so no later priced modification can
    exist above the one holding the review. Modifications that changed no price
    (a credit-election edit, for instance) carry no amount and are not
    candidates — there is no figure on them to qualify.

    Chosen by `createdAt` rather than by the caller's array order, so a query
    that returns oldest-first cannot silently qualify the wrong row.

    Deliberately NOT applied to every modification on the booking: an edit from
    six months ago settled normally, and telling an admin or a member that ITS
    amount is still being worked out would be false.
  */
  const reviewedModificationId = financialReviewPending
    ? (modifications
        .filter((modification) => modification.priceDiffCents !== 0)
        .reduce<BookingHistoryModification | null>(
          (latest, modification) =>
            latest === null || modification.createdAt > latest.createdAt
              ? modification
              : latest,
          null,
        )?.id ?? null)
    : null;
  const items: BookingHistoryItem[] = [
    {
      id: "booking-created",
      occurredAt: createdAt,
      category: "Booking",
      title: "Booking created",
      detail: "This booking was created.",
      amountDisplay: null,
      tone: "default",
    },
  ];

  let hasPrimaryPaymentSuccess = false;
  let hasPrimaryPaymentFailure = false;
  let hasAdditionalPaymentSuccess = false;
  let hasAdditionalPaymentFailure = false;

  for (const auditLog of auditLogs) {
    const parsedDetails = parseAuditDetails(auditLog.details);

    switch (auditLog.action) {
      case "booking.payment.confirmed": {
        hasPrimaryPaymentSuccess = true;
        const amountCents =
          typeof parsedDetails?.amountCents === "number"
            ? parsedDetails.amountCents
            : null;

        items.push({
          id: `audit-${auditLog.id}`,
          occurredAt: auditLog.createdAt,
          category: "Payment",
          title: "Payment successful",
          detail: "Original booking payment was captured successfully.",
          amountDisplay: amountCents != null ? formatCents(amountCents) : null,
          tone: "success",
        });
        break;
      }
      case "booking.payment.failed": {
        hasPrimaryPaymentFailure = true;
        const amountCents =
          typeof parsedDetails?.amountCents === "number"
            ? parsedDetails.amountCents
            : null;
        const errorMessage =
          typeof parsedDetails?.errorMessage === "string"
            ? parsedDetails.errorMessage
            : auditLog.details;

        items.push({
          id: `audit-${auditLog.id}`,
          occurredAt: auditLog.createdAt,
          category: "Payment",
          title: "Payment failed",
          detail: errorMessage ?? "The payment attempt did not complete successfully.",
          amountDisplay: amountCents != null ? formatCents(amountCents) : null,
          tone: "danger",
        });
        break;
      }
      case "booking.modification.payment.confirmed": {
        hasAdditionalPaymentSuccess = true;
        const amountCents =
          typeof parsedDetails?.additionalAmountCents === "number"
            ? parsedDetails.additionalAmountCents
            : null;

        items.push({
          id: `audit-${auditLog.id}`,
          occurredAt: auditLog.createdAt,
          category: "Payment",
          title: "Additional payment successful",
          detail: "Extra payment for a booking change was captured successfully.",
          amountDisplay: amountCents != null ? formatCents(amountCents) : null,
          tone: "success",
        });
        break;
      }
      // #2397. An admin recorded a cash / off-Xero payment on a booking that
      // still carried an uncollected price increase, and confirmed the money
      // covered that increase too. It is the SAME fact as the card case above —
      // the extra was collected — so it sets the same flag and suppresses the
      // generic fallback below; only the wording differs, because how the money
      // arrived is what the reader needs to know.
      case "booking-payment.manual-payment.additional-settled": {
        hasAdditionalPaymentSuccess = true;
        const amountCents =
          typeof parsedDetails?.additionalAmountCents === "number"
            ? parsedDetails.additionalAmountCents
            : null;

        items.push({
          id: `audit-${auditLog.id}`,
          occurredAt: auditLog.createdAt,
          category: "Payment",
          title: "Additional payment recorded manually",
          detail:
            "An admin recorded that the payment received for this booking also covered the extra owing from a later change.",
          amountDisplay: amountCents != null ? formatCents(amountCents) : null,
          tone: "success",
        });
        break;
      }
      case "booking.modification.payment.failed": {
        hasAdditionalPaymentFailure = true;
        const amountCents =
          typeof parsedDetails?.additionalAmountCents === "number"
            ? parsedDetails.additionalAmountCents
            : typeof parsedDetails?.amountCents === "number"
              ? parsedDetails.amountCents
              : null;
        const errorMessage =
          typeof parsedDetails?.errorMessage === "string"
            ? parsedDetails.errorMessage
            : auditLog.details;

        items.push({
          id: `audit-${auditLog.id}`,
          occurredAt: auditLog.createdAt,
          category: "Payment",
          title: "Additional payment failed",
          detail:
            errorMessage ?? "The extra payment required by a booking change failed.",
          amountDisplay: amountCents != null ? formatCents(amountCents) : null,
          tone: "danger",
        });
        break;
      }
      // #2265 (#2319 door 2; #2262 door 3). The member asked to put account
      // credit towards this booking and the settlement could not honour it —
      // most plainly, an Internet Banking invoice that was raised and paid at
      // the full price, or a cash / off-Xero payment an admin recorded for the
      // full amount owing.
      // Their balance was never touched, so the honest note is "we did not use
      // it, and you still have it": a silent cleared column would leave them
      // believing credit had been spent that is in fact still theirs. Rendered
      // for members and admins alike, because both need the same answer to
      // "what happened to my credit?".
      case "booking.credit_election.unapplied": {
        const electionCents =
          typeof parsedDetails?.creditElectionCents === "number"
            ? parsedDetails.creditElectionCents
            : null;
        // #2262 delta MED-2. The elected figure is a record of a PAST choice —
        // possibly months and several bookings ago — and quoting it as what is
        // "still available" overstated the balance for anyone who had spent
        // some of it since. The reporter records the live balance at the moment
        // of the clear alongside the election; when it is present, that is the
        // figure the member is given, because it is the one they can spend.
        // Older rows (and rows whose balance read failed) carry no balance, so
        // they fall back to saying only what is certainly true: the credit was
        // not used here and the balance was not debited.
        const availableCreditCents =
          typeof parsedDetails?.availableCreditCents === "number"
            ? parsedDetails.availableCreditCents
            : null;

        const electedSentence =
          electionCents != null
            ? `You had chosen to put ${formatCents(electionCents)} of account credit towards this booking, but it was paid in full before the credit could be applied.`
            : "The account credit saved against this booking was not applied, because the booking was paid in full first.";
        const balanceSentence =
          availableCreditCents != null
            ? ` Your credit was not used for this booking and your balance was not reduced — you had ${formatCents(availableCreditCents)} of account credit available at the time.`
            : " Your credit was not used for this booking and your balance was not reduced.";

        items.push({
          id: `audit-${auditLog.id}`,
          occurredAt: auditLog.createdAt,
          category: "Payment",
          title: "Saved account credit was not applied",
          detail: `${electedSentence}${balanceSentence}`,
          // The amount of the EVENT — how much credit went unapplied — not a
          // claim about what is available; the detail above owns that, and owns
          // it with the live figure.
          amountDisplay: electionCents != null ? formatCents(electionCents) : null,
          tone: "warning",
        });
        break;
      }
      // #3232 D3: WHY THIS BOOKING IS FLAGGED, in words, on the booking itself.
      // STAFF ONLY, decided here from the audience rather than trusted to the
      // caller's query, because `details` can be an officer's private override
      // reason and this same page is read by the booking's own member. The page's
      // feed is still gated too — two locks on one door, and the one that cannot be
      // lost by editing a query lives here. Replayed verbatim, as the cancel row
      // below is: it is the one derived explanation the incident writer recorded.
      case "booking.hostingCoverage.incidentOpened":
      case "booking.hostingCoverage.incidentUpdated":
        if (audience !== "staff") break;
        items.push({
          id: `audit-${auditLog.id}`,
          occurredAt: auditLog.createdAt,
          category: "Booking",
          title: auditLog.action.endsWith("incidentOpened")
            ? "Adult member cover flagged"
            : "Adult member cover flag updated",
          detail: auditLog.details ?? "This booking needs adult member cover.",
          amountDisplay: null,
          tone: "warning",
        });
        break;
      case "booking.cancel":
        items.push({
          id: `audit-${auditLog.id}`,
          occurredAt: auditLog.createdAt,
          category: "Booking",
          title: "Booking cancelled",
          detail: auditLog.details ?? "This booking was cancelled.",
          amountDisplay: null,
          tone: "warning",
        });
        break;
      default:
        break;
    }
  }

  for (const modification of modifications) {
    const detailParts = [describeModification(modification)];
    if (modification.changeFeeCents > 0) {
      detailParts.push(`Change fee applied: ${formatCents(modification.changeFeeCents)}.`);
    }
    // #2390: when a promotion's usage cap stopped it reaching somebody this
    // edit added, the reprice recorded the exact sentence the member was shown
    // at the time. Replayed verbatim so the booking's own summary, the edit
    // preview and the modification email all tell the one story.
    const promoCoverageNote = memberFacingNoteOf(
      modification,
      "promoCoverageNote"
    );
    if (promoCoverageNote) {
      detailParts.push(promoCoverageNote);
    }

    // #3179: and the promo-code change this edit could not carry, replayed the
    // same way and for the same reason — the member read this sentence at the
    // edit, so the booking's own record has to say it in those words too. A
    // modification written before #3179 simply has no such key.
    const promoChangeNotAppliedNote = memberFacingNoteOf(
      modification,
      "promoChangeNotAppliedNote"
    );
    if (promoChangeNotAppliedNote) {
      detailParts.push(promoChangeNotAppliedNote);
    }

    /*
      #3033: the figure stays and stops speaking for itself.

      `priceDiffCents` is real — it is how much the booking's own total moved,
      and the structural edit did move it. What is NOT established is the refund
      or credit that follows from it, and the green "success" tone said exactly
      that: a member reading "-$120.00" in the same colour as a completed refund,
      under a banner saying no figure is known, reads it as money returned.

      So the tone drops to neutral and the row says what is outstanding. The
      amount is not hidden and not corrected — hiding it would leave no figure
      at all, and correcting it is the estimation this epic exists to forbid.
    */
    const awaitingReview = modification.id === reviewedModificationId;
    if (awaitingReview) {
      detailParts.push(
        "The refund or credit for this change is still being worked out by the club; the figure beside it is how much the booking's own total changed, not an amount that has been paid back or charged.",
      );
    }

    items.push({
      id: `modification-${modification.id}`,
      occurredAt: modification.createdAt,
      category: "Modification",
      title:
        MODIFICATION_LABELS[modification.modificationType] ??
        modification.modificationType,
      detail: detailParts.filter(Boolean).join(" "),
      amountDisplay:
        modification.priceDiffCents !== 0
          ? formatSignedCents(modification.priceDiffCents)
          : null,
      tone: awaitingReview
        ? "default"
        : modification.priceDiffCents > 0
          ? "warning"
          : modification.priceDiffCents < 0
            ? "success"
            : "default",
    });
  }

  for (const refundRequest of refundRequests) {
    items.push({
      id: `refund-request-created-${refundRequest.id}`,
      occurredAt: refundRequest.createdAt,
      category: "Refund",
      title: "Refund appeal submitted",
      detail: refundRequest.reason,
      amountDisplay:
        refundRequest.requestedAmountCents != null
          ? formatCents(refundRequest.requestedAmountCents)
          : null,
      tone: refundRequest.status === "PENDING" ? "warning" : "default",
    });

    if (refundRequest.reviewedAt) {
      items.push({
        id: `refund-request-reviewed-${refundRequest.id}`,
        occurredAt: refundRequest.reviewedAt,
        category: "Refund",
        title:
          refundRequest.status === "APPROVED"
            ? "Refund appeal approved"
            : "Refund appeal rejected",
        detail:
          refundRequest.adminNotes ??
          (refundRequest.status === "APPROVED"
            ? "An admin approved this refund appeal."
            : "An admin rejected this refund appeal."),
        amountDisplay:
          refundRequest.status === "APPROVED" &&
          refundRequest.approvedAmountCents != null
            ? formatCents(refundRequest.approvedAmountCents)
            : null,
        tone: refundRequest.status === "APPROVED" ? "success" : "danger",
      });
    }
  }

  if (payment && hasCapturedPayment(payment) && !hasPrimaryPaymentSuccess) {
    items.push({
      id: "payment-fallback-success",
      occurredAt: payment.updatedAt,
      category: "Payment",
      title: "Payment recorded",
      detail: "A successful payment is attached to this booking.",
      amountDisplay: formatCents(payment.amountCents),
      tone: "success",
    });
  }

  if (payment?.status === "FAILED" && !hasPrimaryPaymentFailure) {
    items.push({
      id: "payment-fallback-failure",
      occurredAt: payment.updatedAt,
      category: "Payment",
      title: "Payment failed",
      detail: "The latest payment attempt did not complete successfully.",
      amountDisplay:
        payment.amountCents > 0 ? formatCents(payment.amountCents) : null,
      tone: "danger",
    });
  }

  if (
    payment &&
    payment.additionalAmountCents > 0 &&
    payment.additionalPaymentStatus === "SUCCEEDED" &&
    !hasAdditionalPaymentSuccess
  ) {
    items.push({
      id: "payment-fallback-additional-success",
      occurredAt: payment.updatedAt,
      category: "Payment",
      title: "Additional payment recorded",
      detail: "A booking change increased the total and the extra payment succeeded.",
      amountDisplay: formatCents(payment.additionalAmountCents),
      tone: "success",
    });
  }

  // #2350: the timeline had a fallback for a SUCCEEDED and a FAILED additional
  // payment but none for one that is simply still awaiting the member, which is
  // the state an outstanding delta spends nearly all of its life in. Without
  // this entry the moment the price went up left no mark on the timeline at all.
  //
  // Dated from the obligation itself, not `payment.updatedAt`: the reminder cron
  // writes its stamps to this row every time it chases the member, and dating
  // the entry from the row's last touch would march it up the timeline on every
  // nudge, claiming the price changed when nothing about the booking did.
  //
  // The status test matches the owed predicate's uncollected half rather than
  // the literal string "PENDING": a legacy row written before the column was
  // populated carries a null status, and the owed test — every admin queue, the
  // finance panel, the reports figure and the chase cron — counts it. Testing
  // for "PENDING" alone left exactly those bookings with no timeline entry for
  // the moment their price went up. FAILED is excluded only because it has its
  // own, more specific entry immediately below. Note this is deliberately NOT
  // gated on the booking's lifecycle: the timeline is a record of what happened,
  // and the price DID go up even if the booking was later cancelled.
  if (
    payment &&
    payment.additionalAmountCents > 0 &&
    payment.additionalPaymentStatus !== "SUCCEEDED" &&
    payment.additionalPaymentStatus !== "FAILED"
  ) {
    items.push({
      id: "payment-additional-pending",
      occurredAt: additionalPaymentEpisodeStartedAt({
        paymentCreatedAt: payment.createdAt,
        latestAdditionalTransactionCreatedAt:
          payment.latestAdditionalTransactionCreatedAt ?? null,
      }),
      category: "Payment",
      title: "Additional payment requested",
      detail:
        "A booking change increased the total. This extra amount has not been paid yet.",
      amountDisplay: formatCents(payment.additionalAmountCents),
      tone: "warning",
    });
  }

  if (
    payment &&
    payment.additionalAmountCents > 0 &&
    payment.additionalPaymentStatus === "FAILED" &&
    !hasAdditionalPaymentFailure
  ) {
    items.push({
      id: "payment-fallback-additional-failure",
      occurredAt: payment.updatedAt,
      category: "Payment",
      title: "Additional payment failed",
      detail: "The latest extra payment required by a booking change failed.",
      amountDisplay: formatCents(payment.additionalAmountCents),
      tone: "danger",
    });
  }

  for (const refund of duplicateCaptureRefunds) {
    const intentClause = refund.duplicatePaymentIntentId
      ? ` Duplicate intent ${refund.duplicatePaymentIntentId}.`
      : "";
    items.push({
      id: `duplicate-capture-refund-${refund.id}`,
      occurredAt: refund.occurredAt,
      category: "Payment",
      title: "Duplicate capture auto-refunded",
      detail:
        "A second card capture on this already-paid booking was automatically refunded — the booking's settlement is unaffected." +
        intentClause,
      amountDisplay: formatCents(refund.amountCents),
      tone: "warning",
    });
  }

  return items.sort(
    (left, right) => right.occurredAt.getTime() - left.occurredAt.getTime()
  );
}
