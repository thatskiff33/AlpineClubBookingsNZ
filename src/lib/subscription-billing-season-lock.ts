import type { Prisma } from "@prisma/client";

/**
 * The membership-subscription billing season key (#2148, #5190), minted once
 * here (`INV-LOCK-002`): `hashtext("membership-subscription-billing:<seasonYear>")`.
 *
 * Billing confirm and the exception refresh-reconciliation hold it while they
 * re-preview a season, and the liability clear-up
 * (`clearStaleNotRequiredRows`) holds it while it rewrites that season's stale
 * `NOT_REQUIRED` rows, so a confirm either sees the club's liability rule and
 * rows from before a change or from after it — never half of each. Writer index
 * and counterpart analysis: docs/CONCURRENCY_AND_LOCKING.md.
 */
export async function lockSubscriptionBillingSeason(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  seasonYear: number,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`membership-subscription-billing:${seasonYear}`}))`;
}
