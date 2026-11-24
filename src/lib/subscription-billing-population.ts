import type { Prisma } from "@prisma/client";

/**
 * The members a subscription billing run considers at all (#5190 review):
 * active and not archived. The billing preview's member query spreads this
 * where, and the admin lists' billing note reads
 * {@link isInSubscriptionBillingPopulation}, so the note never speaks for a
 * member billing never looks at.
 */
export const SUBSCRIPTION_BILLING_POPULATION_WHERE = {
  active: true,
  archivedAt: null,
} as const satisfies Prisma.MemberWhereInput;

/** {@link SUBSCRIPTION_BILLING_POPULATION_WHERE} over a member already read. */
export function isInSubscriptionBillingPopulation(member: {
  active: boolean;
  archivedAt: Date | string | null;
}): boolean {
  return (
    member.active === SUBSCRIPTION_BILLING_POPULATION_WHERE.active &&
    member.archivedAt === SUBSCRIPTION_BILLING_POPULATION_WHERE.archivedAt
  );
}
