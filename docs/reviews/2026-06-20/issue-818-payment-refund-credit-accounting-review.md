# Issue #818: Payment, Refund, Credit, and Accounting Consistency Review

## Issue

Review integer-cents handling, Stripe versus Internet Banking/Xero path separation, double payment, double refund, account credit ledger, Xero invoice/credit-note consistency, and admin/finance recovery.

## Scope reviewed

- Static review of payment, refund, payment recovery, member credit, booking modification, and finance/accounting consistency paths.
- No live Stripe/Xero calls, production credentials, production data, app-code edits, or broad tests were run.

## Files/directories inspected

- `src/lib/payment-recovery.ts`
- `src/lib/payment-transactions.ts`
- `src/lib/stripe-webhook-service.ts`
- `src/lib/booking-modification-settlement.ts`
- `src/lib/booking-guest-removal-service.ts`
- `src/lib/member-credit.ts`
- `src/lib/cron-credit-reconciliation.ts`
- `src/app/api/admin/refund-requests/[id]/route.ts`
- `src/app/api/bookings/[id]/guests/[guestId]/route.ts`
- `src/app/(admin)/admin/payments/page.tsx`
- `src/app/(finance)/finance/page.tsx`
- `prisma/schema.prisma`

## Main observations

- Money values in reviewed schema and code are integer cents.
- Stripe and Internet Banking/Xero payment paths are represented separately in payment source fields and UI filters.
- Stripe refund ledger updates are bounded against over-refund and use unique provider refund IDs.
- Payment recovery operations provide durable retry for several newer cancellation/modification/payment-failure flows.
- Member credit creation has idempotency for booking modification credit and records source details.
- Finance pages use synced finance snapshots, while admin payment pages expose operational payment/Xero state.

## Top risks to verify

- Refund request approval calls Stripe refund work before atomically claiming the pending refund request. Concurrent approvals or partial failures may create double-refund or local-state mismatch risk.
- Guest removal refund failure logs that manual reconciliation is required but did not appear to enqueue a durable `PaymentRecoveryOperation`.
- Capacity-failed auto-refund and late-captured-cancelled-booking flows need verification that every external refund failure has durable recovery, not only admin alerting.
- Credit reconciliation appears mostly local, with limited Xero credit-note amount/link reconciliation. Verify local member credit and Xero credit-note totals cannot drift unnoticed.
- Best-effort Xero credit-note queueing after successful refund needs failure visibility and replay coverage.

## Likely follow-up issues

- Move refund request approval to a claim-first or durable-recovery pattern before external refund calls.
- Add payment recovery operations for legacy guest-removal refund failures.
- Add tests for every refund-producing path proving idempotency, over-refund prevention, local ledger update, and Xero credit-note queueing.
- Expand credit reconciliation to compare local credit ledger, Xero object links, and Xero credit-note amounts where possible.
- Add admin visibility for external refund succeeded but local/accounting follow-up failed.

## Recommended tests/static checks

- Concurrent refund-approval test for the same refund request.
- Tests for guest removal refund failure and recovery queue behavior.
- Stripe webhook replay tests for duplicate payment/refund events.
- Credit ledger aggregate tests with multiple credits, partial spends, and reversals.
- Static check that new refund paths either use `PaymentRecoveryOperation` or document an equivalent durable recovery path.

## Sensitive findings requiring private handling, if any

- Keep exact refund sequencing and double-processing reproduction details private until fixed.
- Do not publish provider IDs, payment method details, or financial examples from real data.

## Uncertainty/to-verify list

- To verify: whether database isolation or route-level authorization elsewhere prevents refund-approval races.
- To verify: whether admin operators have a reliable report for local-refunded/provider-refunded/Xero-credit-note divergence.
- To verify: whether all failed payment recovery operations are counted in health dashboards, not only stale pending work.
- To verify: whether Internet Banking/Xero settlement paths have end-to-end stale invoice reconciliation tests.

## Validation notes

- Static review only.
- No payment provider calls, production data, or app-code edits were performed.
