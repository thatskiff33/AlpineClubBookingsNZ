import { type CreditNote as XeroCreditNote, type Payment as XeroPayment } from "xero-node";
import { PaymentStatus } from "@prisma/client";
import { buildXeroIdempotencyKey } from "@/lib/xero-sync";
import { isIncludedRefundCreditNoteStatus } from "@/lib/xero-refund-note-status";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { type AccountCreditAllocationTarget, type CreditNoteAmounts } from "./types";
import { isDeletedXeroPaymentStatus } from "./object-links";

/**
 * #4531 (`INV-SSOT`): the cash of a document's listed payments in integer
 * cents, DELETED (reversed) ones skipped; `complete` is false when a counted
 * payment's amount is unreadable. The one reading of that sum: the invoice cash
 * quantifier and the deleted-payment trust check both use it.
 */
export function sumListedXeroPaymentCents(
  payments: ReadonlyArray<{ amount?: unknown; status?: unknown }>,
): { cents: number; complete: boolean } {
  let cents = 0;
  let complete = true;
  for (const payment of payments) {
    if (isDeletedXeroPaymentStatus(payment.status)) continue;
    const paymentCents = providerAmountToCents(payment.amount);
    if (paymentCents === null) complete = false;
    else cents += paymentCents;
  }
  return { cents, complete };
}

export function buildSyntheticAllocationLinkId(
  creditNoteId: string,
  invoiceId: string,
  amountCents: number
): string {
  return buildXeroIdempotencyKey(
    "allocation",
    creditNoteId,
    invoiceId,
    amountCents,
    "v1"
  );
}

function getPositiveCurrencyAmountCents(value: number | null | undefined): number | null {
  // THE POSITIVITY TEST STAYS ON THE DOLLARS, ahead of the conversion, exactly
  // where it was — this is a frozen behaviour, not a preference (#2685).
  //
  // What that ordering actually does, stated the right way round: a positive
  // sub-cent amount such as 0.001 PASSES this test and converts to `0` cents,
  // because 0.001 > 0 and `Math.round(0.1)` is 0. Testing the ROUNDED cents
  // instead (`cents <= 0`) would reject it. So the two orderings differ, this
  // one is the more permissive of them, and it is the one every call site this
  // helper replaced already used. Swapping them would change what a Xero credit
  // note is worth, which is a money-behaviour decision for the owner rather
  // than something to tidy up in a refactor.
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return providerAmountToCents(value);
}

export function getCreditNoteAmountCents(
  creditNote: CreditNoteAmounts
): number | null {
  const totalAmountCents = getPositiveCurrencyAmountCents(creditNote.total);
  if (totalAmountCents !== null) {
    return totalAmountCents;
  }

  const appliedAmount = creditNote.appliedAmount ?? 0;
  const remainingAmount = creditNote.remainingCredit ?? 0;
  return getPositiveCurrencyAmountCents(appliedAmount + remainingAmount);
}

export function getJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

export function getCreditNoteIdFromAllocationMetadata(metadata: unknown): string | null {
  const record = getJsonRecord(metadata);
  const creditNoteId = record?.creditNoteId;
  return typeof creditNoteId === "string" && creditNoteId.trim().length > 0
    ? creditNoteId
    : null;
}

export function getAmountCentsFromAllocationMetadata(metadata: unknown): number | null {
  const record = getJsonRecord(metadata);
  const amountCents = record?.amountCents;

  if (typeof amountCents !== "number" || !Number.isFinite(amountCents) || amountCents <= 0) {
    return null;
  }

  return Math.round(amountCents);
}

/** One application of a credit note: cents it applied, and which allocation that is when known. */
export type CreditNoteAllocationCents = {
  creditNoteId: string;
  appliedCents: number;
  /**
   * The allocation's identity within its note, when the caller may hold the
   * same allocation more than once (the recount's links: one per local object,
   * and a stale one beside a re-synced one). Entries sharing it are one
   * allocation and the last given counts. Without it each entry counts.
   */
  allocationKey?: string;
};

