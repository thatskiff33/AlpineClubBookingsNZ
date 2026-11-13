"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { CHECKING_PAYMENT_MESSAGE } from "@/lib/payment-recovery-contract";
import { stripeReturnUrl, takeStripeReturn } from "@/lib/stripe-return";

/*
  ALP-569: after a card payment the settle route says what it did - settled
  (it applies a succeeded capture), still processing, or a form to pay again -
  rather than the card deciding. Both exits of a confirmation come here: one
  resolved `processing` in the page, and a redirect method's return.
*/
export function useSettlementPaymentCheck(
  startSettle: (methodOverride: "stripe") => Promise<void>,
  closeCardForm: () => void,
) {
  const [checkingPayment, setCheckingPayment] = useState(false);
  // A redirect method that came back declined: the settle is offered again.
  const [redirectFailed, setRedirectFailed] = useState(false);

  async function checkSettlementPayment() {
    closeCardForm();
    setCheckingPayment(true);
    await startSettle("stripe");
    setCheckingPayment(false);
  }
  const checkReturnedSettlement = useEffectEvent(() => void checkSettlementPayment());
  useEffect(() => {
    // Taking the return clears it, so strict mode's second run finds nothing.
    const returned = takeStripeReturn("group-settlement");
    if (returned.kind === "failed") setRedirectFailed(true);
    else if (returned.kind === "check") checkReturnedSettlement();
  }, []);

  return { checkingPayment, redirectFailed, checkSettlementPayment };
}

/** Where a redirect method returns the organiser: this page, naming the settle. */
export function settlementReturnUrl(): string {
  return typeof window !== "undefined" ? stripeReturnUrl("group-settlement", window.location.href) : "";
}

/** The settle route's answer while it is asked, or its "still processing" one. */
export function SettlementPaymentStatus({ processingMessage }: { processingMessage: string }) {
  return processingMessage ? (
    <p role="status" className="rounded-md bg-info-3 p-3 text-sm text-info-11">
      {processingMessage}
    </p>
  ) : (
    <p className="text-sm text-muted-foreground">{CHECKING_PAYMENT_MESSAGE}</p>
  );
}
