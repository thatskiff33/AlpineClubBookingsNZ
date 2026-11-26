// The booking-vs-Xero repair's read of a payment's refund-note gap and
// coverage, and (#4328, `INV-ADDPAY-043`) its refund-note amount check. A
// bank-transfer payment can hold several live refund notes - its one canonical
// note, plus a per-refund note for each later hand-back (#4287) and card refund
// (#4312) - so the cash refund is judged against all of them together, never
// against the canonical note alone.
import logger from "@/lib/logger";
import type { BookingClassificationContext, BookingPaymentRecord, BookingRepairRecord, BookingXeroRepairAction, MutableFinding, ResolvedLocalObject, XeroObjectLinkRecord } from "./xero-booking-repair-types";
import type { RepairDependencies } from "./xero-booking-repair-deps";
import { getCashCancellationRefundCandidateCents } from "./xero-booking-repair-analysis";
import { addAction, addFinding, addXeroAmountMismatchFinding, buildManualReviewAction } from "./xero-booking-repair-findings";
import { paidBackRefundRequestCents } from "./xero-booking-repair-request-notes";
import { readStoredXeroAmountCents } from "./xero-booking-repair-utils";
import { isPerDeltaRefundNoteLink, isRefundNoteLinkOf } from "@/lib/xero-refund-note-status";

/**
 * The payment's live per-refund notes: active `REFUND_CREDIT_NOTE` links
 * stamped `perDelta` that Xero has not voided (`INV-ADDPAY-041`). Never the
 * canonical note, which `canonicalRefundNoteCandidates` resolves from the rest.
 */
function livePerRefundNoteLinks(
  links: readonly XeroObjectLinkRecord[],
  cancelledRefundNoteIds: ReadonlySet<string>,
): XeroObjectLinkRecord[] {
  return links.filter(
    (link) =>
      link.active &&
      isRefundNoteLinkOf(link) &&
      isPerDeltaRefundNoteLink(link.metadata) &&
      !cancelledRefundNoteIds.has(link.xeroObjectId),
  );
}

/** Whether a bank payment holds a live per-refund note, so its notes' coverage is read for the amount check. */
function readsRefundNoteCoverage(
  payment: Pick<BookingPaymentRecord, "source">,
  links: readonly XeroObjectLinkRecord[],
  cancelledRefundNoteIds: ReadonlySet<string>,
): boolean {
  return payment.source === "INTERNET_BANKING" && livePerRefundNoteLinks(links, cancelledRefundNoteIds).length > 0;
}

/**
 * #3635 (composed review): the refund cents a note may still answer, read
 * through the one gap reader (`readRefundCreditNoteGap`: note-eligible cash
 * less coverage, resolved notes included), so the missing-refund-note arm
 * never asks for a late capture's refund no note may answer. #3880 round 3:
 * every source, so a bank payment's per-refund notes - never its canonical
 * note - still count as cover and a fully covered booking asks for nothing.
 * #4328: the same read's coverage judges a bank payment's several notes
 * together, read once more for one that is not cancelled - never twice.
 * Its coverage is "unreadable" when the read threw, found no note-eligible
 * cash, or met a hand-resolved note whose amount cannot be read.
 */
export async function readRefundNoteGaps(
  bookings: readonly BookingRepairRecord[],
  deps: Pick<RepairDependencies, "readRefundCreditNoteGap">,
  paymentLinksOf: (paymentId: string) => XeroObjectLinkRecord[],
  cancelledRefundNoteIds: ReadonlySet<string>,
) {
  const refundNoteUncoveredCentsByPaymentId = new Map<string, number>();
  const refundNoteCoverageByPaymentId = new Map<string, { coveredCents: number; lateCaptureExcludedCents: number } | "unreadable">();
  for (const booking of bookings) {
    const payment = booking.payment;
    if (!payment || payment.refundedAmountCents <= 0) continue;
    const cancelled = booking.status === "CANCELLED";
    if (!cancelled && !readsRefundNoteCoverage(payment, paymentLinksOf(payment.id), cancelledRefundNoteIds)) continue;
    try {
      const gap = await deps.readRefundCreditNoteGap({
        id: payment.id,
        bookingId: booking.id,
        refundedAmountCents: payment.refundedAmountCents,
      });
      // #3924 round 8: a CARD note's ask, so a close's own bank cash is left out.
      if (cancelled) refundNoteUncoveredCentsByPaymentId.set(payment.id, gap.uncoveredCents - gap.paidAnotherWayUncoveredCents);
      // No note-eligible cash means the reader summed no coverage; a
      // hand-resolved note with no readable amount means the sum left it out.
      const readable = gap.cashRefundCents > 0 && gap.unreadableResolvedOperationIds.length === 0;
      refundNoteCoverageByPaymentId.set(
        payment.id,
        readable ? { coveredCents: gap.coveredCents, lateCaptureExcludedCents: gap.lateCaptureExcludedCents } : "unreadable",
      );
    } catch (err) {
      refundNoteCoverageByPaymentId.set(payment.id, "unreadable");
      logger.warn({ err, paymentId: payment.id }, "Could not read a payment's refund-note gap; the missing-note check sizes from the refunded total and the several-notes comparison is reported for manual review");
    }
  }
  return { refundNoteUncoveredCentsByPaymentId, refundNoteCoverageByPaymentId };
}

