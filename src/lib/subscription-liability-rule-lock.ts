import type { Prisma } from "@prisma/client";

/**
 * The subscription-liability rule key (#5190), minted once here
 * (`INV-LOCK-002`): `hashtext("membership-subscription-liability-rule")`. One
 * key for the club, not per season: the rule it guards is one singleton row.
 *
 * It orders a reader of the club's liability rule that then rewrites a
 * `NOT_REQUIRED` season row against a writer of that rule:
 *
 *  - the seasonal-assignment reconcile (`reconcileSeasonSubscriptionForAssignment`)
 *    takes it SHARED, after the global, lodge and member keys its callers hold;
 *  - the liability clear-up (`clearStaleNotRequiredRows`, run by the settings
 *    save and after a config import) takes it EXCLUSIVE, always AFTER the
 *    billing season key, so it never holds it while it waits for a billing
 *    confirm or, in the save, for the settings row.
 *
 * So a reconcile runs wholly before an opt-in's clear-up (which then sees its
 * row) or wholly after it (and reads the chosen rule), yet waits only for the
 * clear-up's own short, provider-free writes — never for a billing confirm
 * holding the season key, which it must not wait on while it holds `lock(1)`.
 * Writer index and counterpart analysis: docs/CONCURRENCY_AND_LOCKING.md.
 */
const SUBSCRIPTION_LIABILITY_RULE_KEY = "membership-subscription-liability-rule";

/** The reconcile's side: many assignment saves may read the rule at once. */
export async function lockSubscriptionLiabilityRuleShared(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${SUBSCRIPTION_LIABILITY_RULE_KEY}))`;
}

/** The rule writer's side. Take it only after the billing season key. */
export async function lockSubscriptionLiabilityRuleExclusive(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SUBSCRIPTION_LIABILITY_RULE_KEY}))`;
}
