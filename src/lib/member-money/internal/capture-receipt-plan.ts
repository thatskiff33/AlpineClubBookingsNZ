import type { MemberMoneyExportConflictReason } from "@prisma/client";
import { CAPTURE_KIND_RECEIPTS } from "../../booking-ledger-capture-kinds";
import { sanitizeForJson } from "../../xero-sync";
import { stableDigest } from "../../stable-digest";
import { memberMoneyEventKeys } from "./keys";

/**
 * A CAPTURE RECEIPT, PLANNED FROM THE JOURNAL (#4525, Ledger M13).
 * Pure: no database, clock, settings or provider. A capture sender (the
 * primary invoice's Stripe payment, a change capture's receipt legs, a
 * supplementary invoice's payment, a kept late capture's payment, a PARTIAL
 * repair) has just stored a Xero payment of some cents of one card capture.
 * This says whether the journal's receipt of that capture can cover those
 * cents, and the export manifest records the answer under the payment's own
 * idempotency key. The sender sent its own amount either way.
 *
 * The capture's live cash is its R06 receipt's STRIPE_CLEARING debit, under
 * `memberMoneyEventKeys.capture` - that leg names no charge, so no charge
 * component is read. Receipts already recorded for the capture under other
 * keys have used some of it; what is left must hold this payment's cents, or
 * the payment is `CAPTURE_CENTS` and covers nothing. A payment that names no
 * capture, or whose capture has no live receipt, is `CAPTURE_NOT_JOURNALLED`.
 * The unsent rest of a capture is never coverage.
 */

/** The cash account a card capture's receipt debits, and so the account a capture receipt covers. */
export const CAPTURE_RECEIPT_ACCOUNT = CAPTURE_KIND_RECEIPTS.CARD_CAPTURE.cash;

export interface CaptureReceiptPlanInput {
  /** The card capture the payment records, or null when the sender cannot name one. */
  paymentIntentId: string | null;
  /** The Xero payment's idempotency key: the manifest's legacy key and the coverage row's `sliceKey`. */
  paymentKey: string;
  /** The cents the stored Xero payment sent. */
  amountCents: number;
  invoiceId: string;
  reference: string;
  /** The bank account code the payment was sent to, or null when this path cannot name it. */
  bankCode: string | null;
  /** The capture's live receipt cash debit in cents, or null when the journal holds none. */
  captureDebitCents: number | null;
  /** Cents of this capture other receipts' manifests already cover. */
  alreadyCoveredCents: number;
}

export interface CaptureReceiptCoverage {
  account: typeof CAPTURE_RECEIPT_ACCOUNT;
  chargeIdentity: string;
  coveredCents: number;
  taxCode: null;
  /** The payment's idempotency key: its slice of the capture. */
  sliceKey: string;
}

interface CaptureReceiptRendering {
  legacyKey: string;
  payloadHash: string;
  frozenMapping: Record<string, unknown>;
  lineTotalCents: number;
}

export type CaptureReceiptPlan =
  | (CaptureReceiptRendering & { outcome: "COVERED"; coverage: [CaptureReceiptCoverage] })
  | (CaptureReceiptRendering & { outcome: "CONFLICT"; reason: Extract<MemberMoneyExportConflictReason, "CAPTURE_CENTS" | "CAPTURE_NOT_JOURNALLED">; problem: string });

/** What a payment hashes to: what it sent, never the date it was sent on. */
export function captureReceiptPayloadHash(input: Pick<CaptureReceiptPlanInput, "amountCents" | "invoiceId" | "reference" | "bankCode" | "paymentKey">): string {
  return stableDigest(sanitizeForJson({
    amountCents: input.amountCents,
    invoiceId: input.invoiceId,
    reference: input.reference,
    bankCode: input.bankCode,
    paymentKey: input.paymentKey,
  }));
}

export function planCaptureReceipt(input: CaptureReceiptPlanInput): CaptureReceiptPlan {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new RangeError("a capture receipt records a positive whole number of cents");
  }
  const rendering = {
    legacyKey: input.paymentKey,
    payloadHash: captureReceiptPayloadHash(input),
    frozenMapping: {
      paymentIntentId: input.paymentIntentId,
      invoiceId: input.invoiceId,
      reference: input.reference,
      bankCode: input.bankCode,
      account: CAPTURE_RECEIPT_ACCOUNT,
    },
  };
  const conflict = (reason: "CAPTURE_CENTS" | "CAPTURE_NOT_JOURNALLED", problem: string): CaptureReceiptPlan =>
    ({ ...rendering, lineTotalCents: 0, outcome: "CONFLICT", reason, problem });
  if (!input.paymentIntentId) return conflict("CAPTURE_NOT_JOURNALLED", "the payment names no one card capture");
  if (input.captureDebitCents === null) return conflict("CAPTURE_NOT_JOURNALLED", "the journal holds no live receipt for the capture");
  if (input.amountCents > input.captureDebitCents - input.alreadyCoveredCents) {
    return conflict("CAPTURE_CENTS", "the payment exceeds what is left of the capture's receipt");
  }
  return {
    ...rendering,
    lineTotalCents: input.amountCents,
    outcome: "COVERED",
    coverage: [{
      account: CAPTURE_RECEIPT_ACCOUNT,
      chargeIdentity: memberMoneyEventKeys.capture(input.paymentIntentId),
      coveredCents: input.amountCents,
      taxCode: null,
      sliceKey: input.paymentKey,
    }],
  };
}
