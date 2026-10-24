"use client";

import { PREVIOUS_PAYMENT_REFUNDING_NOTICE } from "@/lib/payment-recovery-contract";

/**
 * #4300 (`INV-PAY-138`): above a fresh payment form when the payer's earlier
 * card payment was on an intent an edit superseded, so it is going back. The
 * one notice both card pages render (the booking page's pay step and the `/pay`
 * link). The `role="status"` wrapper stays mounted and only its content
 * changes: a live region injected already populated is silently dropped by
 * some screen-reader and browser pairings (#2160).
 */
export function PreviousPaymentRefundingNotice({ show, className }: { show: boolean; className?: string }) {
  return (
    <div role="status" aria-live="polite" data-testid="previous-payment-refunding" className={className}>
      {show ? (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-foreground">{PREVIOUS_PAYMENT_REFUNDING_NOTICE}</p>
      ) : null}
    </div>
  );
}
