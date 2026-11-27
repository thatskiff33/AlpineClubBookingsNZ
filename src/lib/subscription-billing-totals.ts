/**
 * What a set of subscription billing plan entries charges, in cents: the
 * preview's `totalCents`, the confirm audit's total and each group's figure in
 * the preview summary (`subscription-billing-preview-summary.ts`). One home so
 * no total is summed a second way (`INV-SSOT`). Pure: nothing here reads the
 * database.
 */
import type { SubscriptionBillingPlanEntry } from "@/lib/membership-subscription-billing-types";

export function totalChargedCents(entries: readonly Pick<SubscriptionBillingPlanEntry, "chargedAmountCents">[]): number {
  return entries.reduce((sum, entry) => sum + entry.chargedAmountCents, 0);
}
