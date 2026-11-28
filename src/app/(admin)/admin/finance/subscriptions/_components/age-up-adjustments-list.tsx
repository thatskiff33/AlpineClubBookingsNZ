"use client";

// #5190 PR 3: the age-group top-ups and credits a billing preview will raise
// beside its annual charges, and the batch totals the confirm dialog quotes.
import type { ClubFormat } from "@/lib/club-format";
import type { SubscriptionBillingAgeUpAdjustment } from "@/lib/membership-subscription-billing-types";
import { formatCents } from "@/lib/utils";

/** What the batch invoices (annual charges plus top-ups) and what it credits. */
export function ageUpBatchTotals(annualCents: number, adjustments: SubscriptionBillingAgeUpAdjustment[]) {
  const sum = (kind: SubscriptionBillingAgeUpAdjustment["kind"]) =>
    adjustments.reduce((total, item) => total + (item.kind === kind ? item.amountCents : 0), 0);
  return { invoiceCents: annualCents + sum("TOP_UP"), creditCents: sum("CREDIT") };
}

export function AgeUpAdjustmentsList({ adjustments, format }: { adjustments: SubscriptionBillingAgeUpAdjustment[]; format: ClubFormat }) {
  if (adjustments.length === 0) return null;
  return (
    <section aria-label="Age-group adjustments" className="space-y-2">
      <h3 className="font-medium">Age-group adjustments</h3>
      <p className="text-sm text-muted-foreground">These top-ups and credits are additional to the annual charge total.</p>
      {adjustments.map((item) => (
        <div key={item.key} className="rounded-md border p-3 text-sm">
          <div className="flex flex-wrap justify-between gap-2"><span>{item.kind === "CREDIT" ? "Credit" : "Top-up"} · {item.memberName}</span><span>{formatCents(item.amountCents, format)}</span></div>
          <p className="text-muted-foreground">{item.description}</p>
        </div>
      ))}
    </section>
  );
}
