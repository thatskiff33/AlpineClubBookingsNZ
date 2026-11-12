import {
  NO_ADDITIONAL_ASK,
  sizeReviewChargeAsk,
  type AdditionalAsk,
  type AdditionalAskSizingPayment,
} from "@/lib/additional-payment-ask";

/**
 * THE ASK FOR CREDIT RELEASED WHEN A CREDIT NOTE WAS SPENT IN XERO OUTSIDE THE APP
 * (#4253, `INV-ADDPAY-045`).
 *
 * Its own money is the smaller of what the release gave back and what the booking
 * ledger says is owed and nobody is asking for (`unaskedCents`, the identity's
 * residual). It is NEVER the whole residual: an older under-collection is not this
 * cause's to correct (owner, 8 Sep 2026), so a residual larger than the release is
 * clipped to it. It carries any unpaid ask it supersedes, like every constructor
 * (`INV-PAY-098`) - minting retires the other live intents on the payment, so the
 * new figure must absorb them or their money is asked of nobody.
 *
 * Nothing owed means NO ask rather than a carry-only one: restating an existing
 * ask under a new cause would only reword it.
 */
export function sizeCreditReleaseAsk({
  releasedCents,
  unaskedCents,
  payment,
}: {
  releasedCents: number;
  unaskedCents: number;
  payment: AdditionalAskSizingPayment | null | undefined;
}): AdditionalAsk {
  const ownCents = Math.min(Math.max(0, releasedCents), Math.max(0, unaskedCents));
  if (ownCents <= 0) return NO_ADDITIONAL_ASK;
  // The same rule as a review charge's first mint, different own figure: own money plus the unpaid ask carried.
  return sizeReviewChargeAsk({ shareTotalCents: ownCents, payment });
}
