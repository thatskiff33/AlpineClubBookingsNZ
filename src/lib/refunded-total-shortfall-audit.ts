/**
 * Read-only audit of payments whose stored refunded total is BELOW what the
 * books say left the payment (#3640).
 *
 * Before #3640 a Stripe card refund was folded into `refundedAmountCents` with
 * `max(stored, card refunds on record)`, so a card refund made AFTER an
 * account-credit settlement vanished from the total: $100 credit then a $50
 * card refund stored $100, not $150. #3640 stops new cases (`INV-PAY-103`) and
 * does not touch old ones. This lists them, so the owner can decide on a repair
 * with the evidence in front of them.
 *
 * For each captured payment:
 *
 *   expected floor = min(captured, counted card refunds + account-credit dispositions)
 *   shortfall      = expected floor - stored refunded total   (reported when > 0)
 *
 * - Counted card refunds: the payment's `PaymentRefund` rows in a counted status
 *   (`isRecordedRefundStatus`), the same rows the mirror's own writer counts.
 * - Account-credit dispositions: `ACCOUNT_CREDIT_DISPOSITION_WHERE`, the one
 *   definition `stripe-cash-refund-evidence.ts` also reads.
 *
 * It is a FLOOR, not an identity: the mirror also carries value no row records
 * (pre-ledger card refunds, #1491's folded modification credit notes), so a
 * stored total ABOVE the floor is normal and never reported. A shortfall is a
 * payment whose refundable headroom is overstated by that amount - the money a
 * later cancel or refund could pay out a second time.
 *
 * ATTRIBUTION. The old `max` could lose money only where a card refund met a
 * credit, and at most the smaller of the two. So only
 * `min(card refunds, account credit, shortfall)`, and only with a card refund,
 * is attributed to it. Anything more is reported apart, as short for ANOTHER
 * reason: the credit rows are chosen by type, and some were never folded into
 * the mirror at all - a credit minted with no payment, or internet-banking cash
 * that landed on an already-cancelled booking and became credit. The other
 * cause: a card refund the old arithmetic never added (it met a credit) that
 * later FAILED - its row no longer counts, so nothing card-side is left to
 * attribute. Since #3640 the writer's floor stops such a subtraction going
 * below the credit, so this can only predate the fix. Those need a person's
 * reading, not the #3640 repair.
 *
 * REPORT ONLY - IT NEVER WRITES AND NEVER REPAIRS. It issues typed SELECTs
 * through Prisma (`INV-OPS-001`), and calls no provider.
 */
import { CAPTURED_PAYMENT_STATUS_LIST } from "@/lib/booking-payment-state";
import type { ClubFormat } from "@/lib/club-format";
import {
  expectedRefundedFloorCents,
  isRecordedRefundStatus,
} from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import { ACCOUNT_CREDIT_DISPOSITION_WHERE } from "@/lib/stripe-cash-refund-evidence";
import { formatCents } from "@/lib/utils";

export interface RefundedTotalShortfallRow {
  paymentId: string;
  bookingId: string;
  amountCents: number;
  refundedAmountCents: number;
  /** Counted `PaymentRefund` rows on the payment. */
  cardRefundCents: number;
  /** Account-credit dispositions sourced from the payment's booking. */
  accountCreditCents: number;
}

export interface RefundedTotalShortfallFinding extends RefundedTotalShortfallRow {
  expectedFloorCents: number;
  shortfallCents: number;
  /** The part the old refund arithmetic can account for (see ATTRIBUTION). */
  attributableCents: number;
  /** The rest: short for another reason. */
  unattributedCents: number;
}

export interface RefundedTotalShortfallAuditResult {
  scannedPayments: number;
  findings: RefundedTotalShortfallFinding[];
  totalAttributableCents: number;
  totalUnattributedCents: number;
}

export function deriveRefundedTotalShortfall(
  row: RefundedTotalShortfallRow
): RefundedTotalShortfallFinding | null {
  const expectedFloorCents = expectedRefundedFloorCents(row);
  const shortfallCents = expectedFloorCents - row.refundedAmountCents;
  if (shortfallCents <= 0) {
    return null;
  }
  const attributableCents =
    row.cardRefundCents > 0
      ? Math.min(row.cardRefundCents, row.accountCreditCents, shortfallCents)
      : 0;
  return {
    ...row,
    expectedFloorCents,
    shortfallCents,
    attributableCents,
    unattributedCents: shortfallCents - attributableCents,
  };
}

