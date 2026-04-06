## Phase 3: Booking & Payment Flow Fixes

**Priority:** High — must complete before UAT
**Depends on:** None
**Reference:** [docs/CODEBASE_REVIEW_2026-04-07.md](../CODEBASE_REVIEW_2026-04-07.md)

### Issues Addressed

| ID | Severity | Description |
|----|----------|-------------|
| H1 | High | Stripe webhook doesn't validate payment amount matches booking price |
| H15 | High | `calculateBookingRefund()` only checks CONFIRMED, not PAID status |
| M1 | Medium | Webhook idempotency check not atomic — duplicate processing possible |
| M4 | Medium | No max guest count on booking creation schema |

### Checklist

- [ ] **H1** — Fix `src/app/api/webhooks/stripe/route.ts:174`:
  - After finding the payment record, compare `paymentIntent.amount` against `payment.amountCents`
  - If mismatch, log a warning with both amounts but still process (Stripe is authoritative for amount received)
  - Add the mismatch flag to the payment update for audit trail
- [ ] **H15** — Fix `src/lib/cancellation.ts:147`:
  - Change `booking.status === "CONFIRMED"` to include PAID: `["CONFIRMED", "PAID"].includes(booking.status)`
  - Ensure change fee exclusion logic matches `cancelBooking()` implementation
- [ ] **M1** — Fix `src/app/api/webhooks/stripe/route.ts:51-57`:
  - Replace findUnique + create with an atomic upsert or try-catch on create with unique constraint:
    ```typescript
    try {
      await prisma.processedWebhookEvent.create({ data: { eventId: event.id } });
    } catch (e) {
      // Unique constraint violation = already processed
      return NextResponse.json({ received: true });
    }
    ```
- [ ] **M4** — Fix `src/app/api/bookings/route.ts:39`:
  - Add `.max(29)` to guests array: `guests: z.array(guestSchema).min(1).max(29)`
- [ ] Add tests for webhook amount validation and refund status check
- [ ] Run full test suite: `npm test`
- [ ] Run build: `npm run build`

### Agent Prompt

```
Fix 4 booking and payment flow issues from the codebase review (docs/CODEBASE_REVIEW_2026-04-07.md, Phase 3).

1. src/app/api/webhooks/stripe/route.ts:174 — After finding the payment record for a
   payment_intent.succeeded event, add a check: if paymentIntent.amount !== payment.amountCents,
   log a warning with both amounts. Still process the webhook (Stripe amount is authoritative)
   but record the mismatch.

2. src/lib/cancellation.ts:147 — The calculateBookingRefund() function only checks
   booking.status === "CONFIRMED". Change to also accept "PAID":
   if (!["CONFIRMED", "PAID"].includes(booking.status)) return null;
   Also ensure the change fee exclusion from cancelBooking() is applied here too.

3. src/app/api/webhooks/stripe/route.ts:51-57 — Replace the non-atomic idempotency check
   (findUnique then create) with a try-catch on create that catches unique constraint
   violations (P2002). This prevents duplicate webhook processing from concurrent deliveries.

4. src/app/api/bookings/route.ts:39 — Add .max(29) to the guests array in
   createBookingSchema: guests: z.array(guestSchema).min(1).max(29)

Write tests for the webhook amount validation and the refund status check fix.
After all changes: npm test && npm run build. Commit on branch: fix/phase-3-booking-payment
```
