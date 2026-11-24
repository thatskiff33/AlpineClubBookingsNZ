/**
 * #5190 (owner decision 22 Nov 2026): the warning under a subscription status
 * whose saved season row says "Not required" while billing treats the member
 * as owing. The text comes from `NOT_REQUIRED_ROW_BILLING_NOTE`; the members
 * list and the subscriptions list both render it here.
 */
export function SubscriptionBillingNote({ note }: { note: string | null | undefined }) {
  if (!note) return null;
  return <p className="mt-1 max-w-[16rem] text-xs text-warning-11">{note}</p>;
}
