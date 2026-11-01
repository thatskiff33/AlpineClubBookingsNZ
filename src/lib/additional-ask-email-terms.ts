/**
 * #4052: HOW A BOOKING MODIFIED EMAIL NAMES AN EDIT'S ADDITIONAL PAYMENT - the
 * figure and the way to pay it, decided together, once, for every door (guest
 * removal, guest addition, date and batch edits, a guest-acceptance re-price).
 *
 * The doors used to decide the method each in its own words. The guest-removal
 * door read "no card request came back" as "pay by Internet Banking", so a
 * card-paid booking whose mint failed (its retry queued) was told to pay by
 * bank transfer, or told nothing when no invoice was issued. The method is now
 * read from the ask itself: an ask the club puts to the member's card is named
 * as a card payment whether or not its intent exists yet (`asksMemberCard`, the
 * minter's own test); otherwise an Internet Banking booking is named as one;
 * otherwise the email names the figure without a method.
 *
 * #3954 round 9 still holds: an ask a later reduction retired before it was
 * offered is owed by nobody - that reduction's own message told the member - so
 * it is never named. The figure itself is the door's, sized by the settlement
 * (`applyPaymentAdjustments`, `sizeAdditionalAsk`); nothing here re-sizes it.
 */
import { PaymentSource } from "@prisma/client";

import type { AdditionalAsk } from "@/lib/additional-payment-ask";

type CardAskFacts = {
  additionalAsk: Pick<AdditionalAsk, "amountCents" | "reissuesUnpaidAsk">;
  /** The settlement's answer: captured by card, or a credit-paid booking asked by card (#3502). */
  hasSucceededPayment: boolean;
};

/**
 * Whether this edit's ask is put to the member's card: a positive ask on a
 * card-settled booking, or a re-issue of an ask already put to it (#3954) - the
 * test `createModificationAdditionalPaymentIntent` mints on.
 */
export function asksMemberCard(edit: CardAskFacts): boolean {
  return edit.additionalAsk.amountCents > 0 && (edit.hasSucceededPayment || edit.additionalAsk.reissuesUnpaidAsk);
}

export type AdditionalAskEmailTerms = {
  additionalAmountCents: number;
  additionalPaymentMethod: "STRIPE" | "INTERNET_BANKING" | undefined;
};

/** The additional figure a door's email may name as due, and how it is paid. */
export function additionalAskEmailTerms(
  edit: CardAskFacts & {
    /** The plain figure the door's email reads (`PaymentAdjustmentResult.additionalAmountCents`). */
    additionalAmountCents: number;
    /** The booking payment's source; null where the door has none to name. */
    paymentSource: PaymentSource | null;
  },
  mint: { additionalAskRetired: boolean },
): AdditionalAskEmailTerms {
  const additionalAmountCents = mint.additionalAskRetired ? 0 : edit.additionalAmountCents;
  if (additionalAmountCents <= 0) return { additionalAmountCents, additionalPaymentMethod: undefined };
  if (asksMemberCard(edit)) return { additionalAmountCents, additionalPaymentMethod: "STRIPE" };
  return {
    additionalAmountCents,
    additionalPaymentMethod: edit.paymentSource === PaymentSource.INTERNET_BANKING ? "INTERNET_BANKING" : undefined,
  };
}
