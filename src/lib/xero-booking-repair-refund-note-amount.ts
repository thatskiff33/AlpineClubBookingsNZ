// #4328 (`INV-ADDPAY-043`): the booking-vs-Xero repair's refund-note amount
// check. A bank-transfer payment can hold several live refund notes - its one
// canonical note, plus a per-refund note for each later hand-back (#4287) and
// card refund (#4312) - so the cash refund is judged against all of them
// together, never against the canonical note alone.
import type { BookingClassificationContext, BookingPaymentRecord, BookingXeroRepairAction, MutableFinding, ResolvedLocalObject, XeroObjectLinkRecord } from "./xero-booking-repair-types";
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
export function livePerRefundNoteLinks(
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

/** Whether a bank payment holds a live per-refund note, so its notes' coverage is read for the check below. */
export function readsRefundNoteCoverage(
  payment: Pick<BookingPaymentRecord, "source">,
  links: readonly XeroObjectLinkRecord[],
  cancelledRefundNoteIds: ReadonlySet<string>,
): boolean {
  return payment.source === "INTERNET_BANKING" && livePerRefundNoteLinks(links, cancelledRefundNoteIds).length > 0;
}

const NOTES_DISAGREE_SUMMARY =
  "The payment's live refund credit notes together do not match the local cash refund. Check each note in Xero before changing any of them.";
const COVERAGE_UNREADABLE_SUMMARY =
  "The payment's live refund credit notes could not be totalled to compare with the local cash refund. Check each note in Xero before changing any of them.";

/**
 * Compares the local cash refund (`getCashCancellationRefundCandidateCents`)
 * with the payment's refund notes. A bank payment with a canonical note and at
 * least one other live note is judged by the notes' combined coverage
 * (`refundNoteCoveredCents`, the gap reader's sum); any disagreement, or a
 * coverage that could not be read, is one manual-review finding and never a
 * resize of one note. Every other payment keeps the canonical note's check.
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

  const coveredCents = typeof context.refundNoteCoveredCents === "number" ? context.refundNoteCoveredCents : null;
  if (coveredCents === refundAmountCents) return;

  const summary = coveredCents === null ? COVERAGE_UNREADABLE_SUMMARY : NOTES_DISAGREE_SUMMARY;
  const action = addAction(actionMap, buildManualReviewAction(booking.id, summary));
  addFinding(findings, {
    code: "XERO_AMOUNT_MISMATCH",
    severity: "manual_review",
    summary,
    safeToAutoApply: false,
    details: {
      paymentId: payment.id,
      expectedAmountCents: refundAmountCents,
      coveredCents,
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