export async function auditRefundedTotalShortfalls(options?: {
  db?: typeof prisma;
}): Promise<RefundedTotalShortfallAuditResult> {
  const db = options?.db ?? prisma;

  const payments = await db.payment.findMany({
    where: {
      // A payment that has captured money, and so can have a refunded total
      // at all: the aggregate's one captured list (#3635 F3, INV-SSOT).
      status: { in: [...CAPTURED_PAYMENT_STATUS_LIST] },
      amountCents: { gt: 0 },
    },
    select: {
      id: true,
      bookingId: true,
      amountCents: true,
      refundedAmountCents: true,
    },
    orderBy: { id: "asc" },
  });

  const refundGroups = await db.paymentRefund.groupBy({
    by: ["paymentId", "status"],
    _sum: { amountCents: true },
  });
  const cardRefundCentsByPayment = new Map<string, number>();
  for (const group of refundGroups) {
    if (!isRecordedRefundStatus(group.status)) continue;
    cardRefundCentsByPayment.set(
      group.paymentId,
      (cardRefundCentsByPayment.get(group.paymentId) ?? 0) +
        Math.max(0, group._sum.amountCents ?? 0)
    );
  }

  const creditGroups = await db.memberCredit.groupBy({
    by: ["sourceBookingId"],
    where: { ...ACCOUNT_CREDIT_DISPOSITION_WHERE, sourceBookingId: { not: null } },
    _sum: { amountCents: true },
  });
  const accountCreditCentsByBooking = new Map<string, number>();
  for (const group of creditGroups) {
    if (!group.sourceBookingId) continue;
    accountCreditCentsByBooking.set(
      group.sourceBookingId,
      Math.max(0, group._sum.amountCents ?? 0)
    );
  }

  const result: RefundedTotalShortfallAuditResult = {
    scannedPayments: payments.length,
    findings: [],
    totalAttributableCents: 0,
    totalUnattributedCents: 0,
  };
  for (const payment of payments) {
    const finding = deriveRefundedTotalShortfall({
      paymentId: payment.id,
      bookingId: payment.bookingId,
      amountCents: payment.amountCents,
      refundedAmountCents: payment.refundedAmountCents,
      cardRefundCents: cardRefundCentsByPayment.get(payment.id) ?? 0,
      accountCreditCents: accountCreditCentsByBooking.get(payment.bookingId) ?? 0,
    });
    if (finding) {
      result.findings.push(finding);
      result.totalAttributableCents += finding.attributableCents;
      result.totalUnattributedCents += finding.unattributedCents;
    }
  }
  result.findings.sort(
    (a, b) =>
      b.attributableCents - a.attributableCents ||
      b.shortfallCents - a.shortfallCents ||
      a.paymentId.localeCompare(b.paymentId)
  );
  return result;
}

export function formatRefundedTotalShortfallReport(
  result: RefundedTotalShortfallAuditResult,
  format: ClubFormat
): string {
  const attributed = result.findings.filter((finding) => finding.attributableCents > 0);
  const other = result.findings.filter((finding) => finding.unattributedCents > 0);
  const describe = (finding: RefundedTotalShortfallFinding) =>
    `(captured ${formatCents(finding.amountCents, format)}, stored refunded ${formatCents(finding.refundedAmountCents, format)},` +
    ` card refunds ${formatCents(finding.cardRefundCents, format)}, account credit ${formatCents(finding.accountCreditCents, format)})`;

  const lines = [
    "Refunded-total shortfall audit (#3640, INV-PAY-103) - read only",
    "",
    `${result.scannedPayments} captured payment(s) scanned.`,
    `${attributed.length} short because a card refund met an account credit under the old refund arithmetic, ${formatCents(result.totalAttributableCents, format)} in all.`,
    `${other.length} short for another reason, ${formatCents(result.totalUnattributedCents, format)} in all - not caused by the old arithmetic.`,
  ];
  if (attributed.length > 0) {
    lines.push("", "## Short because of the old refund arithmetic (#3640)");
    for (const finding of attributed) {
      lines.push(
        `  ${finding.paymentId}  booking ${finding.bookingId}  short ${formatCents(finding.attributableCents, format)}  ${describe(finding)}`
      );
    }
  }
  if (other.length > 0) {
    lines.push(
      "",
      "## Short for another reason - read before acting",
      "  Either a credit here was never folded into the refunded total (a credit minted with no",
      "  payment, or internet-banking cash that became credit on a cancelled booking), or a card",
      "  refund the old arithmetic never added later failed and was taken out."
    );
    for (const finding of other) {
      lines.push(
        `  ${finding.paymentId}  booking ${finding.bookingId}  short ${formatCents(finding.unattributedCents, format)}  ${describe(finding)}`
      );
    }
  }
  if (result.findings.length > 0) {
    lines.push(
      "",
      "Each shortfall is refundable headroom that may not really be there. Nothing here is repaired; a person decides."
    );
  }
  return lines.join("\n");
}
