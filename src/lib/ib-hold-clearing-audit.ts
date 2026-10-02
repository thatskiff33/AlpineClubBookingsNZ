/**
 * Read-only applied-credit enumeration for card payments (#1641), printed by
 * `scripts/audit-ib-hold-clearing.ts` after the hold-expiry under-clear audit,
 * which lives in `ib-hold-clearing-underclear-audit.ts` (split out by #3535).
 * Local SELECTs only; no provider is called and nothing is written.
 *
 * #1620's Internet-Banking strand enumeration (`auditIbAppliedCreditStrands`)
 * retired with #3583: its identity is one of the booking-ledger census's six
 * (`pnpm run booking-ledger:census`, `INV-MONEY-037`), and its count of applied
 * credit no Xero note allocates is reported there, as information under the
 * credit identity.
 */
import {
  BookingStatus,
  CreditType,
  PaymentSource,
  PaymentStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";
import type { ClubFormat } from "@/lib/club-format";

// ---------------------------------------------------------------------------
// #1641 — CARD double-pay enumeration (its IB sibling, #1620, retired with #3583)
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
        // out here.
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