const NOTES_DISAGREE_SUMMARY =
  "The payment's live refund credit notes together do not match the local cash refund. Check each note in Xero before changing any of them.";
const COVERAGE_UNREADABLE_SUMMARY =
  "The payment's live refund credit notes could not be totalled to compare with the local cash refund. Check each note in Xero before changing any of them.";

/**
 * Compares the local cash refund (`getCashCancellationRefundCandidateCents`)
 * with the payment's refund notes. A bank payment with a canonical note and at
 * least one other live note, and a cash candidate to judge, is judged by the
 * notes' combined coverage against that candidate less the refunds of late
 * captures no note may answer (both from the gap reader, `refundNoteCoverage`);
 * any disagreement, or a coverage that
 * could not be read, is one manual-review finding and never a resize of one
 * note. Every other payment keeps the canonical note's check.
 */
export function addRefundCreditNoteAmountFindings(params: {
  findings: MutableFinding[];
  actionMap: Map<string, BookingXeroRepairAction>;
  context: BookingClassificationContext;
  refundCreditNote: ResolvedLocalObject;
}) {
  const { findings, actionMap, context, refundCreditNote } = params;
  const { booking, paymentLinks, paymentOperations } = context;
  const payment = booking.payment!;
  const refundAmountCents = getCashCancellationRefundCandidateCents(booking, paidBackRefundRequestCents(context), context.modificationOperationsById);
  if (refundAmountCents === null || refundAmountCents <= 0) return;

  const otherLiveNotes = livePerRefundNoteLinks(paymentLinks, context.cancelledRefundNoteIds).filter(
    (link) => link.xeroObjectId !== refundCreditNote.objectId,
  );
  if (payment.source !== "INTERNET_BANKING" || otherLiveNotes.length === 0) {
    addXeroAmountMismatchFinding({
      findings,
      actionMap,
      bookingId: booking.id,
      expectedAmountCents: refundAmountCents,
      resolved: refundCreditNote,
      links: paymentLinks,
      operations: paymentOperations,
      xeroObjectType: "CREDIT_NOTE",
      role: "REFUND_CREDIT_NOTE",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      summary: "The refund credit-note amount evidence does not match the local cash refund amount.",
      details: { paymentId: payment.id, refundAmountCents, paymentRefundedAmountCents: payment.refundedAmountCents },
    });
    return;
  }

  // #4328: coverage sums every live note, the canonical one too, so it is
  // judged against the whole local cash refund less only the refunds of late
  // captures Xero never received (the gap reader's own exclusion, `INV-PAY-110`).
  // Never the reader's note-eligible cash: on a bank payment with a card refund
  // it counts card refunds and hand-backs with their own notes, never the cash
  // the canonical note answers.
  const coverage = typeof context.refundNoteCoverage === "object" ? context.refundNoteCoverage : null;
  const expectedAmountCents = coverage ? refundAmountCents - coverage.lateCaptureExcludedCents : null;
  if (coverage && coverage.coveredCents === expectedAmountCents) return;

  const summary = coverage === null ? COVERAGE_UNREADABLE_SUMMARY : NOTES_DISAGREE_SUMMARY;
  const action = addAction(actionMap, buildManualReviewAction(booking.id, summary));
  addFinding(findings, {
    code: "XERO_AMOUNT_MISMATCH",
    severity: "manual_review",
    summary,
    safeToAutoApply: false,
    details: {
      paymentId: payment.id,
      expectedAmountCents,
      coveredCents: coverage?.coveredCents ?? null,
      cashRefundCandidateCents: refundAmountCents,
      paymentRefundedAmountCents: payment.refundedAmountCents,
      canonicalCreditNoteId: refundCreditNote.objectId,
      otherRefundNotes: otherLiveNotes.map((link) => ({
        creditNoteId: link.xeroObjectId,
        amountCents: readStoredXeroAmountCents(link.metadata),
      })),
    },
    actionKeys: [action.key],
  });
}
