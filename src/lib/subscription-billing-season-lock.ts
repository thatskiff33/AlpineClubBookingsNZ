import type { Prisma } from "@prisma/client";

/**
 * Billing confirm's interactive-transaction budget. A whole-club annual run
 * touches every member sequentially, and Prisma's default 5 s aborts it with
 * P2028 for clubs of a few hundred members (#1886, F12). Confirm holds the
 * season key for up to this long.
 */
export const SUBSCRIPTION_BILLING_CONFIRM_TIMEOUT_MS = 60_000;

/**
 * The budget for a short transaction that WAITS on the season key — the
 * liability settings save and the post-import clear-up (#5190). Prisma's
 * timeout counts the wait, so it must outlast a confirm's whole hold plus the
 * waiter's own writes; with the default 5 s an opt-in during a long confirm
 * would fail with P2028.
 */
export const SUBSCRIPTION_BILLING_SEASON_WAITER_TIMEOUT_MS =
  SUBSCRIPTION_BILLING_CONFIRM_TIMEOUT_MS + 30_000;

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
