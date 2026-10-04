// Which Xero credit-note statuses still count as refund coverage, and how a
// link's recorded status is read. ONE home, by design (#2901 review): every
// refund valuation — the inbound contribution math, the coverage sum behind
// the outbox enqueue/executor and the daily self-heal, canonical link cleanup,
// the drift report, and the operator repair — answers "does this note still
// count?" through these helpers, so no path can treat a VOIDED note as live
// coverage while its siblings do not. A pure leaf: import it from anywhere.
import type { Prisma } from "@prisma/client";
import { asRecord, readString } from "@/lib/xero-json";

/**
 * True when a Xero credit-note status still contributes to refund coverage.
 * Unknown shapes (missing/non-string status) COUNT — outbound-created links
 * carry no status until inbound reconciliation or the operator status
 * recorder merges one, and their notes are live. Only an explicit
 * VOIDED/DELETED is excluded. Note the assumption this bakes in: a
 * non-cancelled recorded status (DRAFT, SUBMITTED, PAID, ...) counts as live
 * coverage. That is safe because the system only ever creates AUTHORISED
 * refund credit notes; a hand-crafted DRAFT note linked as refund coverage
 * would count here before it credits anything in Xero (#2901 stated limit).
 */
export function isIncludedRefundCreditNoteStatus(status: unknown) {
  if (typeof status !== "string") {
    return true;
  }

  const normalized = status.trim().toUpperCase();
  return normalized !== "VOIDED" && normalized !== "DELETED";
}

/** The link's recorded Xero status (uppercased), or null when never recorded. */
export function readRefundCreditNoteLinkStatus(metadata: unknown): string | null {
  const record = asRecord(metadata);
  const status = record ? readString(record.status) : null;
  return status ? status.trim().toUpperCase() : null;
}

/**
 * True when the link's recorded status says the Xero document was cancelled
 * (VOIDED/DELETED). False when no status was ever recorded — callers that
 * need "positively known live" must check `readRefundCreditNoteLinkStatus`
 * for null themselves.
 */
export function isRefundCreditNoteLinkCancelledInXero(metadata: unknown): boolean {
  const status = readRefundCreditNoteLinkStatus(metadata);
  return status !== null && !isIncludedRefundCreditNoteStatus(status);
}

/**
 * #3880: a refund note raised PER REFUND on a non-Stripe payment - a review's
 * bank-transfer hand-back on a cancelled booking, sized as a delta
 * (`createXeroCreditNote` stamps `perDelta` on its link). Like a Stripe delta
 * (#1162) it stays active beside its siblings, so coverage totals all of them,
 * and it is never the payment's ONE canonical note that its single-refund
 * callers (hold expiry, group cancel, a cancellation hand-back) dedupe on.
 */
export function isPerDeltaRefundNoteLink(metadata: unknown): boolean {
  return asRecord(metadata)?.perDelta === true;
}

/** #3880: the payment's per-refund notes, active or not, read on the caller's client. */
export async function perDeltaRefundNoteIds(paymentId: string, db: Prisma.TransactionClient): Promise<Set<string>> {
  const links = await db.xeroObjectLink.findMany({
    where: { localModel: "Payment", localId: paymentId, xeroObjectType: "CREDIT_NOTE", role: "REFUND_CREDIT_NOTE" },
    select: { xeroObjectId: true, metadata: true },
  });
  return new Set((links ?? []).filter((link) => isPerDeltaRefundNoteLink(link.metadata)).map((link) => link.xeroObjectId));
}
