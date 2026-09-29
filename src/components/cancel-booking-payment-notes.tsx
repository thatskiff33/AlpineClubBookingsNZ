"use client";

import { formatCents } from "@/lib/utils";
import type { ClubFormat } from "@/lib/club-format";

/**
 * #3643: the two cancel-dialog lines internet banking needs, split out of
 * `cancel-booking-button.tsx` for size.
 */

/** No payment the app can refund: none taken, or one settled by hand (DECISION 2). */
export function NoRefundablePaymentNote({ settledByHand }: { settledByHand?: boolean }) {
  return settledByHand ? (
    <p className="text-sm text-muted-foreground" data-testid="payment-settled-by-hand">
      Xero shows a payment against this booking that the app cannot hand back as account
      credit. Cancelling treats the booking as unpaid: no refund or credit is given, and the
      treasurer is alerted to settle that payment by hand.
    </p>
  ) : (
    <p className="text-sm text-muted-foreground">
      No payment has been taken for this booking. No refund applies.
    </p>
  );
}

/** The only outcome for an internet banking payment (`forcedCancelRefundMethod`). */
export function ForcedCreditRefundNote({
  creditRefundAmountCents,
  creditRefundPercentage,
  format,
}: {
  creditRefundAmountCents: number;
  creditRefundPercentage: number;
  format: ClubFormat;
}) {
  return (
    <div className="space-y-1" data-testid="forced-credit-refund">
      <p>
        <span className="font-medium text-success-11">
          Hold {formatCents(creditRefundAmountCents, format)} as account credit
        </span>
        <span className="text-muted-foreground ml-1">({creditRefundPercentage}% refund)</span>
      </p>
      <p className="text-muted-foreground">
        This booking was paid by internet banking, so any refund is held as account credit.
      </p>
    </div>
  );
}
