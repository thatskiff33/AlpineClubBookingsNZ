/**
 * The rules a captured additional payment's Xero supplementary invoice is
 * judged by (#3641, `INV-PAY-104`): the retired-row codes, the refusals and
 * their text, and the one "does this capture cover the invoice?" check. A leaf
 * shared by the late-success release (`xero-supplementary-invoice-late-capture.ts`)
 * and the retired-row revive (`xero-supplementary-invoice-revive.ts`), so the
 * two import it rather than each other (#4930, INV-SSOT-008: no import loop).
 */
import type { PaymentStatus, Prisma } from "@prisma/client";
import { classifyEditReviewChargeCapture } from "@/lib/xero-booking-repair-payments";
import { supplementaryInvoiceBilledCents } from "@/lib/xero-operation-outbox-payload";

/**
 * The code the reaper stamps on an operation it retires, and the ONLY code the
 * late-success re-queue will revive. An operation CANCELLED for any other reason (an
 * officer withdrew the ask, the booking was settled by hand) stays retired
 * whatever happens to its PaymentIntent afterwards.
 */
export const STALE_WAITING_PAYMENT_ERROR_CODE = "STALE_WAITING_PAYMENT";

/**
 * The payment was captured and this invoice was deliberately NOT issued, and an
 * officer was told. The stamp IS the alert's claim: it is written by a
 * status-and-code guarded `updateMany`, so a replayed webhook, or the confirm
 * route racing it, finds nothing to claim and alerts nobody a second time.
 */
export const CAPTURED_NOT_ISSUED_ERROR_CODE = "STALE_WAITING_PAYMENT_CAPTURED";

/**
 * A retired invoice another operation already answers: an invoice for the same
 * payment request is on its way or sent, or a newer retired row for the same
 * change was decided instead. Terminal and never revived, so a replay, or the
 * second late-success caller, finds nothing to revive or alert about.
 */
export const COVERED_ERROR_CODE = "STALE_WAITING_PAYMENT_COVERED";

/** #4324: retired rows the release revives, has alerted on, or found covered.
 * Other CANCELLED rows were withdrawn and bill nothing. */
export const RETIRED_CODES_ANSWERING_CAPTURE = [
  STALE_WAITING_PAYMENT_ERROR_CODE,
  CAPTURED_NOT_ISSUED_ERROR_CODE,
  COVERED_ERROR_CODE,
] as const;

type CaptureRefusal = "short-of-ask" | "not-captured" | "unreadable-invoice";

export type IssueRefusal =
  | CaptureRefusal
  | "invoice-already-linked"
  | "another-invoice-queued";

export const ISSUE_REFUSAL_TEXT: Record<IssueRefusal, string> = {
  "short-of-ask":
    "the card captured less than the invoice would bill, so issuing it would record more money as received than arrived",
  "not-captured":
    "no captured payment could be found for the payment request, so issuing it would record a payment that has not been seen",
  "unreadable-invoice":
    "the queued invoice's amount could not be read, so it could not be checked against the payment",
  "invoice-already-linked":
    "this booking change already has a supplementary invoice in Xero (raised since, probably by the booking-vs-Xero repair tool), so issuing it would bill it twice",
  "another-invoice-queued":
    "another supplementary invoice for this booking change is already queued, so issuing it would bill it twice",
};

export type CapturedTransaction = { status: PaymentStatus; amountCents: number } | null;

/**
 * IS IT SAFE TO ISSUE THIS INVOICE WITH THIS CAPTURE RECORDED AS ITS PAYMENT?
 * One rule for a still-waiting invoice and a retired one (#3641 review round):
 * the worker books the invoice's own net as the Stripe receipt, so an invoice
 * billing more than was captured would book money that never arrived. The
 * repair tool asks the same `classifyEditReviewChargeCapture`. Where it is not
 * safe the invoice is not issued and an officer is told; the difference is
 * collected by hand.
 */
export function captureRefusalFor(
  transaction: CapturedTransaction,
  requestPayload: Prisma.JsonValue | null,
  /** #3403 review (M2): what the other invoices naming this capture already bill; it covers them all together. */
  alreadyBilledCents: number,
): CaptureRefusal | null {
  const billedCents = supplementaryInvoiceBilledCents(requestPayload);
  if (billedCents === null) return "unreadable-invoice";
  if (!transaction) return "not-captured";
  const capture = classifyEditReviewChargeCapture(transaction, billedCents + alreadyBilledCents);
  return capture === "covers-ask" ? null : capture;
}

/** What these invoices bill together (an unreadable one, nothing). */
export function billedByOthers(operations: ReadonlyArray<{ requestPayload: Prisma.JsonValue | null }>): number {
  return operations.reduce((total, operation) => total + (supplementaryInvoiceBilledCents(operation.requestPayload) ?? 0), 0);
}
