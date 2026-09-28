"use client";

import { useClubFormat } from "@/components/club-format-provider";
import { useClubTime } from "@/components/club-time-provider";
import { formatCents } from "@/lib/utils";

/**
 * #3643 (`INV-PAY-108`, ORCHESTRATOR DECISION 3): the inbound Xero sync's note
 * on a part-payment review in the hand-back queue. While a review exists the
 * app credits and hands back nothing for the invoice, so this line is how the
 * treasurer learns there may be more to settle - the email is best-effort, this
 * is the record.
 */
export function PartPaymentReviewXeroPaidLine({
  xeroPaid,
}: {
  xeroPaid: { reportedAt: string; cashCents: number };
}) {
  const format = useClubFormat();
  const clubTime = useClubTime();
  return (
    <p className="text-xs font-medium text-foreground">
      Xero reported this invoice paid on{" "}
      {clubTime.instantDate(new Date(xeroPaid.reportedAt))}, with{" "}
      {formatCents(xeroPaid.cashCents, format)} of cash recorded against it.
      Nothing was credited or handed back automatically: settle any cash beyond
      the part payment in Xero, then close this item.
    </p>
  );
}
