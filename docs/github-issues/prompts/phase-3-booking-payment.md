# Phase 3: Booking & Payment Flow Fixes

You are fixing 4 booking and payment issues in a Next.js + Stripe booking system. Make each change exactly as described, then run tests and build.

## Setup

```
git checkout -b fix/phase-3-booking-payment
```

## Change 1 of 4: Add Stripe webhook amount validation

Read `src/app/api/webhooks/stripe/route.ts` lines 155-184 (the `handlePaymentIntentSucceeded` function). Find the section that updates the payment record, around line 165:

```typescript
    prisma.payment.update({
      where: { bookingId },
      data: {
        stripePaymentIntentId: paymentIntent.id,
        stripePaymentMethodId:
          typeof paymentIntent.payment_method === "string"
            ? paymentIntent.payment_method
            : paymentIntent.payment_method?.id ?? null,
        status: "SUCCEEDED",
        amountCents: paymentIntent.amount,
      },
    }),
```

Before this `Promise.all` block (around line 160), add an amount mismatch warning. First find the payment record lookup — there should be a query that finds the payment by bookingId. After that query, add:

```typescript
  // Validate webhook amount matches expected booking amount
  if (payment && payment.amountCents !== paymentIntent.amount) {
    logger.warn(
      {
        bookingId,
        expectedCents: payment.amountCents,
        receivedCents: paymentIntent.amount,
        paymentIntentId: paymentIntent.id,
      },
      "Stripe webhook amount mismatch - using Stripe amount as authoritative"
    );
  }
```

Read the full function to find exactly where the payment record is fetched and add the check right after it.

## Change 2 of 4: Fix cancellation refund to accept PAID status

Read `src/lib/cancellation.ts` lines 146-151. You will see:

```typescript
  if (
    booking.status !== "CONFIRMED" ||
    booking.payment.status !== "SUCCEEDED"
  ) {
    return null;
  }
```

Change to also accept PAID bookings:

```typescript
  if (
    !["CONFIRMED", "PAID"].includes(booking.status) ||
    booking.payment.status !== "SUCCEEDED"
  ) {
    return null;
  }
```

Now check the `cancelBooking()` function in `src/lib/booking-cancel.ts`. Read it and verify it also handles PAID status. If it already does, no change needed there. The point is `calculateBookingRefund` should be consistent with `cancelBooking`.

## Change 3 of 4: Fix webhook idempotency to be atomic

Read `src/app/api/webhooks/stripe/route.ts` lines 50-57. You will see:

```typescript
    // Idempotency check: skip already-processed events
    const existing = await prisma.processedWebhookEvent.findUnique({
      where: { eventId: event.id },
    });
    if (existing) {
      return NextResponse.json({ received: true });
    }
```

Replace this non-atomic check with an atomic try-create approach:

```typescript
    // Idempotency: attempt to claim this event atomically
    try {
      await prisma.processedWebhookEvent.create({
        data: { eventId: event.id },
      });
    } catch (err: unknown) {
      // Unique constraint violation (P2002) = already processed
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "P2002"
      ) {
        return NextResponse.json({ received: true });
      }
      throw err; // Re-throw unexpected errors
    }
```

Then find where the `processedWebhookEvent.create` was previously called AFTER event processing (search for `processedWebhookEvent.create` later in the file) and REMOVE it, since we now create it at the start. Read the full POST handler to find this — it's likely near the end of the try block.

## Change 4 of 4: Add max guest count

Read `src/app/api/bookings/route.ts` line 39. You will see:

```typescript
    .min(1),
```

Change to:

```typescript
    .min(1)
    .max(29),
```

This is the guests array inside `createBookingSchema`. 29 is the lodge bed capacity.

## Verify

```bash
npm test
npm run build
```

All 948 tests must pass. If tests fail related to the webhook idempotency change, check if any test was creating the processedWebhookEvent record manually — it may need updating.

## Commit

```bash
git add -A
git commit -m "Booking/payment fixes: webhook validation, refund status, idempotency, guest limit

- H1: Add amount mismatch warning in Stripe webhook handler
- H15: Fix calculateBookingRefund to accept PAID booking status
- M1: Make webhook idempotency atomic via try-create with P2002 catch
- M4: Add .max(29) to guests array in booking creation schema"
```
