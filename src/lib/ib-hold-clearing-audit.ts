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
 * This module reports those bookings using ONLY local data (no Xero calls). It
 * never writes and never touches a live provider — the operator applies any
 * repair by hand (see docs/MAINTENANCE.md; the existing xero-booking-repair CLI
 * cannot express this remainder repair — see the note there).
 */
import {
  BookingStatus,
  CreditType,
  PaymentSource,
  PaymentStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";
import { isAdditionalAmountUncollected } from "@/lib/unpaid-finished-stays";
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

// ---------------------------------------------------------------------------
// #1620 — Internet-Banking + applied-credit strand enumeration (read-only)
// ---------------------------------------------------------------------------
//
// Distinct from the #1597 hold-clearing audit above. The booking invoice is
// raised at the FULL finalPrice and locally-applied member credit is never
// allocated against it (INV-PAY-017, "locally-applied credit
// never reduced the invoice"). So every Internet-Banking payment carrying
// applied credit is exposed: a member who pays that full invoice loses the
// applied-credit slice (realized double-pay); one who has not yet paid is still
// exposed (recoverable). This enumeration sizes that population.
//
// CANCELLED bookings are intentionally EXCLUDED — their applied credit is the
// #1547 domain (restored on cancel; orphans surfaced by
// cron-credit-reconciliation + backfill-orphaned-applied-credits). This targets
// the never-cancelled PAID (realized) and PAYMENT_PENDING (not-yet-realized)
// shapes. Read-only: local SELECTs only, no Xero calls.
//
// Load-bearing invariant that lets the scan use Σ BOOKING_APPLIED directly (no
// restore subtraction): EVERY path that writes a CANCELLATION_REFUND restore row
// against a booking also sets that booking to CANCELLED — every `cancelBooking`
// branch, the IB hold-expiry release (`internet-banking-payment-cron.ts`
// `releaseOneHold` sets `status: CANCELLED`), and the capacity-failed
// system-void. So a NON-cancelled booking never carries a restore row, and its
// Σ BOOKING_APPLIED is the true unrestored applied credit. (Booking
// modifications mint BOOKING_MODIFICATION_REFUND rows; they never reverse a
// BOOKING_APPLIED row, so they do not perturb this sum.)

export interface IbAppliedCreditStrandRow {
  paymentId: string;
  bookingId: string;
  bookingStatus: string;
  paymentStatus: string;
  /** payment.amountCents mirror. */
  amountCents: number;
  /** payment.creditAppliedCents mirror (0 on a card-origin switched payment,
   * even though the ledger consumed credit — the §4 staleness). */
  creditAppliedCents: number;
  finalPriceCents: number;
  /** |Σ BOOKING_APPLIED(appliedToBookingId=booking)| — the ledger truth, stored
   * negative and negated here to a positive applied total. */
  ledgerAppliedCents: number;
  /**
   * #2397: the payment's upward-modification delta and whether it was ever
   * collected — the third term of the generalised mirror, so a negative
   * `mirrorInvariantDeltaCents` can be told apart from real drift.
   */
  additionalAmountCents: number;
  additionalPaymentStatus: string | null;
}

export interface IbAppliedCreditStrandFinding {
  bookingId: string;
  paymentId: string;
  bookingStatus: string;
  paymentStatus: string;
  /** true once the payment captured cash: the member has already double-paid.
   * Repair is a LOCAL credit restore (a Xero credit note does not refund cash a
   * member already sent). */
  realized: boolean;
  amountCents: number;
  creditAppliedCents: number;
  finalPriceCents: number;
  ledgerAppliedCents: number;
  /** ledgerAppliedCents − creditAppliedCents; non-zero ⇒ the payment mirror is
   * stale (e.g. a switched booking whose creditAppliedCents stayed 0). */
  mirrorLedgerMismatchCents: number;
  /**
   * amountCents + creditAppliedCents − finalPriceCents; the §4 payment-mirror
   * invariant residual.
   *
   * NEGATIVE is not automatically drift. The generalised mirror is
   * `amountCents + creditAppliedCents + (uncollected addition) = finalPriceCents`,
   * so a booking carrying an uncollected upward-modification delta shows a
   * residual of exactly −(that delta) and is CORRECT. Two shapes produce it,
   * both internet-banking (this audit scans INTERNET_BANKING payments only, so
   * a card-settled booking never appears here at all):
   *
   *  * a Xero-invoiced pay-on-account booking whose later addition was invoiced
   *    but never paid; and
   *  * (#2397) a cash / off-Xero settlement where the admin said the money did
   *    NOT cover an outstanding addition, so the club deliberately recorded
   *    less than the booking's price and goes on asking for the difference.
   *
   * Check the payment's `additionalAmountCents` / `additionalPaymentStatus`
   * before treating a residual as a fault: equal-and-opposite means the books
   * are right, anything else means the mirror really is stale.
   */
  mirrorInvariantDeltaCents: number;
  /**
   * #2397: the uncollected upward-modification delta on this payment — the
   * third term above, reported alongside the residual so an operator does not
   * have to go and look it up. 0 when the payment carries no addition, or when
   * the addition was collected.
   */
  uncollectedAdditionalCents: number;
  /** Credit the member stands to lose (pending) or has lost (realized). */
  strandExposureCents: number;
}

export interface IbAppliedCreditStrandAuditResult {
  scannedInternetBankingPayments: number;
  /** Payments that captured cash while holding applied credit — double-paid. */
  realized: IbAppliedCreditStrandFinding[];
  /** Payments not yet captured — credit still recoverable before they pay. */
  pending: IbAppliedCreditStrandFinding[];
  realizedStrandedCents: number;
  pendingExposureCents: number;
}

// A payment is "realized" once cash has been captured. Internet-Banking payments
// flip to SUCCEEDED when the Xero invoice reconciles to PAID; the refunded
// variants imply an earlier capture. Everything else (PENDING / PROCESSING /
// FAILED) has not taken the member's money yet.
const REALIZED_PAYMENT_STATUSES = new Set<string>([
  "SUCCEEDED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
]);

/**
 * Pure per-row classification. Returns a finding only when the ledger shows
 * applied credit still consumed against this booking; otherwise null.
 */
export function deriveIbAppliedCreditStrandFinding(
  row: IbAppliedCreditStrandRow,
): IbAppliedCreditStrandFinding | null {
  if (row.ledgerAppliedCents <= 0) {
    return null;
  }

  return {
    bookingId: row.bookingId,
    paymentId: row.paymentId,
    bookingStatus: row.bookingStatus,
    paymentStatus: row.paymentStatus,
    realized: REALIZED_PAYMENT_STATUSES.has(row.paymentStatus),
    amountCents: row.amountCents,
    creditAppliedCents: row.creditAppliedCents,
    finalPriceCents: row.finalPriceCents,
    ledgerAppliedCents: row.ledgerAppliedCents,
    mirrorLedgerMismatchCents: row.ledgerAppliedCents - row.creditAppliedCents,
    mirrorInvariantDeltaCents:
      row.amountCents + row.creditAppliedCents - row.finalPriceCents,
    // #2397: the SHARED money-half predicate, so this report and the settle
    // that produces the residual can never disagree about what "uncollected"
    // means.
    uncollectedAdditionalCents: isAdditionalAmountUncollected(row)
      ? row.additionalAmountCents
      : 0,
    strandExposureCents: row.ledgerAppliedCents,
  };
}

/**
 * Scan every non-cancelled Internet-Banking payment and enumerate the ones
 * whose booking still carries locally-applied credit against a full invoice.
 * Read-only: it issues only SELECTs.
 */
export async function auditIbAppliedCreditStrands(options?: {
  db?: typeof prisma;
}): Promise<IbAppliedCreditStrandAuditResult> {
  const db = options?.db ?? prisma;

  const payments = await db.payment.findMany({
    where: {
      source: PaymentSource.INTERNET_BANKING,
      booking: { status: { not: BookingStatus.CANCELLED } },
    },
    select: {
      id: true,
      bookingId: true,
      amountCents: true,
      creditAppliedCents: true,
      status: true,
      // #2397: the generalised mirror's third term.
      additionalAmountCents: true,
      additionalPaymentStatus: true,
      booking: { select: { finalPriceCents: true, status: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const result: IbAppliedCreditStrandAuditResult = {
    scannedInternetBankingPayments: payments.length,
    realized: [],
    pending: [],
    realizedStrandedCents: 0,
    pendingExposureCents: 0,
  };

  for (const payment of payments) {
    const applied = await db.memberCredit.aggregate({
      where: {
        appliedToBookingId: payment.bookingId,
        type: CreditType.BOOKING_APPLIED,
        // #1620: only UN-allocated applied credit is a strand. Once the
        // allocate-existing engine reduces the invoice it stamps the
        // BOOKING_APPLIED row with the allocated note id, so a fixed booking
        // (xeroCreditNoteId set) drops out of this enumeration.
        xeroCreditNoteId: null,
      },
      _sum: { amountCents: true },
    });
    const ledgerAppliedCents = Math.max(0, -(applied._sum.amountCents ?? 0));

    const finding = deriveIbAppliedCreditStrandFinding({
      paymentId: payment.id,
      bookingId: payment.bookingId,
      bookingStatus: payment.booking.status,
      paymentStatus: payment.status,
      amountCents: payment.amountCents,
      creditAppliedCents: payment.creditAppliedCents,
      finalPriceCents: payment.booking.finalPriceCents,
      ledgerAppliedCents,
      additionalAmountCents: payment.additionalAmountCents,
      additionalPaymentStatus: payment.additionalPaymentStatus,
    });

    if (!finding) {
      continue;
    }
    if (finding.realized) {
      result.realized.push(finding);
      result.realizedStrandedCents += finding.strandExposureCents;
    } else {
      result.pending.push(finding);
      result.pendingExposureCents += finding.strandExposureCents;
    }
  }

  return result;
}

function formatIbAppliedCreditStrandRow(
  finding: IbAppliedCreditStrandFinding,
  format: ClubFormat,
): string[] {
  const lines: string[] = [];
  lines.push(`- booking ${finding.bookingId} (payment ${finding.paymentId})`);
  lines.push(`    booking status:    ${finding.bookingStatus}`);
  lines.push(`    payment status:    ${finding.paymentStatus}`);
  lines.push(`    final price:       ${formatCents(finding.finalPriceCents, format)}`);
  lines.push(`    amountCents:       ${formatCents(finding.amountCents, format)}`);
  lines.push(`    creditApplied (mirror): ${formatCents(finding.creditAppliedCents, format)}`);
  lines.push(`    applied (ledger):  ${formatCents(finding.ledgerAppliedCents, format)}`);
  lines.push(`    mirror vs ledger:  ${formatCents(finding.mirrorLedgerMismatchCents, format)}`);
  lines.push(`    mirror invariant delta: ${formatCents(finding.mirrorInvariantDeltaCents, format)}`);
  // #2397: name the legitimate cause of a negative residual on the same row,
  // so an operator never has to guess whether it is drift. When the two are
  // equal and opposite the generalised mirror holds and there is nothing to
  // repair here.
  if (finding.uncollectedAdditionalCents > 0) {
    lines.push(
      `    uncollected addition: ${formatCents(finding.uncollectedAdditionalCents, format)}` +
        (finding.mirrorInvariantDeltaCents +
          finding.uncollectedAdditionalCents ===
        0
          ? "  (accounts for the delta above — mirror OK)"
          : "  (does NOT fully account for the delta above)"),
    );
  }
  lines.push(`    STRAND EXPOSURE:   ${formatCents(finding.strandExposureCents, format)}`);
  return lines;
}

export function formatIbAppliedCreditStrandReport(
  result: IbAppliedCreditStrandAuditResult,
  format: ClubFormat,
): string {
  const lines: string[] = [];
  lines.push("Internet-Banking + applied-credit strand enumeration (#1620)");
  lines.push("REPORT ONLY — no changes were made and no provider was called.");
  lines.push("CANCELLED bookings are excluded (the #1547 restore domain).");
  lines.push("");
  lines.push(
    `IB payments scanned (non-cancelled):   ${result.scannedInternetBankingPayments}`,
  );
  lines.push(
    `REALIZED strands (member double-paid): ${result.realized.length}`,
  );
  lines.push(
    `  credit already lost:                 ${formatCents(result.realizedStrandedCents, format)}`,
  );
  lines.push(
    `PENDING strands (not yet paid):        ${result.pending.length}`,
  );
  lines.push(
    `  credit at risk:                      ${formatCents(result.pendingExposureCents, format)}`,
  );
  lines.push("");

  if (result.realized.length === 0 && result.pending.length === 0) {
    lines.push("No Internet-Banking payment carries applied credit. Nothing to size.");
    return lines.join("\n");
  }

  if (result.realized.length > 0) {
    lines.push(
      "REALIZED — the member already paid the FULL invoice by bank transfer while",
    );
    lines.push(
      "the applied credit was consumed. Repair is a LOCAL credit restore for the",
    );
    lines.push(
      "strand exposure (a Xero credit note does not refund cash already sent).",
    );
    lines.push("");
    for (const finding of result.realized) {
      lines.push(...formatIbAppliedCreditStrandRow(finding, format));
    }
    lines.push("");
  }

  if (result.pending.length > 0) {
    lines.push(
      "PENDING — not yet captured. These are fixed forward by the chosen #1620",
    );
    lines.push(
      "remedy (reduce the outstanding invoice to effective, or restore + re-bill)",
    );
    lines.push("before the member pays; no realized loss yet.");
    lines.push("");
    for (const finding of result.pending) {
      lines.push(...formatIbAppliedCreditStrandRow(finding, format));
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// #1641 — CARD double-pay enumeration (the sibling of the IB strand above)
// ---------------------------------------------------------------------------
//
// Before #1641, a member who applied account credit to a CARD booking had the
// credit consumed at booking-create while the Stripe intent was minted at the FULL
// finalPriceCents — so a captured card payment double-charged the member by exactly
// the applied slice (see the #1641 verification report). Unlike the IB strand,
// every card finding here is REALIZED: a card payment only reaches SUCCEEDED once
// Stripe captured the cash, so the money has already moved and the repair is a
// LOCAL credit restore (a Xero credit note cannot refund cash already sent).
//
// Fingerprint of a realized card double-pay:
//   - payment.source != INTERNET_BANKING       (card / Stripe path)
//   - payment.status  == SUCCEEDED             (cash captured)
//   - payment.creditAppliedCents == 0          (mirror never credit-reduced — the
//                                               pre-fix shape; a fixed booking has
//                                               creditAppliedCents = applied > 0)
//   - payment.amountCents == booking.finalPriceCents  (charged the FULL price — a
//                                               fixed booking is charged effective)
//   - Σ UN-allocated BOOKING_APPLIED > 0       (credit consumed and never allocated;
//                                               a fixed booking's rows are stamped)
//   - booking.status != CANCELLED              (CANCELLED applied credit is the
//                                               #1547 restore domain, excluded)
//
// A booking fixed by #1641 fails EVERY discriminating clause (positive mirror,
// effective amount, stamped/zero unallocated ledger), so fixed rows never appear.
// Read-only: local SELECTs only, no Xero calls.

export interface CardAppliedCreditDoublePayRow {
  paymentId: string;
  bookingId: string;
  bookingStatus: string;
  paymentStatus: string;
  paymentSource: string;
  /** payment.amountCents mirror (full finalPriceCents on a pre-fix double-pay). */
  amountCents: number;
  /** payment.creditAppliedCents mirror (0 on a pre-fix double-pay). */
  creditAppliedCents: number;
  finalPriceCents: number;
  /** |Σ UN-allocated BOOKING_APPLIED(appliedToBookingId=booking)| — ledger truth. */
  ledgerAppliedCents: number;
}

export interface CardAppliedCreditDoublePayFinding {
  bookingId: string;
  paymentId: string;
  bookingStatus: string;
  paymentStatus: string;
  paymentSource: string;
  amountCents: number;
  creditAppliedCents: number;
  finalPriceCents: number;
  ledgerAppliedCents: number;
  /** Credit the member already lost — the local restore amount. */
  strandExposureCents: number;
}

export interface CardAppliedCreditDoublePayAuditResult {
  scannedCardPayments: number;
  /** Captured card payments that also consumed applied credit — double-paid. */
  doublePays: CardAppliedCreditDoublePayFinding[];
  doublePaidCents: number;
}

/**
 * Pure per-row classification. Returns a finding only for the exact pre-fix
 * double-pay fingerprint (full-price capture + zero mirror + positive unallocated
 * applied ledger); otherwise null. A #1641-fixed booking fails every clause.
 */
export function deriveCardAppliedCreditDoublePayFinding(
  row: CardAppliedCreditDoublePayRow,
): CardAppliedCreditDoublePayFinding | null {
  if (row.ledgerAppliedCents <= 0) {
    return null;
  }
  if (row.creditAppliedCents !== 0) {
    return null;
  }
  if (row.amountCents !== row.finalPriceCents) {
    return null;
  }

  return {
    bookingId: row.bookingId,
    paymentId: row.paymentId,
    bookingStatus: row.bookingStatus,
    paymentStatus: row.paymentStatus,
    paymentSource: row.paymentSource,
    amountCents: row.amountCents,
    creditAppliedCents: row.creditAppliedCents,
    finalPriceCents: row.finalPriceCents,
    ledgerAppliedCents: row.ledgerAppliedCents,
    strandExposureCents: row.ledgerAppliedCents,
  };
}

/**
 * Scan every captured non-Internet-Banking (card) payment and enumerate the ones
 * whose booking still carries locally-applied credit against a full-price charge.
 * Read-only: it issues only SELECTs.
 */
export async function auditCardAppliedCreditDoublePays(options?: {
  db?: typeof prisma;
}): Promise<CardAppliedCreditDoublePayAuditResult> {
  const db = options?.db ?? prisma;

  const payments = await db.payment.findMany({
    where: {
      source: { not: PaymentSource.INTERNET_BANKING },
      status: PaymentStatus.SUCCEEDED,
      booking: { status: { not: BookingStatus.CANCELLED } },
    },
    select: {
      id: true,
      bookingId: true,
      source: true,
      amountCents: true,
      creditAppliedCents: true,
      status: true,
      booking: { select: { finalPriceCents: true, status: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const result: CardAppliedCreditDoublePayAuditResult = {
    scannedCardPayments: payments.length,
    doublePays: [],
    doublePaidCents: 0,
  };

  for (const payment of payments) {
    const applied = await db.memberCredit.aggregate({
      where: {
        appliedToBookingId: payment.bookingId,
        type: CreditType.BOOKING_APPLIED,
        // Only UN-allocated applied credit is a strand; a #1641-fixed card booking
        // has its BOOKING_APPLIED rows stamped with the allocated note id and drops
        // out here (mirrors the IB strand scan).
        xeroCreditNoteId: null,
      },
      _sum: { amountCents: true },
    });
    const ledgerAppliedCents = Math.max(0, -(applied._sum.amountCents ?? 0));

    const finding = deriveCardAppliedCreditDoublePayFinding({
      paymentId: payment.id,
      bookingId: payment.bookingId,
      bookingStatus: payment.booking.status,
      paymentStatus: payment.status,
      paymentSource: payment.source,
      amountCents: payment.amountCents,
      creditAppliedCents: payment.creditAppliedCents,
      finalPriceCents: payment.booking.finalPriceCents,
      ledgerAppliedCents,
    });

    if (!finding) {
      continue;
    }
    result.doublePays.push(finding);
    result.doublePaidCents += finding.strandExposureCents;
  }

  return result;
}

function formatCardAppliedCreditDoublePayRow(
  finding: CardAppliedCreditDoublePayFinding,
  format: ClubFormat,
): string[] {
  const lines: string[] = [];
  lines.push(`- booking ${finding.bookingId} (payment ${finding.paymentId})`);
  lines.push(`    booking status:    ${finding.bookingStatus}`);
  lines.push(`    payment source:    ${finding.paymentSource}`);
  lines.push(`    payment status:    ${finding.paymentStatus}`);
  lines.push(`    final price:       ${formatCents(finding.finalPriceCents, format)}`);
  lines.push(`    charged (card):    ${formatCents(finding.amountCents, format)}`);
  lines.push(`    creditApplied (mirror): ${formatCents(finding.creditAppliedCents, format)}`);
  lines.push(`    applied (ledger):  ${formatCents(finding.ledgerAppliedCents, format)}`);
  lines.push(`    DOUBLE-PAID (local restore): ${formatCents(finding.strandExposureCents, format)}`);
  return lines;
}

export function formatCardAppliedCreditDoublePayReport(
  result: CardAppliedCreditDoublePayAuditResult,
  format: ClubFormat,
): string {
  const lines: string[] = [];
  lines.push("Card + applied-credit double-pay enumeration (#1641)");
  lines.push("REPORT ONLY — no changes were made and no provider was called.");
  lines.push("CANCELLED bookings are excluded (the #1547 restore domain).");
  lines.push("");
  lines.push(
    `Card payments scanned (captured, non-cancelled): ${result.scannedCardPayments}`,
  );
  lines.push(
    `REALIZED double-pays (member overcharged):       ${result.doublePays.length}`,
  );
  lines.push(
    `  credit already lost:                           ${formatCents(result.doublePaidCents, format)}`,
  );
  lines.push("");

  if (result.doublePays.length === 0) {
    lines.push("No captured card payment carries unallocated applied credit. Nothing to size.");
    return lines.join("\n");
  }

  lines.push(
    "REALIZED — the member already paid the FULL price by card while the applied",
  );
  lines.push(
    "credit was consumed. Repair is a LOCAL credit restore for the strand exposure",
  );
  lines.push(
    "(a Xero credit note does not refund cash already captured). Operator-reviewed.",
  );
  lines.push("");
  for (const finding of result.doublePays) {
    lines.push(...formatCardAppliedCreditDoublePayRow(finding, format));
  }

  return lines.join("\n");
}
