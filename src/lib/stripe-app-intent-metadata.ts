/**
 * WHICH STRIPE PAYMENTINTENTS THE APP CREATED (#4532, `INV-INT-032`): the one
 * definition the `payment_intent.succeeded` dispatcher and every app call site
 * share. A plain module, no SDK, so a type can be imported anywhere.
 *
 * Every PaymentIntent the app mints goes through `createPaymentIntent` or
 * `chargePaymentMethod` in `stripe.ts` (the only `paymentIntents.create` calls;
 * `stripe-app-intent-metadata.test.ts` holds the census), and both now REQUIRE
 * {@link AppPaymentIntentMetadata}: a booking's intent carries `bookingId`, a
 * group organiser's settlement carries `type: "group_settlement"`. The app
 * creates no Checkout session, Payment Link, invoice or subscription, so a
 * succeeded intent carrying neither was made outside the app — a Payment Link,
 * a Checkout page or a dashboard charge — and is recorded and alerted rather
 * than silently completed.
 *
 * Recognised means "routed to an app path", NOT "carries some key the app also
 * uses": a club's own Payment Link may set its own `type` or `memberId`
 * metadata, and must still reach the treasurer.
 */

/** The `type` a group organiser's combined settlement intent carries. */
export const GROUP_SETTLEMENT_INTENT_TYPE = "group_settlement";

/** What a booking's intent carries: the booking it pays. */
type BookingIntentMetadata = { readonly bookingId: string };

/** What a group organiser's settlement intent carries. */
type GroupSettlementIntentMetadata = {
  readonly type: typeof GROUP_SETTLEMENT_INTENT_TYPE;
  readonly groupBookingId: string;
};

/**
 * The metadata of an intent the app creates. Required by both wire functions in
 * `stripe.ts`, so an app intent without it does not compile.
 */
export type AppPaymentIntentMetadata = Readonly<Record<string, string>> &
  (BookingIntentMetadata | GroupSettlementIntentMetadata);

/**
 * True when a PaymentIntent's metadata is the app's own: a non-empty `bookingId`,
 * or the group settlement type. The `payment_intent.succeeded` dispatcher routes
 * exactly these to an app path; anything else is a payment the app did not create.
 */
export function isAppCreatedPaymentIntent(
  metadata: Readonly<Record<string, string | undefined>> | null | undefined,
): boolean {
  if (!metadata) return false;
  if (metadata.type === GROUP_SETTLEMENT_INTENT_TYPE) return true;
  return typeof metadata.bookingId === "string" && metadata.bookingId.length > 0;
}
