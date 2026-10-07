import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * EVERY MEMBER'S ACCOUNT-CREDIT BALANCE, from the credit ledger: the sum of a
 * member's `MemberCredit` entries (positive = credit added, negative = credit
 * used), the same rule `getMemberCreditBalance` applies to one member. Read in
 * one grouped query. The daily credit reconciliation (`cron-credit-reconciliation.ts`)
 * and the "Credits owed" figure (`readRefundsAndCreditsOwed`) both read it.
 */
export async function readMemberCreditBalances(
  db: Pick<Prisma.TransactionClient, "memberCredit"> = prisma,
): Promise<Array<{ memberId: string; balanceCents: number }>> {
  const rows = await db.memberCredit.groupBy({
    by: ["memberId"],
    _sum: { amountCents: true },
  });
  return rows.map((row) => ({
    memberId: row.memberId,
    balanceCents: row._sum.amountCents ?? 0,
  }));
}

/**
 * THE CLUB'S OUTSTANDING ACCOUNT-CREDIT LIABILITY: credit issued to members
 * and not yet applied or used, summed over every member's balance. A negative
 * balance (which should never happen, and which the daily reconciliation
 * alerts on) owes the member nothing, so it adds 0 rather than hiding another
 * member's credit. Owner, #3372 (7 Oct 2026): "Credits owed" is this total,
 * and it stays until the credit is used.
 */
export function sumOutstandingCreditCents(
  balances: ReadonlyArray<{ balanceCents: number }>,
): number {
  return balances.reduce((sum, balance) => sum + Math.max(0, balance.balanceCents), 0);
}
