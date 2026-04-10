import { prisma } from "./prisma";
import { isXeroConnected } from "./xero";
import logger from "@/lib/logger";

/**
 * Daily reconciliation of account credit balances.
 * Compares local MemberCredit ledger totals against Xero unallocated credit notes.
 * Alerts admins if discrepancies are found.
 *
 * Note: Full Xero reconciliation requires querying credit notes per contact,
 * which is expensive. This simplified version just checks local consistency
 * and reports aggregate stats.
 */
export async function reconcileCreditBalances(): Promise<{
  membersWithCredit: number;
  totalCreditCents: number;
  discrepancies: number;
}> {
  // Get per-member credit balances from local ledger
  const balances = await prisma.memberCredit.groupBy({
    by: ["memberId"],
    _sum: { amountCents: true },
  });

  const membersWithCredit = balances.filter(
    (b) => (b._sum.amountCents ?? 0) > 0
  ).length;

  const totalCreditCents = balances.reduce(
    (sum, b) => sum + Math.max(0, b._sum.amountCents ?? 0),
    0
  );

  // Check for negative balances (should never happen — indicates a bug)
  const negativeBalances = balances.filter(
    (b) => (b._sum.amountCents ?? 0) < 0
  );

  const discrepancies = negativeBalances.length;

  if (negativeBalances.length > 0) {
    logger.error(
      {
        count: negativeBalances.length,
        memberIds: negativeBalances.map((b) => b.memberId),
      },
      "Members with negative credit balance detected"
    );

    // Log error prominently — Sentry will pick this up
    logger.error(
      {
        alert: "CREDIT_BALANCE_DISCREPANCY",
        count: negativeBalances.length,
        memberIds: negativeBalances.map((b) => b.memberId),
      },
      `${negativeBalances.length} member(s) have negative credit balances — investigate immediately`
    );
  }

  // If Xero is connected, log basic stats for manual reconciliation
  try {
    if (await isXeroConnected()) {
      // Count credits that reference Xero credit notes
      const creditsWithXero = await prisma.memberCredit.count({
        where: {
          xeroCreditNoteId: { not: null },
          type: "CANCELLATION_REFUND",
        },
      });

      logger.info(
        {
          membersWithCredit,
          totalCreditCents,
          creditsWithXeroCreditNotes: creditsWithXero,
        },
        "Credit reconciliation: Xero credit note count logged for manual review"
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to check Xero connection during reconciliation");
  }

  logger.info(
    { membersWithCredit, totalCreditCents, discrepancies },
    "Credit reconciliation complete"
  );

  return { membersWithCredit, totalCreditCents, discrepancies };
}
