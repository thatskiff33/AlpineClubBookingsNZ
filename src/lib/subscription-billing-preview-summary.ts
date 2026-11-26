/**
 * The short account of a subscription billing preview that heads the
 * Subscriptions panel's answer (ALP-721 review). An AI app's answer is cut at
 * `MCP_RESULT_MAX_CHARS`, and a large club's preview lists every charge, so
 * the cut can drop entries while `preview.confirmationToken`, which sits
 * above them, survives. This summary sits first and is small, so the app can
 * show the officer what confirming would invoice, and see that it was handed
 * fewer entries than `entryCount`, before `confirm_subscription_billing_batch`.
 *
 * Read from the preview the route already built (`INV-SSOT`): the total is the
 * preview's own `totalCents`, each group's figure uses the same
 * `totalChargedCents`, and the warning and decision counts use the panel's own
 * classifiers. Nothing is priced again. Amounts are integer cents.
 */
import type { SubscriptionBillingPreview } from "@/lib/membership-subscription-billing-types";
import { totalChargedCents } from "@/lib/subscription-billing-totals";
import { isInvoicingPreviewWarning, isOfficerDecisionException } from "@/lib/subscription-charge-already-paid";

export type SubscriptionBillingPreviewGroup = {
  /** The subscription category a category-axis charge bills, otherwise null. */
  subscriptionCategoryName: string | null;
  /** The membership type a type-axis charge bills, otherwise null. */
  membershipTypeName: string | null;
  entryCount: number;
  chargedCents: number;
};

export type SubscriptionBillingPreviewSummary = {
  /** Charges confirming would raise, one invoice each. */
  entryCount: number;
  /** What those invoices total: the preview's own figure. */
  totalCents: number;
  /** Members those charges cover (a family charge covers several). */
  coveredMemberCount: number;
  /** The charges by subscription category or membership type, largest total first. */
  byMembership: SubscriptionBillingPreviewGroup[];
  /** Members whose age group or membership type needs no subscription. */
  exemptCount: number;
  /** Members, and families, skipped because they already hold an invoice. */
  alreadyInvoicedCount: number;
  alreadyInvoicedFamilyCount: number;
  /** Problems found: withheld ones are not invoiced, warnings are invoiced on confirm. */
  exceptionCount: number;
  withheldCount: number;
  warningCount: number;
  needsDecisionCount: number;
};

export function subscriptionBillingPreviewSummary(preview: SubscriptionBillingPreview): SubscriptionBillingPreviewSummary {
  const groups = new Map<string, { names: Pick<SubscriptionBillingPreviewGroup, "subscriptionCategoryName" | "membershipTypeName">; entries: SubscriptionBillingPreview["entries"] }>();
  for (const entry of preview.entries) {
    const names = {
      subscriptionCategoryName: entry.subscriptionCategoryName ?? null,
      membershipTypeName: entry.subscriptionCategoryName ? null : entry.membershipTypeName,
    };
    const key = JSON.stringify([names.subscriptionCategoryName, names.membershipTypeName]);
    const group = groups.get(key) ?? { names, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  const byMembership = [...groups.values()]
    .map(({ names, entries }) => ({ ...names, entryCount: entries.length, chargedCents: totalChargedCents(entries) }))
    .sort((left, right) => right.chargedCents - left.chargedCents || right.entryCount - left.entryCount);
  const warningCount = preview.exceptions.filter((item) => isInvoicingPreviewWarning(item.code)).length;
  return {
    entryCount: preview.entries.length,
    totalCents: preview.totalCents,
    coveredMemberCount: preview.entries.reduce((sum, entry) => sum + entry.coveredMembers.length, 0),
    byMembership,
    exemptCount: preview.exemptMembers.length,
    alreadyInvoicedCount: preview.alreadyInvoiced.length,
    alreadyInvoicedFamilyCount: preview.alreadyInvoicedFamilies.length,
    exceptionCount: preview.exceptions.length,
    withheldCount: preview.exceptions.length - warningCount,
    warningCount,
    needsDecisionCount: preview.exceptions.filter((item) => isOfficerDecisionException(item.code)).length,
  };
}
