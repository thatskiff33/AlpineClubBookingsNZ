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
 * This module reports those bookings using ONLY local data (no Xero calls). It
 * mirrors the corrected #1597 runtime formula so the operator can reconcile the
 * expected-vs-actual clearing amounts without re-deriving anything. It never
 * writes and never touches a live provider — the operator applies any repair by
 * hand (see docs/MAINTENANCE.md; the existing xero-booking-repair CLI cannot
 * express this remainder repair — see the note there).
 */
import {
  BookingStatus,
  CreditType,
  PaymentSource,
  PaymentStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface IbHoldClearingRow {
  paymentId: string;
  bookingId: string;
  bookingStatus: string;
  /** What the pre-#1597 release sized the clearing note at (payment.amountCents,
   * frozen once the hold released, so it is the definitive local record). */
  enqueuedClearingCents: number;
  changeFeeCents: number;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  xeroRefundCreditNoteId: string | null;
  finalPriceCents: number;
  /** Sum of BOOKING_APPLIED MemberCredit rows for the booking that carry a
   * xeroCreditNoteId (stored negative; 0 when none). */
  xeroAllocatedCreditSumCents: number;
}

export interface UnderClearedIbHoldFinding {
  bookingId: string;
  paymentId: string;
  bookingStatus: string;
  /** xeroInvoiceNumber when present, else the raw xeroInvoiceId. */
  invoiceRef: string;
  /** Whether a refund credit note actually landed in Xero for the payment; a
   * false here on an under-cleared row means the invoice may be fully open. */
  refundNoteIssued: boolean;
  finalPriceCents: number;
  changeFeeCents: number;
  xeroAllocatedAppliedCreditCents: number;
  /** max(0, finalPrice + changeFee − Xero-allocated applied credit) — the #1597
   * runtime sizing. */
  expectedClearingCents: number;
  /** What the pre-fix release actually enqueued. */
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
 * Pure per-row sizing, mirroring the #1597 runtime formula exactly. Returns a
 * finding only for a hold that carried an issued invoice and whose clearing note
 * was under-sized (delta > 0); otherwise null.
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
    -row.xeroAllocatedCreditSumCents,
  );
  const expectedClearingCents = Math.max(
    0,
    row.finalPriceCents + row.changeFeeCents - xeroAllocatedAppliedCreditCents,
  );
  const deltaCents = expectedClearingCents - row.enqueuedClearingCents;
  if (deltaCents <= 0) {
    return null;
  }

  return {
    bookingId: row.bookingId,
    paymentId: row.paymentId,
    bookingStatus: row.bookingStatus,
    invoiceRef: row.xeroInvoiceNumber ?? row.xeroInvoiceId,
    refundNoteIssued: Boolean(row.xeroRefundCreditNoteId),
    finalPriceCents: row.finalPriceCents,
    changeFeeCents: row.changeFeeCents,
    xeroAllocatedAppliedCreditCents,
    expectedClearingCents,
    enqueuedClearingCents: row.enqueuedClearingCents,
    deltaCents,
  };
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

    const aggregate = await db.memberCredit.aggregate({
      where: {
        appliedToBookingId: payment.bookingId,
        type: CreditType.BOOKING_APPLIED,
        xeroCreditNoteId: { not: null },
      },
      _sum: { amountCents: true },
    });

    const finding = deriveIbHoldClearingFinding({
      paymentId: payment.id,
      bookingId: payment.bookingId,
      bookingStatus: payment.booking.status,
      enqueuedClearingCents: payment.amountCents,
      changeFeeCents: payment.changeFeeCents,
      xeroInvoiceId: payment.xeroInvoiceId,
      xeroInvoiceNumber: payment.xeroInvoiceNumber,
      xeroRefundCreditNoteId: payment.xeroRefundCreditNoteId,
      finalPriceCents: payment.booking.finalPriceCents,
      xeroAllocatedCreditSumCents: aggregate._sum.amountCents ?? 0,
    });

    if (finding) {
      result.underCleared.push(finding);
      result.totalDeltaCents += finding.deltaCents;
    }
  }

  return result;
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}NZ$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function formatIbHoldClearingAuditReport(
  result: IbHoldClearingAuditResult,
): string {
  const lines: string[] = [];
  lines.push("Internet-Banking hold-expiry invoice-clearing audit (#1597)");
  lines.push("REPORT ONLY — no changes were made and no provider was called.");
  lines.push("");
  lines.push(`Released holds scanned:        ${result.scannedReleasedHolds}`);
  lines.push(`  with an issued invoice:      ${result.invoiceBearingHolds}`);
  lines.push(`  with no invoice (skipped):   ${result.noInvoiceReleasedHolds}`);
  lines.push(`Under-cleared invoices found:  ${result.underCleared.length}`);
  lines.push(`Total open delta:              ${formatCents(result.totalDeltaCents)}`);
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
    lines.push(`    refund note issued: ${finding.refundNoteIssued ? "yes" : "no"}`);
    lines.push(`    final price:      ${formatCents(finding.finalPriceCents)}`);
    lines.push(`    change fee:       ${formatCents(finding.changeFeeCents)}`);
    lines.push(
      `    Xero-allocated credit: ${formatCents(finding.xeroAllocatedAppliedCreditCents)}`,
    );
    lines.push(`    expected clearing: ${formatCents(finding.expectedClearingCents)}`);
    lines.push(`    actual clearing:   ${formatCents(finding.enqueuedClearingCents)}`);
    lines.push(`    OPEN DELTA:        ${formatCents(finding.deltaCents)}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// #1620 — Internet-Banking + applied-credit strand enumeration (read-only)
// ---------------------------------------------------------------------------
//
// Distinct from the #1597 hold-clearing audit above. The booking invoice is
// raised at the FULL finalPrice and locally-applied member credit is never
// allocated against it (DOMAIN_INVARIANTS.md:124-128, "locally-applied credit
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
  /** amountCents + creditAppliedCents − finalPriceCents; the §4 payment-mirror
   * invariant residual (0 when the mirror is internally consistent). */
  mirrorInvariantDeltaCents: number;
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
): string[] {
  const lines: string[] = [];
  lines.push(`- booking ${finding.bookingId} (payment ${finding.paymentId})`);
  lines.push(`    booking status:    ${finding.bookingStatus}`);
  lines.push(`    payment status:    ${finding.paymentStatus}`);
  lines.push(`    final price:       ${formatCents(finding.finalPriceCents)}`);
  lines.push(`    amountCents:       ${formatCents(finding.amountCents)}`);
  lines.push(`    creditApplied (mirror): ${formatCents(finding.creditAppliedCents)}`);
  lines.push(`    applied (ledger):  ${formatCents(finding.ledgerAppliedCents)}`);
  lines.push(`    mirror vs ledger:  ${formatCents(finding.mirrorLedgerMismatchCents)}`);
  lines.push(`    mirror invariant delta: ${formatCents(finding.mirrorInvariantDeltaCents)}`);
  lines.push(`    STRAND EXPOSURE:   ${formatCents(finding.strandExposureCents)}`);
  return lines;
}

export function formatIbAppliedCreditStrandReport(
  result: IbAppliedCreditStrandAuditResult,
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
    `  credit already lost:                 ${formatCents(result.realizedStrandedCents)}`,
  );
  lines.push(
    `PENDING strands (not yet paid):        ${result.pending.length}`,
  );
  lines.push(
    `  credit at risk:                      ${formatCents(result.pendingExposureCents)}`,
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
      lines.push(...formatIbAppliedCreditStrandRow(finding));
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
      lines.push(...formatIbAppliedCreditStrandRow(finding));
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
): string[] {
  const lines: string[] = [];
  lines.push(`- booking ${finding.bookingId} (payment ${finding.paymentId})`);
  lines.push(`    booking status:    ${finding.bookingStatus}`);
  lines.push(`    payment source:    ${finding.paymentSource}`);
  lines.push(`    payment status:    ${finding.paymentStatus}`);
  lines.push(`    final price:       ${formatCents(finding.finalPriceCents)}`);
  lines.push(`    charged (card):    ${formatCents(finding.amountCents)}`);
  lines.push(`    creditApplied (mirror): ${formatCents(finding.creditAppliedCents)}`);
  lines.push(`    applied (ledger):  ${formatCents(finding.ledgerAppliedCents)}`);
  lines.push(`    DOUBLE-PAID (local restore): ${formatCents(finding.strandExposureCents)}`);
  return lines;
}

export function formatCardAppliedCreditDoublePayReport(
  result: CardAppliedCreditDoublePayAuditResult,
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
    `  credit already lost:                           ${formatCents(result.doublePaidCents)}`,
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
    lines.push(...formatCardAppliedCreditDoublePayRow(finding));
  }

  return lines.join("\n");
}
