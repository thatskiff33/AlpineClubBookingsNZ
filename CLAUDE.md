@AGENTS.md

## Phase 4: Stripe Payments - COMPLETED

### What was built

**Stripe library** (`src/lib/stripe.ts`):
- PaymentIntent creation for immediate charges (confirmed bookings)
- SetupIntent creation for deferred charges (pending non-member bookings)
- Off-session charging of saved payment methods (for cron auto-confirmation)
- Customer find-or-create logic
- Refund processing
- Webhook signature verification
- Lazy-initialized Stripe client (test-friendly)

**Cancellation engine** (`src/lib/cancellation.ts`):
- Policy-based refund calculation (configurable rules: days before stay → refund %)
- Days-until-date calculator
- Database-backed policy loading
- Full booking refund orchestration

**API routes**:
- `POST /api/payments/create-payment-intent` - Creates Stripe PaymentIntent for immediate charge
- `POST /api/payments/create-setup-intent` - Creates Stripe SetupIntent for saving card
- `POST /api/payments/charge-saved-method` - Charges saved PaymentMethod (cron/admin use, secured by CRON_SECRET)
- `POST /api/bookings/cancel` - Cancels booking with policy-based Stripe refund

**Stripe webhook handler** (`src/app/api/webhooks/stripe/route.ts`):
- `payment_intent.succeeded` → confirms booking, updates payment status
- `payment_intent.payment_failed` → marks payment failed
- `setup_intent.succeeded` → saves payment method for later charging
- `setup_intent.setup_failed` → logs failure
- `charge.refunded` → updates refund amounts, marks REFUNDED/PARTIALLY_REFUNDED
- Signature verification on all events

**Client components** (`src/components/stripe/`):
- `StripeProvider` - Elements context wrapper with appearance config
- `PaymentForm` - Stripe PaymentElement for immediate payments
- `SetupForm` - Stripe PaymentElement for saving card without charging
- `BookingPaymentWrapper` - Auto-selects PaymentForm vs SetupForm based on booking type
- `CancelBookingButton` - Cancellation with confirmation dialog

**Zod schemas** (`src/types/payments.ts`):
- Input validation for all payment API routes

**Full Prisma schema** (`prisma/schema.prisma`):
- All entities from the build plan with proper indexes and relations

### Tests (35 passing)
- Cancellation policy engine: 20 tests (refund calculation, edge cases, rounding, unsorted rules)
- Stripe library: 11 tests (all functions with mocked Stripe SDK)
- Webhook handler logic: 4 tests (payment succeeded, refund handling, setup intent)

### How to run
```bash
npm install
npm test           # Run all 35 tests
npm run build      # Build Next.js app (requires env vars)
```

### Integration points (TODOs for other phases)
- Auth guard on API routes (Phase 1 - marked with TODO comments)
- Email notifications on payment events (Phase 1)
- Xero invoice creation on confirmed payment (Phase 6)
- Xero credit note on refund (Phase 6)

### Key decisions
- Stripe client is lazy-initialized via Proxy to avoid throwing at import time during tests
- All prices in integer cents (NZD)
- PaymentIntent for immediate charges, SetupIntent for deferred (non-member bookings)
- Webhook handler is idempotent - safe for duplicate event delivery
- Cancellation policy loaded from CancellationPolicy table (admin-configurable)
