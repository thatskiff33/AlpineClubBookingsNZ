import type { Payment } from "@prisma/client";

/**
 * The one home for the question "which saved card may this booking be charged
 * on off-session?" (#3269, `INV-PAY-053`).
 *
 * A `Payment` row carrying a `stripePaymentMethodId` is NOT proof of a card we
 * may charge again. Two writers stamp that column, and only one of them saves a
 * reusable card:
 *
 * - `markBookingSetupIntentSucceeded` (the `setup_intent.succeeded` webhook and
 *   the setup-intent route's already-saved arm) writes the payment method AND
 *   `stripeSetupIntentId` together. A SetupIntent attaches the card to the
 *   customer for off-session use, which is the only way this application ever
 *   saves a card for reuse — there is no `setup_future_usage` on the Payment
 *   Element anywhere in `src/`.
 * - `markBookingPaymentSucceeded` writes the payment method the succeeded
 *   one-off PaymentIntent used. That card was never attached to the customer,
 *   and Stripe refuses to charge it a second time ("The provided PaymentMethod
 *   was previously used with a PaymentIntent without Customer attachment ...").
 *
 * So `stripeSetupIntentId` on the SAME row that offers the payment method is the
 * provenance proxy: a card is reusable only when all three of customer, payment
 * method and SetupIntent are set on that row. Before this module the cron asked
 * only "is there a card?", found the parent's one-off checkout card, charged it
 * (refused), and copied it onto the child's own row — laundering a one-off
 * artefact into what every other reader then trusted as a saved card.
 *
 * What the proxy does NOT prove:
 *
 * - That the pm on the row IS the SetupIntent's card. A later Payment Element
 *   capture on a row that still carries an old `stripeSetupIntentId` overwrites
 *   the pm with a one-off one and passes this check. #3268's terminal handling
 *   of a Stripe refusal is the backstop for that shape — it cannot be told
 *   apart from here.
 * - That the SetupIntent succeeded. The setup-intent route stamps the id of a
 *   freshly minted, not-yet-confirmed SetupIntent; the pm arrives only when it
 *   succeeds, so a row with the id and no pm is correctly "no card". A row
 *   holding a stale pm beside a replacement SetupIntent id is #3266's repair.
 *
 * A consequence that is deliberate: a legacy laundered child row — customer and
 * pm copied from the parent, no `stripeSetupIntentId` — no longer counts as the
 * child's own card. That repairs the rows the production incident left behind
 * without a migration: the next resolution re-derives the answer from
 * provenance and routes the child down the payment-link path instead of into a
 * charge that cannot succeed.
 *
 * The same shape still arises legitimately, and is harmless for the same
 * reason. No CLAIM writes the card column (`savedPaymentMethodRowStamp`), but a
 * charge attempt on a borrowed card records that card on the child's row as
 * every attempt does: `upsertPaymentIntentTransaction` →
 * `reconcilePaymentAggregates` mirrors the latest primary attempt's pm whether
 * it succeeded, failed or is pending, and `markBookingPaymentSucceeded` writes
 * the pm that paid. So a PENDING child whose borrowed charge failed, and a PAID
 * child, may both carry the parent's pm without a SetupIntent. Neither copy is
 * ever offered for reuse — this predicate is what makes the copy harmless, not
 * the absence of the copy.
 */

export type ReusableSavedPaymentMethod = {
  stripeCustomerId: string;
  stripePaymentMethodId: string;
};

/** The three columns the provenance question reads. `Pick` of the Prisma model
 * so a renamed column fails here rather than silently reading `undefined`. */
export type SavedPaymentMethodRow = Pick<
  Payment,
  "stripeCustomerId" | "stripePaymentMethodId" | "stripeSetupIntentId"
>;

/**
 * The card a single `Payment` row offers for off-session charging, or `null`.
 * Non-null only when customer, payment method AND SetupIntent are all set on
 * this row — see the module docblock for why the SetupIntent is the gate.
 */
export function reusableSavedPaymentMethodOnRow(
  payment: SavedPaymentMethodRow | null | undefined
): ReusableSavedPaymentMethod | null {
  if (
    !payment?.stripeCustomerId ||
    !payment.stripePaymentMethodId ||
    !payment.stripeSetupIntentId
  ) {
    return null;
  }
  return {
    stripeCustomerId: payment.stripeCustomerId,
    stripePaymentMethodId: payment.stripePaymentMethodId,
  };
}

/** Which row supplied the card: the booking's own `Payment`, or its split
 * parent's (#738 — the member's own booking, whose saved card is the intended
 * fallback for the deferred non-member guest charge). */
export type SavedPaymentMethodSource = "own" | "parent";

export type SavedPaymentMethodForBooking = ReusableSavedPaymentMethod & {
  source: SavedPaymentMethodSource;
};

/**
 * The card this booking may be charged on off-session: its own row first, then
 * its split parent's row, each judged by `reusableSavedPaymentMethodOnRow`.
 *
 * Callers that can answer for a split child must load
 * `parentBooking: { include: { payment: true } }` (or a select carrying the
 * three columns); a caller that passes `parentBooking: null` has decided the
 * parent fallback does not apply to it and gets the own-row answer only.
 */
export function savedPaymentMethodForBooking(booking: {
  payment: SavedPaymentMethodRow | null | undefined;
  parentBooking:
    | { payment: SavedPaymentMethodRow | null | undefined }
    | null
    | undefined;
}): SavedPaymentMethodForBooking | null {
  const own = reusableSavedPaymentMethodOnRow(booking.payment);
  if (own) {
    return { ...own, source: "own" };
  }
  const parent = reusableSavedPaymentMethodOnRow(booking.parentBooking?.payment);
  if (parent) {
    return { ...parent, source: "parent" };
  }
  return null;
}

/**
 * What a charge claim may persist on the CHARGED booking's own `Payment` row:
 * the customer it is charged under, and nothing else.
 *
 * The customer is always written (the row needs it to record the transaction).
 * The payment method is NEVER written by a claim, whichever row supplied it:
 *
 * - From the parent, copying it onto the child is exactly the laundering that
 *   turned a one-off checkout artefact into a "saved card" every reader trusted
 *   (#3269).
 * - From the child's own row, writing it back looks like a no-op but races
 *   the setup-intent route's replacement mint (#3266), which clears the pm
 *   beside a fresh `stripeSetupIntentId`. Read (pm1, seti1) → replacement
 *   writes (null, seti2) → a claim writing pm1 back leaves (pm1, seti2): a
 *   card mid-replacement that passes the provenance check. A claim that writes
 *   only the customer cannot resurrect anything.
 *
 * The charge uses the returned card object, not the row. A SUCCESSFUL charge
 * then records the card that paid on the row like every other capture does
 * (`reconcilePaymentAggregates`, `markBookingPaymentSucceeded`) — a copy with
 * no SetupIntent beside it, which is why `reusableSavedPaymentMethodOnRow`
 * never reads it as reusable. Both claim writers — the settlement cron and the
 * admin confirm-pending-guests route — spread this into their upsert, so the
 * rule has one home. `source` is carried for logging and tests, not for the
 * stamp.
 */
export function savedPaymentMethodRowStamp(
  saved: SavedPaymentMethodForBooking
): { stripeCustomerId: string } {
  return { stripeCustomerId: saved.stripeCustomerId };
}