/**
 * #4095 (`INV-PAY-126`, `INV-SSOT`): each credit note's applied cents, summed
 * across its allocations - a note applied as $60 and $40 counts $100. The one
 * per-note rule the kept settle (`decideInternetBankingReceiptFigure`) and the
 * refunded-total recount (`repairRefundedPaymentBusinessState`) both apply.
 */
export function sumAppliedCentsByCreditNote(
  allocations: Iterable<CreditNoteAllocationCents>,
): Map<string, number> {
  const keyed = new Map<string, CreditNoteAllocationCents>();
  const unkeyed: CreditNoteAllocationCents[] = [];
  for (const allocation of allocations) {
    if (allocation.allocationKey === undefined) unkeyed.push(allocation);
    else keyed.set(JSON.stringify([allocation.creditNoteId, allocation.allocationKey]), allocation);
  }
  const totals = new Map<string, number>();
  for (const allocation of [...unkeyed, ...keyed.values()]) {
    totals.set(allocation.creditNoteId, (totals.get(allocation.creditNoteId) ?? 0) + allocation.appliedCents);
  }
  return totals;
}

export function getRefundContributionCentsFromCreditNoteMetadata(
  metadata: unknown
): number | null {
  const record = getJsonRecord(metadata);
  if (!record || !isIncludedRefundCreditNoteStatus(record.status)) {
    return null;
  }

  return getCreditNoteAmountCents({
    total: typeof record.total === "number" ? record.total : null,
    appliedAmount:
      typeof record.appliedAmount === "number" ? record.appliedAmount : null,
    remainingCredit:
      typeof record.remainingCredit === "number" ? record.remainingCredit : null,
  });
}

export function getNextRefundedPaymentStatus(
  currentStatus: string,
  amountCents: number,
  refundedAmountCents: number
): PaymentStatus | null {
  if (refundedAmountCents <= 0) {
    return currentStatus === PaymentStatus.REFUNDED ||
      currentStatus === PaymentStatus.PARTIALLY_REFUNDED
      ? PaymentStatus.SUCCEEDED
      : null;
  }

  return refundedAmountCents >= amountCents
    ? PaymentStatus.REFUNDED
    : PaymentStatus.PARTIALLY_REFUNDED;
}

export function buildXeroPaymentDisplayNumber(payment: XeroPayment): string | null {
  return payment.invoiceNumber ?? payment.creditNoteNumber ?? null;
}

export function buildBookingAppliedCreditDescription(bookingId: string) {
  return `Applied to booking ${bookingId.slice(0, 8)}`;
}

export function buildCreditNoteAllocationTargets(
  creditNote: Pick<XeroCreditNote, "allocations">
): AccountCreditAllocationTarget[] {
  const allocationTotals = new Map<string, number>();

  for (const allocation of creditNote.allocations ?? []) {
    const invoiceId = allocation.invoice?.invoiceID ?? null;
    const amount = allocation.amount;

    // Same ordering point as above, and the same correction: a NON-POSITIVE
    // allocation is dropped here on the dollars. A positive SUB-cent allocation
    // is not — it passes this test and rounds to `0`, and what removes it is the
    // `amountCents > 0` filter on the way out, after the per-invoice totals have
    // been summed. That ordering matters and is deliberate: two 0.006 allocations
    // against the same invoice each round to 1 cent and total 2, which is what
    // the code this replaced did (#2685).
    if (!invoiceId || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      continue;
    }

    // UNREACHABLE, and kept anyway. The guard above has already proved `amount`
    // is a finite `number`, which is the whole of `providerAmountToCents`'s
    // validity contract, so this branch cannot be taken at runtime. It stays
    // because the helper's return type is `number | null` and this boundary
    // must stay fail-closed by construction: if that contract is ever widened,
    // an unreadable allocation is dropped rather than added to a total as
    // `null` (#2685 review).
    const amountCents = providerAmountToCents(amount);
    if (amountCents === null) {
      continue;
    }

    allocationTotals.set(
      invoiceId,
      (allocationTotals.get(invoiceId) ?? 0) + amountCents
    );
  }

  return Array.from(allocationTotals.entries())
    .map(([invoiceId, amountCents]) => ({
      invoiceId,
      amountCents,
    }))
    .filter((target) => target.amountCents > 0);
}
