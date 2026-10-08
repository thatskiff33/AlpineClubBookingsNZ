"use client";

import { useClubFormat } from "@/components/club-format-provider";
import {
  formatPaidRefundedBreakdown,
  getPaymentNetOfRefundsCents,
} from "@/lib/booking-payment-state";
import { formatCents } from "@/lib/utils";

/**
 * The change-requests panel's "Payment:" line (#3372). NET of refunds and
 * credits, the shape #3364 gave the payments board. An officer reads this while
 * deciding what to charge, and a gross figure beside "Booking total" sizes the
 * balance wrongly by exactly the refund - the #3340 misreading. Gross and
 * refunded print beneath, so only the headline changed; the " net" suffix and
 * that line share one guard, the breakdown being present.
 */
export function ChangeRequestPaymentLine({
  payment,
}: {
  payment: {
    amountCents: number;
    refundedAmountCents: number;
    status: string;
  } | null;
}) {
  const format = useClubFormat();
  const breakdown = payment
    ? formatPaidRefundedBreakdown(
        payment.amountCents,
        payment.refundedAmountCents,
        (cents) => formatCents(cents, format),
      )
    : null;
  return (
    <div>
      <span className="text-muted-foreground">Payment:</span>{" "}
      {payment
        ? `${payment.status} (${formatCents(
            getPaymentNetOfRefundsCents(payment),
            format,
          )}${breakdown ? " net" : ""})`
        : "No payment"}
      {breakdown ? (
        <div className="text-xs text-muted-foreground">{breakdown}</div>
      ) : null}
    </div>
  );
}
