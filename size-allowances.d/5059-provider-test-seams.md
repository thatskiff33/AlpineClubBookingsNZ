# File-size allowance for #5059 (provider test seams, #4908)

The seam's state and its NODE_ENV guard live in their own module,
`src/lib/xero-test-client-override.ts`, so only the read itself lands here.
The Stripe seam was moved out the same way (`src/lib/stripe-test-client-override.ts`)
and `src/lib/stripe.ts` stays at its 700-line budget.

file: src/lib/xero-api-client.ts
lines: 793
reason: four lines: the import and the override read inside
  `getAuthenticatedXeroClient`, after the daily-limit latch and before the
  token load. The issue requires the test session to pass through that latch,
  `callXeroApi` and `withXeroRetry` so the real error classes still come from
  the production path, so the read has to sit in this function; moving it to a
  wrapper would give tests a different entry point from the app's callers.
