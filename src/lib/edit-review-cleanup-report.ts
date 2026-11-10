import type { EditReviewCleanupReport } from "@/lib/edit-review-cleanup";
import type { CleanupMoneyColumns } from "@/lib/edit-review-cleanup-plan";
import { formatCentsPlain } from "@/lib/utils";

function cents(value: number): string {
  return formatCentsPlain(value);
}

function columns(label: string, money: CleanupMoneyColumns): string {
  return `${label}: total ${cents(money.totalPriceCents)}, discount ${cents(money.discountCents)}, promo ${cents(money.promoAdjustmentCents)}, final ${cents(money.finalPriceCents)}`;
}

/** Operator text. The script prints this; `--json` prints the report beside it. */
export function formatEditReviewCleanupReport(report: EditReviewCleanupReport): string {
  const lines = [
    `Open edit reviews: ${report.openCount}`,
    `By status: ${Object.entries(report.reviewsByStatus).map(([status, count]) => `${status} ${count}`).join(", ") || "none"}`,
    `Frozen headlines: ${report.frozen.length}`,
    `Dismissed shortenings (D7, listed only): ${report.d7.length}`,
    `Recovery rows not succeeded: ${report.gate.paymentRecoveryNotSucceeded}`,
    `Charge claims holding a token: ${report.gate.chargeClaimsHoldingToken}`,
    `Xero operations still open or failed: ${report.gate.xeroOutstandingOrFailed}`,
    `Ledger bookings whose night lines differ: ${report.ledgerNightValues.bookingsWhoseLinesDifferFromValues} of ${report.ledgerNightValues.bookingsOnLedger} on the ledger`,
  ];
  for (const row of report.d7) {
    lines.push(`D7 ${row.bookingId} task ${row.taskId} guest ${row.guestId} still stored at ${cents(row.guestTotalCents)}`);
  }
  for (const decision of report.decisions) {
    if (decision.action === "dismiss") {
      const remaining = decision.remainingStrandGuestIds.length > 0 ? ` remaining ${decision.remainingStrandGuestIds.join(",")}` : "";
      lines.push(`Would close ${decision.bookingId} task ${decision.taskId} with no money (${decision.reason})${remaining}`);
    } else {
      lines.push(
        `Would ${decision.direction} ${cents(decision.amountCents)} on ${decision.bookingId} task ${decision.taskId} (fee ${cents(decision.feeCents)})`,
      );
    }
  }
  for (const row of report.settled) {
    if (row.action === "complete") {
      lines.push(`Settled ${row.bookingId} task ${row.taskId} ${row.direction} ${cents(row.amountCents)} fee ${cents(row.feeCents)}`);
    }
  }
  for (const row of report.closedWithNoMoney) {
    if (row.action === "dismiss") lines.push(`Closed ${row.bookingId} task ${row.taskId} with no money (${row.reason})`);
  }
  for (const row of report.leftOpen) {
    lines.push(`Left OPEN ${row.bookingId} task ${row.taskId}: ${row.message}`);
  }
  for (const headline of report.headlines) {
    if (headline.kind === "unchanged") {
      lines.push(`Headline ${headline.bookingId} unchanged`);
    } else if (headline.kind === "rebased") {
      lines.push(
        `Headline ${headline.bookingId} ${columns("before", headline.before)}; ${columns("after", headline.after)}; invoice ${headline.invoiceDiverged ? "diverges" : "agrees"}; ledger ${headline.ledgerPosted ? "posted" : "not posted"}`,
      );
    } else {
      lines.push(`Headline ${headline.bookingId} ${headline.kind}: ${headline.message}`);
    }
  }
  return lines.join("\n");
}
