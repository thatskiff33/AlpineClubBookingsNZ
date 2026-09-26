/**
 * Read-only audit for Internet-Banking hold-expiry invoice-clearing that was
 * under-sized before #1597.
 *
 * Before #1597, `releaseOneHold` (internet-banking-payment-cron.ts) sized the
 * invoice-clearing credit note at `payment.amountCents` — the credit-REDUCED
 * effectivePriceCents — while the booking invoice is raised at the FULL
 * finalPriceCents. Where a released hold carried an issued invoice AND applied
 * credit, the invoice was left open by exactly the applied-credit slice.
 *
 * Every hold is judged against the INV-PAY-017 formula the release uses today,
 * and against what was ACTUALLY enqueued for it, read from the operation row the
 * release wrote rather than assumed. Two note shapes exist (#3535): a hold
 * released since #3535 carries the booking-anchored clearing note allocated to
 * the invoice (`MODIFICATION_CREDIT_NOTE`), an older one the payment's refund
 * note (`REFUND_CREDIT_NOTE`). Only a refund note whose size nobody recorded
 * falls back to the pre-#1597 sizing, `payment.amountCents`.
 *
 * Split out of `ib-hold-clearing-audit.ts` (#3535), which keeps the #1620 and
 * card applied-credit enumerations the same script prints after this one.
 *
 * This module reports those bookings using ONLY local data (no Xero calls). It
 * never writes and never touches a live provider — the operator applies any
 * repair by hand (see docs/MAINTENANCE.md; the existing xero-booking-repair CLI
 * cannot express this remainder repair — see the note there).
 */
import { PaymentSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";
import type { ClubFormat } from "@/lib/club-format";
import { asRecord, readNumber } from "@/lib/xero-json";
import {
  XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
} from "@/lib/xero-operation-outbox-payload";

/**
 * A note raised against a released hold's invoice: the allocated clearing note
 * (#3535 onward) or the payment's refund note (before it). `amountCents` is what
 * its operation recorded, null when the note is known only from the payment's
 * link field.
 */
export interface IbHoldClearingNote {
  kind: "allocated-clearing-note" | "refund-note";
  amountCents: number | null;
  /** The operation's status (PENDING, SUCCEEDED, PARTIAL, FAILED…), or null. */
  operationStatus: string | null;
}

export interface IbHoldClearingRow {
  paymentId: string;
  bookingId: string;
  bookingStatus: string;
  /** payment.amountCents: the pre-#1597 sizing, used only for a refund note
   * whose size was never recorded. */
  paymentAmountCents: number;
  changeFeeCents: number;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  finalPriceCents: number;
  /** Applied credit already allocated to the invoice as a Xero credit note —
   * the precise allocation ledger the release reads (INV-PAY-017), positive. */
  xeroAllocatedAppliedCreditCents: number;
  clearingNotes: IbHoldClearingNote[];
}

export interface UnderClearedIbHoldFinding {
  bookingId: string;
  paymentId: string;
  bookingStatus: string;
  /** xeroInvoiceNumber when present, else the raw xeroInvoiceId. */
  invoiceRef: string;
  /** The notes raised for this hold; empty means none — the invoice may be
   * fully open. */
  clearingNotes: IbHoldClearingNote[];
  finalPriceCents: number;
  changeFeeCents: number;
  xeroAllocatedAppliedCreditCents: number;
  /** max(0, finalPrice + changeFee − Xero-allocated applied credit) — the
   * INV-PAY-017 runtime sizing. */
  expectedClearingCents: number;
  /** What the notes raised for this hold add up to. */
  enqueuedClearingCents: number;
  /** expected − enqueued; always > 0 for a finding. */
  deltaCents: number;
}

export interface IbHoldClearingAuditResult {
  scannedReleasedHolds: number;
  invoiceBearingHolds: number;
  /** Released holds with NO issued invoice (the create-time hold-slots shape).
   * Pre-#1597 these enqueued a refund note the worker could not process
   * ("No Xero invoice linked to payment"); post-fix they enqueue nothing.
   * Reported for visibility, not as under-cleared invoices. */
  noInvoiceReleasedHolds: number;
  underCleared: UnderClearedIbHoldFinding[];
  totalDeltaCents: number;
}

/**
 * Pure per-row sizing, mirroring the INV-PAY-017 runtime formula exactly.
 * Returns a finding only for a hold that carried an issued invoice and whose
 * clearing notes add up to less than it (delta > 0); otherwise null.
 */
export function deriveIbHoldClearingFinding(
  row: IbHoldClearingRow,
): UnderClearedIbHoldFinding | null {
  // No issued invoice: nothing was (or should be) cleared. Surfaced separately.
  if (!row.xeroInvoiceId) {
    return null;
  }

  const xeroAllocatedAppliedCreditCents = Math.max(
    0,
    row.xeroAllocatedAppliedCreditCents,
  );
  const expectedClearingCents = Math.max(
    0,
    row.finalPriceCents + row.changeFeeCents - xeroAllocatedAppliedCreditCents,
  );
  const enqueuedClearingCents = row.clearingNotes.reduce(
    (sum, note) => sum + (note.amountCents ?? row.paymentAmountCents),
    0,
  );
  const deltaCents = expectedClearingCents - enqueuedClearingCents;
  if (deltaCents <= 0) {
    return null;
  }

  return {
    bookingId: row.bookingId,
    paymentId: row.paymentId,
    bookingStatus: row.bookingStatus,
    invoiceRef: row.xeroInvoiceNumber ?? row.xeroInvoiceId,
    clearingNotes: row.clearingNotes,
    finalPriceCents: row.finalPriceCents,
    changeFeeCents: row.changeFeeCents,
    xeroAllocatedAppliedCreditCents,
    expectedClearingCents,
    enqueuedClearingCents,
    deltaCents,
  };
}

/**
 * The size an operation recorded: the queued payload's `refundAmountCents`
 * (both shapes; the clearing note keeps it after execution), else an executed
 * refund note's `allocation.amount`, in dollars.
 */
function recordedClearingCents(requestPayload: unknown): number | null {
  const payload = asRecord(requestPayload);
  const queued = readNumber(payload?.refundAmountCents);
  if (queued !== null) return queued;
  const dollars = readNumber(asRecord(payload?.allocation)?.amount);
  return dollars === null ? null : Math.round(dollars * 100);
}

/**
 * The notes raised against one released hold, from its operations newest first:
 * the newest per shape. A refund note known only from
 * `payment.xeroRefundCreditNoteId` (no operation row) is kept, size unknown.
 */
export function resolveIbHoldClearingNotes(input: {
  operations: Array<{ localModel: string | null; status: string; requestPayload: unknown }>;
  xeroRefundCreditNoteId: string | null;
}): IbHoldClearingNote[] {
  const notes: IbHoldClearingNote[] = [];
  const clearing = input.operations.find((op) => op.localModel === "Booking");
  if (clearing) {
    notes.push({
      kind: "allocated-clearing-note",
      amountCents: recordedClearingCents(clearing.requestPayload),
      operationStatus: clearing.status,
    });
  }
  const refund = input.operations.find((op) => op.localModel === "Payment");
  if (refund) {
    notes.push({
      kind: "refund-note",
      amountCents: recordedClearingCents(refund.requestPayload),
      operationStatus: refund.status,
    });
  } else if (input.xeroRefundCreditNoteId) {
    notes.push({ kind: "refund-note", amountCents: null, operationStatus: null });
  }
  return notes;
}

/**
 * Scan every released Internet-Banking hold and report the ones whose
 * invoice-clearing note was under-sized. Read-only: it issues only SELECTs.
 */
export async function auditIbHoldClearingUnderclears(options?: {
  db?: typeof prisma;
}): Promise<IbHoldClearingAuditResult> {
  const db = options?.db ?? prisma;

  const released = await db.payment.findMany({
    where: {
      source: PaymentSource.INTERNET_BANKING,
      internetBankingHoldSlots: true,
      internetBankingHoldReleasedAt: { not: null },
    },
    select: {
      id: true,
      bookingId: true,
      amountCents: true,
      changeFeeCents: true,
      xeroInvoiceId: true,
      xeroInvoiceNumber: true,
      xeroRefundCreditNoteId: true,
      booking: { select: { finalPriceCents: true, status: true } },
    },
    orderBy: { internetBankingHoldReleasedAt: "asc" },
  });

  const result: IbHoldClearingAuditResult = {
    scannedReleasedHolds: released.length,
    invoiceBearingHolds: 0,
    noInvoiceReleasedHolds: 0,
    underCleared: [],
    totalDeltaCents: 0,
  };

  for (const payment of released) {
    if (!payment.xeroInvoiceId) {
      result.noInvoiceReleasedHolds += 1;
      continue;
    }
    result.invoiceBearingHolds += 1;

    // The ledger the release itself reads (INV-PAY-017): precise allocation
    // slices, not the MemberCredit note stamp, which survives a partial
    // deallocation and so misstates the clearing amount.
    const allocated = await db.memberCreditNoteAllocation.aggregate({
      where: { appliedToBookingId: payment.bookingId },
      _sum: { amountCents: true },
    });
    const operations = await db.xeroSyncOperation.findMany({
      where: {
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        OR: [
          {
            localModel: "Booking",
            localId: payment.bookingId,
            queueType: XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
          },
          {
            localModel: "Payment",
            localId: payment.id,
            queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
          },
        ],
      },
      select: { localModel: true, status: true, requestPayload: true },
      orderBy: { createdAt: "desc" },
    });

    const finding = deriveIbHoldClearingFinding({
      paymentId: payment.id,
      bookingId: payment.bookingId,
      bookingStatus: payment.booking.status,
      paymentAmountCents: payment.amountCents,
      changeFeeCents: payment.changeFeeCents,
      xeroInvoiceId: payment.xeroInvoiceId,
      xeroInvoiceNumber: payment.xeroInvoiceNumber,
      finalPriceCents: payment.booking.finalPriceCents,
      xeroAllocatedAppliedCreditCents: allocated._sum.amountCents ?? 0,
      clearingNotes: resolveIbHoldClearingNotes({
        operations,
        xeroRefundCreditNoteId: payment.xeroRefundCreditNoteId,
      }),
    });

    if (finding) {
      result.underCleared.push(finding);
      result.totalDeltaCents += finding.deltaCents;
    }
  }

  return result;
}

const CLEARING_NOTE_LABEL: Record<IbHoldClearingNote["kind"], string> = {
  "allocated-clearing-note": "allocated clearing note (#3535)",
  "refund-note": "refund note (before #3535)",
};

function describeClearingNotes(notes: IbHoldClearingNote[], format: ClubFormat): string {
  if (notes.length === 0) return "none - the invoice may be fully open";
  return notes
    .map((note) => {
      const size =
        note.amountCents === null
          ? "size not recorded, assumed the pre-#1597 payment amount"
          : formatCents(note.amountCents, format);
      const status = note.operationStatus ? `, ${note.operationStatus}` : "";
      return `${CLEARING_NOTE_LABEL[note.kind]} (${size}${status})`;
    })
    .join("; ");
}

export function formatIbHoldClearingAuditReport(
  result: IbHoldClearingAuditResult,
  format: ClubFormat,
): string {
  const lines: string[] = [];
  lines.push("Internet-Banking hold-expiry invoice-clearing audit (#1597)");
  lines.push("REPORT ONLY — no changes were made and no provider was called.");
  lines.push("");
  lines.push(`Released holds scanned:        ${result.scannedReleasedHolds}`);
  lines.push(`  with an issued invoice:      ${result.invoiceBearingHolds}`);
  lines.push(`  with no invoice (skipped):   ${result.noInvoiceReleasedHolds}`);
  lines.push(`Under-cleared invoices found:  ${result.underCleared.length}`);
  lines.push(`Total open delta:              ${formatCents(result.totalDeltaCents, format)}`);
  lines.push("");

  if (result.underCleared.length === 0) {
    lines.push("No under-cleared invoices. Nothing to repair.");
    return lines.join("\n");
  }

  lines.push(
    "Each row's invoice was cleared by less than its true outstanding. The",
  );
  lines.push(
    "operator must issue a supplementary clearing credit note for exactly the",
  );
  lines.push(
    "delta by hand (see docs/MAINTENANCE.md) — do NOT run xero-booking-repair",
  );
  lines.push(
    "--apply on these: it would size a FULL clearing note and over-allocate.",
  );
  lines.push("");

  for (const finding of result.underCleared) {
    lines.push(`- booking ${finding.bookingId} (payment ${finding.paymentId})`);
    lines.push(`    booking status:   ${finding.bookingStatus}`);
    lines.push(`    invoice:          ${finding.invoiceRef}`);
    lines.push(`    clearing notes:   ${describeClearingNotes(finding.clearingNotes, format)}`);
    lines.push(`    final price:      ${formatCents(finding.finalPriceCents, format)}`);
    lines.push(`    change fee:       ${formatCents(finding.changeFeeCents, format)}`);
    lines.push(
      `    Xero-allocated credit: ${formatCents(finding.xeroAllocatedAppliedCreditCents, format)}`,
    );
    lines.push(`    expected clearing: ${formatCents(finding.expectedClearingCents, format)}`);
    lines.push(`    actual clearing:   ${formatCents(finding.enqueuedClearingCents, format)}`);
    lines.push(`    OPEN DELTA:        ${formatCents(finding.deltaCents, format)}`);
  }

  return lines.join("\n");
}
