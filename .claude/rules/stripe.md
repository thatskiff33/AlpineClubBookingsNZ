## Stripe Rules (applies to src/lib/stripe*)

- Always verify Stripe webhook signatures before processing
- Use PaymentIntents for confirmed bookings, SetupIntents for pending
- Store all Stripe IDs for reconciliation
- Handle idempotency - webhooks may fire multiple times
- Never expose Stripe secret key client-side (use NEXT_PUBLIC_ prefix only for publishable key)
- PaymentIntent amounts must be set server-side from database - never trust client
- All money values in cents (integer) matching Stripe's smallest currency unit
