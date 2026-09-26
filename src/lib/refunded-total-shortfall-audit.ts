/**
 * Read-only audit of payments whose stored refunded total is BELOW what the
 * books say left the payment (#3640).
 *
 * Before #3640 a Stripe card refund was folded into `refundedAmountCents` with
 * `max(stored, card refunds on record)`, so a card refund made AFTER an
 * account-credit settlement vanished from the total: $100 credit then a $50
 * card refund stored $100, not $150. #3640 stops new cases (`INV-PAY-104`) and
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
 * REPORT ONLY - IT NEVER WRITES AND NEVER REPAIRS. It issues typed SELECTs
 * through Prisma (`INV-OPS-001`), and calls no provider.
 */
import { PaymentStatus } from "@prisma/client";

import type { ClubFormat } from "@/lib/club-format";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import { ACCOUNT_CREDIT_DISPOSITION_WHERE } from "@/lib/stripe-cash-refund-evidence";
import { formatCents } from "@/lib/utils";

/** A payment that has captured money, and so can have a refunded total at all. */
const AUDITED_PAYMENT_STATUSES = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
];

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
}

export interface RefundedTotalShortfallAuditResult {
  scannedPayments: number;
  findings: RefundedTotalShortfallFinding[];
  totalShortfallCents: number;
}

export function deriveRefundedTotalShortfall(
  row: RefundedTotalShortfallRow
): RefundedTotalShortfallFinding | null {
  const expectedFloorCents = Math.min(
    row.amountCents,
    row.cardRefundCents + row.accountCreditCents
  );
  const shortfallCents = expectedFloorCents - row.refundedAmountCents;
  if (shortfallCents <= 0) {
    return null;
  }
  return { ...row, expectedFloorCents, shortfallCents };
}

export async function auditRefundedTotalShortfalls(options?: {
  db?: typeof prisma;
}): Promise<RefundedTotalShortfallAuditResult> {
  const db = options?.db ?? prisma;

  const payments = await db.payment.findMany({
    where: {
      status: { in: AUDITED_PAYMENT_STATUSES },
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
    totalShortfallCents: 0,
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
      result.totalShortfallCents += finding.shortfallCents;
    }
  }
  result.findings.sort(
    (a, b) => b.shortfallCents - a.shortfallCents || a.paymentId.localeCompare(b.paymentId)
  );
  return result;
}

export function formatRefundedTotalShortfallReport(
  result: RefundedTotalShortfallAuditResult,
  format: ClubFormat
): string {
  const lines = [
    "Refunded-total shortfall audit (#3640, INV-PAY-104) - read only",
    "",
    `${result.scannedPayments} captured payment(s) scanned; ${result.findings.length} store a refunded total below card refunds + account credit, ${formatCents(result.totalShortfallCents, format)} in all.`,
  ];
  if (result.findings.length === 0) {
    return lines.join("\n");
  }
  lines.push("");
  for (const finding of result.findings) {
    lines.push(
      `  ${finding.paymentId}  booking ${finding.bookingId}  short ${formatCents(finding.shortfallCents, format)}` +
        `  (captured ${formatCents(finding.amountCents, format)}, stored refunded ${formatCents(finding.refundedAmountCents, format)},` +
        ` card refunds ${formatCents(finding.cardRefundCents, format)}, account credit ${formatCents(finding.accountCreditCents, format)})`
    );
  }
  lines.push(
    "",
    "Each shortfall is refundable headroom that is not really there. Nothing here is repaired; a person decides."
  );
  return lines.join("\n");
}
