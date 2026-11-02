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

/** What a booking's intent carries: the booking it pays. An empty id is not one. */
type BookingIntentMetadata = { readonly bookingId: string };

/**
 * The type allows `bookingId: ""`. Refuse it before Stripe sees it: the webhook
 * would treat that charge as a payment the app did not create.
 */
export function assertAppPaymentIntentMetadata(metadata: AppPaymentIntentMetadata): void {
  if ("bookingId" in metadata && metadata.bookingId.length === 0) {
    throw new Error("An app PaymentIntent's bookingId must be non-empty");
  }
}

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

/** The app path a recognised intent is routed to: a group settlement, or the booking it names. */
export type AppPaymentIntentRoute =
  | { readonly kind: "group_settlement" }
  | { readonly kind: "booking"; readonly bookingId: string };

/**
 * The one reading of a PaymentIntent's metadata: the group settlement type, else
 * a non-empty `bookingId` (#4647: carried on the route, so a booking route with
 * no booking cannot be represented), else `null` - a payment the app did not
 * create. The `payment_intent.succeeded` dispatcher routes on exactly this.
 */
export function appPaymentIntentRoute(
  metadata: Readonly<Record<string, string | undefined>> | null | undefined,
): AppPaymentIntentRoute | null {
  if (!metadata) return null;
  if (metadata.type === GROUP_SETTLEMENT_INTENT_TYPE) return { kind: "group_settlement" };
  const bookingId = metadata.bookingId;
  return typeof bookingId === "string" && bookingId.length > 0 ? { kind: "booking", bookingId } : null;
}

/**
 * True when a PaymentIntent's metadata is the app's own: a non-empty `bookingId`,
 * or the group settlement type ({@link appPaymentIntentRoute}). Anything else is
 * a payment the app did not create.
 */
export function isAppCreatedPaymentIntent(
  metadata: Readonly<Record<string, string | undefined>> | null | undefined,
): boolean {
  return appPaymentIntentRoute(metadata) !== null;
}
