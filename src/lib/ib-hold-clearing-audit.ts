/**
 * Read-only applied-credit enumerations for Internet-Banking and card payments
 * (#1620, #1641), printed by `scripts/audit-ib-hold-clearing.ts` after the
 * hold-expiry under-clear audit, which lives in
 * `ib-hold-clearing-underclear-audit.ts` (split out by #3535). Local SELECTs
 * only; no provider is called and nothing is written.
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
