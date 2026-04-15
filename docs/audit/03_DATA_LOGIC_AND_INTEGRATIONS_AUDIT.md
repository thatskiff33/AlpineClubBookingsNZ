# Phase 3: Data, Logic, And Integrations Audit

## Goal

Prove that the repo is financially, transactionally, and operationally correct for live bookings.

## Scope

- Prisma schema, indexes, relations, and migrations
- Query patterns, transaction boundaries, and concurrency risks
- Booking, capacity, waitlist, bumping, pricing, promo, and cancellation logic
- Member subscriptions, credits, and refund behavior
- Stripe, Xero, email, and webhook side effects

## Steps

1. Audit the data model.
   - Verify uniqueness, cascade behavior, enum alignment, field sizing, and migration safety.
   - Look for missing indexes or high-risk nullable relationships.
2. Audit query and transaction behavior.
   - Check transaction usage, locking, race windows, and cross-request correctness.
   - Check for N+1 patterns or unbounded selects in high-volume paths.
3. Walk the critical business flows.
   - Booking create/quote/confirm/cancel
   - Pending non-member holds and bumping
   - Waitlist offer and confirmation paths
   - Promo and account-credit interactions
   - Membership/subscription enforcement
4. Audit financial and external side effects.
   - Stripe intent handling, refunds, webhook idempotency
   - Xero sync, contact matching, invoice/credit-note behavior, daily usage guards
   - Email delivery behavior, retry/failure handling, preference gating
5. Identify proof gaps.
   - Call out flows that need real external-system verification rather than code-only confidence.

## Suggested Lanes

- Lane A: schema, migrations, Prisma patterns, query performance
- Lane B: booking, pricing, promo, waitlist, bumping, cancellation, credits
- Lane C: Stripe, Xero, email, and webhook side effects

## Required Outputs

- Data-integrity and financial-risk findings
- List of concurrency-sensitive code paths
- External verification gaps that block go-live confidence
- Candidate regression tests for every corrected flow

## Exit Criteria

- Critical booking and payment flows have been traced end to end
- Financial side effects are verified in code or flagged as external proof gaps
- Concurrency risks are either fixed, test-covered, or explicitly deferred
- No unresolved data-corruption risk remains unclassified

## Validation Expectations

- Prefer targeted `vitest` runs for touched flows first
- Re-run broader booking/payment suites after any financial fix
